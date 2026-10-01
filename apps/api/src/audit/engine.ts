import { load } from 'cheerio';
import type { Lead, WebsiteAudit, WebsiteResolution, ScoringConfig, AuditCheck } from '@igetjobs/shared';
import { RequestError } from '../discovery/errors.js';
import { websiteUrl } from '../discovery/normalize.js';
import { resolveWebsiteEvidence } from '../website-safety.js';
import { fetchWebsite, WebsiteFetchError, type WebsiteFetchResult } from './fetcher.js';
import { evaluateLead, defaultScoring } from './policy.js';

export function chooseWebsite(resolution: WebsiteResolution, selected?: unknown): string | null {
  if (selected !== undefined) {
    const url = websiteUrl(selected);
    if (!url || !resolution.candidates.includes(url)) throw new RequestError(400, 'Choose a website from the preserved evidence.');
    return url;
  }
  if (resolution.requiresChoice) throw new RequestError(409, 'Website evidence needs review. Choose a valid candidate explicitly before auditing.');
  return resolution.candidates[0] || null;
}

export function inspectHtml(result: WebsiteFetchResult, config: ScoringConfig): AuditCheck[] {
  const $ = load(result.body);
  $('script,style,noscript,template,[hidden],[aria-hidden="true"]').remove();
  $('[style]').each((_index, node) => { if (/(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)(?:\s*!important)?\s*(?:;|$)/i.test($(node).attr('style') || '')) $(node).remove(); });
  // Keep inline/style evidence separate: external CSS/JS is never downloaded.
  const original = load(result.body);
  const viewport = original('meta').toArray().filter(node => original(node).attr('name')?.toLowerCase() === 'viewport').map(node => original(node).attr('content') || '').join(';');
  const goodViewport = /(?:^|[,;\s])width\s*=\s*device-width(?:[,;\s]|$)/i.test(viewport);
  const styleEvidence = original('[style]').toArray().map(node => original(node).attr('style')).join(';') + original('style').text();
  const fixedWidths = [...styleEvidence.matchAll(/(?:^|[;{\s])min-width\s*:\s*(\d+)px/gi)].map(match => Number(match[1])).filter(width => width > 480);
  const visibleText = $('body').text().replace(/\s+/g, ' ').trim();
  const anchors = $('a[href]').toArray();
  const contact = anchors.some(node => /^(?:mailto:|tel:)/i.test($(node).attr('href') || '')) || /[^\s@]+@[^\s@]+\.[a-z]{2,}/i.test(visibleText) || /\+?\d[\d ()-]{7,}\d/.test(visibleText);
  const ctas = $('a[href],button,input[type="submit"]').toArray().filter(node => /\b(?:contact|book|call|appointment|quote|enquir(?:e|y)|inquir(?:e|y)|reserve|consult|schedule|get started)\b/i.test($(node).text() || $(node).attr('value') || ''));
  const structure = Boolean(original('title').text().trim()) && $('h1').length > 0 && visibleText.length >= 100;
  const ids = new Set($('[id],a[name]').toArray().flatMap(node => [$(node).attr('id'), $(node).attr('name')].filter((value): value is string => Boolean(value))));
  let brokenFragments = 0;
  for (const node of anchors) {
    const href = $(node).attr('href')!.trim();
    if (href.startsWith('#') && href.length > 1) { try { if (!ids.has(decodeURIComponent(href.slice(1)))) brokenFragments++; } catch { brokenFragments++; } }
  }
  const check = (key: string, label: string, pass: boolean, evidence: string): AuditCheck => ({ key, label, outcome: pass ? 'pass' : 'fail', evidence });
  return [
    check('https', 'HTTPS response', result.url.startsWith('https:'), `Final response used ${new URL(result.url).protocol.replace(':', '').toUpperCase()}.`),
    check('viewport', 'Mobile viewport declaration', goodViewport, goodViewport ? 'width=device-width meta detected.' : 'No width=device-width meta detected in fetched HTML.'),
    { key: 'mobile_width', label: 'Inline mobile width indicators', outcome: fixedWidths.length ? 'fail' : 'unknown', evidence: fixedWidths.length ? `${fixedWidths.length} inline/style min-width declarations exceed 480px; rendered impact not verified.` : 'No measured fixed minimum-width issue; external CSS and rendered layout were not tested.' },
    check('performance', 'Bounded response time', result.durationMs <= config.slowMs, `${result.durationMs}ms for DNS/connection/redirects/body; threshold ${config.slowMs}ms. Not browser performance.`),
    check('page_size', 'HTML response size', result.bytes <= config.largeBytes, `${result.bytes} bytes of HTML; threshold ${config.largeBytes}. Assets excluded.`),
    check('contact', 'Contact indicators in fetched HTML', contact, contact ? 'Email/telephone link or visible-text pattern detected; not verified contactability.' : 'No email/telephone indicators detected in fetched HTML.'),
    check('cta', 'CTA text indicators', ctas.length > 0, `${ctas.length} contact/booking/quote action labels detected in fetched HTML; click behavior not tested.`),
    check('structure', 'Basic document structure', structure, `Non-empty title: ${Boolean(original('title').text().trim())}; h1 count: ${$('h1').length}; text length: ${visibleText.length}.`),
    { key: 'links', label: 'Local fragment link targets', outcome: brokenFragments ? 'fail' : anchors.length ? 'pass' : 'unknown', evidence: `${brokenFragments} missing/malformed in-page targets. Other links were not fetched or verified.` },
    { key: 'rendered_mobile', label: 'Rendered mobile usability', outcome: 'unknown', evidence: 'No browser rendering, external assets, or scripts executed; static indicators only.' }
  ];
}

export async function auditLead(lead: Lead, selected: unknown = undefined, config = defaultScoring, fetcher: typeof fetchWebsite = fetchWebsite, now = () => new Date().toISOString()) {
  const resolution = resolveWebsiteEvidence(lead);
  const website = chooseWebsite(resolution, selected);
  const checks: AuditCheck[] = [{ key: 'website_present', label: 'Website evidence present', outcome: website ? 'pass' : 'fail', evidence: website ? `Selected from ${resolution.evidence.length} preserved evidence entries.` : 'Canonical and all supported linked website fields checked; none available.' }];
  let result: WebsiteFetchResult | null = null;
  let state: WebsiteAudit['state'] = website ? 'reachable' : 'missing';
  if (website) {
    try {
      result = await fetcher(website);
      if ([401, 403, 429].includes(result.status)) throw new RequestError(422, `Website returned HTTP ${result.status}; access restrictions prevent a reliable quality audit. No score was changed.`);
      const reached = result.status >= 200 && result.status < 300;
      checks.push({ key: 'reachable', label: 'Website reachable', outcome: reached ? 'pass' : 'fail', evidence: `Audit request returned HTTP ${result.status}.` });
      if (reached) {
        const contentType = result.headers['content-type'] || '';
        if (!/^(?:text\/html|application\/xhtml\+xml)(?:;|$)/i.test(contentType)) throw new RequestError(422, 'Website did not return supported HTML; quality remains unverified. No score was changed.');
        checks.push(...inspectHtml(result, config));
      } else state = 'unreachable';
    } catch (error) {
      if (error instanceof RequestError) throw error;
      if (!(error instanceof WebsiteFetchError)) throw new RequestError(503, 'Website audit could not complete. Please try again.');
      if (!['network', 'timeout', 'dns'].includes(error.kind)) throw new RequestError(422, error.message + ' No classification or score was changed.');
      state = 'unreachable';
      checks.push({ key: 'reachable', label: 'Website reachable', outcome: 'fail', evidence: error.message });
    }
    if (state === 'unreachable') for (const key of ['https', 'viewport', 'mobile_width', 'performance', 'page_size', 'contact', 'cta', 'structure', 'links']) checks.push({ key, label: key.replace(/_/g, ' '), outcome: 'unknown', evidence: 'Page quality could not be measured because the request failed.' });
  }
  const scored = evaluateLead(lead, checks, config);
  const audit: WebsiteAudit = {
    version: 'static-v1', auditedAt: now(), website: result?.url || website, requestedWebsite: website, state, checks,
    evidence: resolution.evidence, classificationReasons: scored.classificationReasons, scoring: structuredClone(config),
    metrics: { status: result?.status ?? null, durationMs: result?.durationMs ?? null, bytes: result?.bytes ?? null, redirects: result?.redirects ?? null }
  };
  return { audit, classification: scored.classification, score: scored.score, scoreReasons: scored.scoreReasons };
}
