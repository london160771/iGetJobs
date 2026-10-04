import { inspectHtmlIsolated } from './html.js';
import type { Lead, WebsiteAudit, WebsiteResolution, AuditCheck } from '@igetjobs/shared';
import { RequestError } from '../discovery/errors.js';
import { websiteUrl } from '../discovery/normalize.js';
import { resolveWebsiteEvidence } from '../website-safety.js';
import { fetchWebsite, fetchLimits, WebsiteFetchError, type WebsiteFetchResult } from './fetcher.js';
import { evaluateLead, defaultScoring } from './policy.js';
import { AuditManualReviewError } from './manual-review.js';

export function chooseWebsite(resolution: WebsiteResolution, selected?: unknown): string | null {
  if (selected !== undefined) {
    const url = websiteUrl(selected);
    if (!url || !resolution.candidates.includes(url)) throw new RequestError(400, 'Choose a website from the preserved evidence.');
    return url;
  }
  if (resolution.requiresChoice) throw new RequestError(409, 'Website evidence needs review. Choose a valid candidate explicitly before auditing.');
  return resolution.candidates[0] || null;
}

export async function auditLead(lead: Lead, selected: unknown = undefined, config = defaultScoring, fetcher: typeof fetchWebsite = fetchWebsite, now = () => new Date().toISOString()) {
  const resolution = resolveWebsiteEvidence(lead);
  const website = chooseWebsite(resolution, selected);
  const checks: AuditCheck[] = [{ key: 'website_present', label: 'Website evidence present', outcome: website ? 'pass' : 'fail', evidence: website ? `Selected from ${resolution.evidence.length} preserved evidence entries.` : 'Canonical and all supported linked website fields checked; none available.' }];
  let result: WebsiteFetchResult | null = null;
  let state: WebsiteAudit['state'] = website ? 'reachable' : 'missing';
  let failure: WebsiteAudit['failure'];
  if (website) {
    try {
      result = await fetcher(website);
      if ([401, 403, 429].includes(result.status)) throw new AuditManualReviewError('ACCESS_RESTRICTED', `The website restricted inspection (HTTP ${result.status}); quality remains unverified.`, { httpStatus: result.status });
      const reached = result.status >= 200 && result.status < 300;
      checks.push({ key: 'reachable', label: 'Website reachable', outcome: reached ? 'pass' : 'fail', evidence: `Audit request returned HTTP ${result.status}.` });
      if (reached) {
        const contentType = result.headers['content-type'] || '';
        if (!/^(?:text\/html|application\/xhtml\+xml)(?:;|$)/i.test(contentType)) throw new AuditManualReviewError('UNSUPPORTED_CONTENT', 'The website response did not contain supported HTML; quality remains unverified.', { httpStatus: result.status });
        checks.push(...await inspectHtmlIsolated(result, config));
      } else { state = 'unreachable'; failure = 'http'; }
    } catch (error) {
      if (error instanceof RequestError) throw error;
      if (error instanceof AuditManualReviewError) throw error;
      if (!(error instanceof WebsiteFetchError)) throw new RequestError(503, 'Website audit could not complete. Please try again.');
      if (error.kind !== 'network' && error.kind !== 'timeout' && error.kind !== 'dns') {
        const reason = error.kind === 'too_large' ? 'HTML_TOO_LARGE' : error.kind === 'encoding' ? 'UNSUPPORTED_CONTENT' : 'OTHER_UNVERIFIED';
        const detail = error.kind === 'too_large' ? { ...(error.measuredBytes === null ? {} : { measuredHtmlBytes: error.measuredBytes }), htmlByteLimit: fetchLimits.bytes, stage: 'fetch' as const } : null;
        throw new AuditManualReviewError(reason, error.message + ' Quality remains unverified.', detail);
      }
      state = 'unreachable';
      failure = error.kind;
      checks.push({ key: 'reachable', label: 'Website reachable', outcome: 'fail', evidence: error.message });
    }
    if (state === 'unreachable') for (const key of ['https', 'viewport', 'mobile_width', 'performance', 'page_size', 'contact', 'cta', 'structure', 'links']) checks.push({ key, label: key.replace(/_/g, ' '), outcome: 'unknown', evidence: 'Page quality could not be measured because the request failed.' });
  }
  const scored = evaluateLead(lead, checks, config);
  const audit: WebsiteAudit = {
    version: 'static-v1.1', auditedAt: now(), website: result?.url || website, requestedWebsite: website, state, checks,
    ...(failure ? { failure } : {}),
    evidence: resolution.evidence, classificationReasons: scored.classificationReasons, scoring: structuredClone(config),
    metrics: { status: result?.status ?? null, durationMs: result?.durationMs ?? null, bytes: result?.bytes ?? null, redirects: result?.redirects ?? null }
  };
  return { audit, classification: scored.classification, score: scored.score, scoreReasons: scored.scoreReasons,
    auditAttemptStatus: 'COMPLETED' as const, auditAttemptReason: null, auditAttemptedAt: audit.auditedAt, auditAttemptDetail: null };
}
