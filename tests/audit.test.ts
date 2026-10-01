import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AuditCheck, Lead } from '@igetjobs/shared';
import { leadPriority } from '@igetjobs/shared';
import { normalizeLead } from '../apps/api/src/discovery/normalize.js';
import { RequestError } from '../apps/api/src/discovery/errors.js';
import { leadToRow, SupabaseLeadRepository } from '../apps/api/src/discovery/repository.js';
import { resolveWebsiteEvidence } from '../apps/api/src/website-safety.js';
import { auditLead } from '../apps/api/src/audit/engine.js';
import { defaultScoring, evaluateLead, readScoring } from '../apps/api/src/audit/policy.js';
import { fetchLimits, fetchWebsite, pinnedRequestOptions, readWebsiteResponse, WebsiteFetchError, type WebsiteFetchResult, type WebsiteResponse } from '../apps/api/src/audit/fetcher.js';
import { AuditService, SupabaseAuditRepository, type AuditRepository } from '../apps/api/src/audit/service.js';

const goodHtml = '<!doctype html><html><head><title>Dental clinic</title><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><h1>Our dental clinic</h1><p>' + 'Our local team welcomes patients and offers useful information about appointments. '.repeat(3) + '</p><a href="mailto:info@clinic.com">Contact us</a><a href="#services">Our services</a><section id="services">Services</section></body></html>';
const lead = (website?: string): Lead => normalizeLead({ businessName: 'Dental clinic', website, sourceId: 'row-1', metadata: {} }, 'CSV').lead;
const result = (body = goodHtml, url = 'https://clinic.com/'): WebsiteFetchResult => ({ url, body, status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, bytes: Buffer.byteLength(body), durationMs: 100, redirects: 0 });
const fixedTime = () => '2026-10-01T12:00:00.000Z';
const publicResolver = async () => [{ address: '93.184.216.34', family: 4 }];
const response = (status: number, location?: string): WebsiteResponse => ({ status, headers: location ? { location } : { 'content-type': 'text/html' }, body: '', bytes: 0 });
const blocked = (error: unknown) => error instanceof WebsiteFetchError && error.kind === 'blocked';

test('NO_WEBSITE checks all source evidence without fetching; source contacts alone never imply a website', async () => {
  const original = lead(); original.phone = '+441234567890';
  const audited = await auditLead(original, undefined, defaultScoring, async () => { throw new Error('Must not fetch'); }, fixedTime);
  assert.equal(audited.classification, 'NO_WEBSITE'); assert.equal(audited.audit.state, 'missing');
  assert.equal(audited.score, 75); assert.equal(leadPriority(audited.score), 'High');
  assert.equal(audited.scoreReasons.reduce((sum, item) => sum + item.points, 0), audited.score);
  assert.equal(original.audit, null); assert.deepEqual(audited.audit.evidence, []);
});

test('linked evidence is resolved before NO_WEBSITE and conflicts/invalid values require explicit review', async () => {
  const original = lead();
  original.provenance.push({ source: 'OSM', sourceId: 'node/1', metadata: { tags: { 'contact:website': '//clinic.com/?token=fixture' } } });
  let requested = '';
  const fetcher = async (url: string) => { requested = url; return result(); };
  assert.equal((await auditLead(original, undefined, defaultScoring, fetcher)).classification, 'ACCEPTABLE_WEBSITE');
  assert.equal(requested, 'https://clinic.com/'); assert.equal(original.website, null);
  original.provenance.push({ source: 'SERPAPI', sourceId: 'place', metadata: { website: 'https://other.com/' } });
  await assert.rejects(auditLead(original, undefined, defaultScoring, fetcher), error => error instanceof RequestError && error.status === 409);
  await assert.rejects(auditLead(original, 'https://unrelated.com/'), error => error instanceof RequestError && error.status === 400);
  const selected = await auditLead(original, 'https://other.com/', defaultScoring, async url => result(goodHtml, url));
  assert.equal(selected.audit.requestedWebsite, 'https://other.com/'); assert.equal(selected.audit.evidence?.length, 2);
  original.provenance.push({ source: 'CSV', sourceId: 'bad', metadata: { fields: { website: 'bad host' } } });
  assert.equal(resolveWebsiteEvidence(original).invalidCount, 1);
  assert.ok(!JSON.stringify(selected).includes('fixture'));
  const invalidOnly = lead(); invalidOnly.provenance[0]!.metadata = { fields: { website: 'bad host' } };
  await assert.rejects(auditLead(invalidOnly), error => error instanceof RequestError && error.status === 409);
  const discarded = normalizeLead({ businessName: 'Discarded URL', website: '//bad host/?api_key=fixture', sourceId: 'bad-url', metadata: { fields: { website: '//bad host/?api_key=fixture' } } }, 'CSV').lead;
  assert.equal(discarded.provenance[0]?.metadata?.websiteEvidenceInvalid, true); assert.equal(JSON.stringify(discarded).includes('fixture'), false);
  assert.equal(resolveWebsiteEvidence(discarded).invalidCount, 1);
  await assert.rejects(auditLead(discarded), error => error instanceof RequestError && error.status === 409);
});

test('unreachable website is POOR with only observed reachability and no invented page-quality failures', async () => {
  for (const kind of ['network', 'timeout', 'dns'] as const) {
    const audited = await auditLead(lead('clinic.com'), undefined, defaultScoring, async () => { throw new WebsiteFetchError(kind, 'Website request failed.'); });
    assert.equal(audited.classification, 'POOR_WEBSITE'); assert.equal(audited.audit.state, 'unreachable');
    assert.equal(audited.score, 55); assert.equal(audited.audit.metrics?.status, null);
    assert.ok(audited.audit.checks.filter(check => check.key !== 'website_present' && check.key !== 'reachable').every(check => check.outcome === 'unknown'));
    assert.deepEqual(audited.scoreReasons.map(reason => reason.key), ['unreachable', 'source_identity']);
  }
  const httpFailure = await auditLead(lead('clinic.com'), undefined, defaultScoring, async () => ({ ...result(), status: 500 }));
  assert.equal(httpFailure.audit.metrics?.status, 500); assert.equal(httpFailure.classification, 'POOR_WEBSITE');
});

test('acceptable and poor HTML have deterministic checks, classification and measured scoring math', async () => {
  const original = lead('clinic.com');
  const good = await auditLead(original, undefined, defaultScoring, async () => result(), fixedTime);
  assert.equal(good.classification, 'ACCEPTABLE_WEBSITE'); assert.equal(good.score, 5);
  assert.equal(good.audit.checks.find(check => check.key === 'rendered_mobile')?.outcome, 'unknown');
  assert.deepEqual(good, await auditLead(original, undefined, defaultScoring, async () => result(), fixedTime));
  const poorHtml = '<html><head><style>body { min-width: 900px; }</style></head><body><a href="#missing">Services</a></body></html>';
  const poor = await auditLead(original, undefined, defaultScoring, async () => ({ ...result(poorHtml, 'http://clinic.com/'), durationMs: 4000, bytes: 600000 }), fixedTime);
  assert.equal(poor.classification, 'POOR_WEBSITE'); assert.equal(poor.score, 57);
  assert.equal(poor.scoreReasons.reduce((sum, item) => sum + item.points, 0), poor.score);
  assert.ok(poor.audit.checks.some(check => check.key === 'links' && check.outcome === 'fail'));
});

test('hidden/script contact and CTA indicators do not count as visible HTML evidence', async () => {
  const html = '<script>info@clinic.com</script><div hidden><a href="mailto:hidden@clinic.com">Contact</a></div><div style="display:none"><button>Book</button>+441234567890</div><div aria-hidden="true">hidden@clinic.com</div>';
  const audited = await auditLead(lead('clinic.com'), undefined, defaultScoring, async () => result(html));
  assert.equal(audited.audit.checks.find(check => check.key === 'contact')?.outcome, 'fail');
  assert.equal(audited.audit.checks.find(check => check.key === 'cta')?.outcome, 'fail');
});

test('unsafe, restricted, oversized and unsupported pages remain incomplete instead of inventing quality scores', async () => {
  for (const kind of ['blocked', 'too_large', 'encoding', 'redirect'] as const) await assert.rejects(auditLead(lead('clinic.com'), undefined, defaultScoring, async () => { throw new WebsiteFetchError(kind, 'Bounded fetch declined.'); }), error => error instanceof RequestError && error.status === 422);
  for (const status of [401, 403, 429]) await assert.rejects(auditLead(lead('clinic.com'), undefined, defaultScoring, async () => ({ ...result(), status })), error => error instanceof RequestError && error.status === 422);
  await assert.rejects(auditLead(lead('clinic.com'), undefined, defaultScoring, async () => ({ ...result(), headers: { 'content-type': 'application/pdf' } })), error => error instanceof RequestError && error.status === 422);
});

test('classification and priority thresholds are inclusive and scoring caps reconcile with visible reasons', () => {
  const original = lead('clinic.com');
  const checks: AuditCheck[] = [{ key: 'https', label: 'HTTPS', outcome: 'fail', evidence: 'HTTP' }, { key: 'viewport', label: 'Viewport', outcome: 'fail', evidence: 'Missing' }];
  assert.equal(evaluateLead(original, checks, defaultScoring).classification, 'POOR_WEBSITE');
  assert.equal(evaluateLead(original, checks, { ...defaultScoring, poorThreshold: 19 }).classification, 'ACCEPTABLE_WEBSITE');
  assert.equal(evaluateLead(original, [{ ...checks[0]!, outcome: 'unknown' }], defaultScoring).score, 5);
  const config = structuredClone(defaultScoring); config.weights.no_website = 100; config.weights.source_identity = 100;
  const scored = evaluateLead(original, [{ key: 'website_present', label: 'Website', outcome: 'fail', evidence: 'None' }], config);
  assert.equal(scored.score, 100); assert.equal(scored.scoreReasons.reduce((sum, item) => sum + item.points, 0), 100);
  assert.equal(leadPriority(69), 'Medium'); assert.equal(leadPriority(70), 'High'); assert.equal(leadPriority(39), 'Low'); assert.equal(leadPriority(40), 'Medium');
  const noFactors = evaluateLead({ ...original, provenance: [] }, [], defaultScoring); assert.equal(noFactors.score, 0); assert.equal(noFactors.scoreReasons[0]?.points, 0);
  assert.deepEqual(readScoring({ AUDIT_SCORING_JSON: JSON.stringify(config) }), config);
  for (const value of ['secret-marker', JSON.stringify({ ...config, highPriority: 40, mediumPriority: 50 }), JSON.stringify({ ...config, weights: { secret: 1 } }), JSON.stringify({ ...config, token: 'secret-marker' })]) assert.throws(() => readScoring({ AUDIT_SCORING_JSON: value }), error => error instanceof Error && !error.message.includes('secret-marker'));
});

test('fetcher blocks private/internal/metadata destinations without opening a transport', async () => {
  let requests = 0;
  for (const url of ['http://localhost/', 'http://127.1/', 'http://10.0.0.1/', 'http://192.168.1.2/', 'http://169.254.169.254/', 'http://metadata.google.internal/', 'http://router/', 'http://[::1]/', 'http://[fe80::1]/', 'http://[fd00::1]/']) await assert.rejects(fetchWebsite(url, { resolve: publicResolver, transport: async () => { requests++; return response(200); } }), blocked);
  assert.equal(requests, 0);
});

test('each redirect is revalidated, sanitized and repinned; private/userinfo/protocol redirects never connect', async () => {
  for (const location of ['http://127.0.0.1/', '//169.254.169.254/latest/meta-data/', 'http://a.internal/', 'https://user:password@other.com/', 'file:///etc/passwd']) {
    let requests = 0;
    await assert.rejects(fetchWebsite('https://clinic.com/', { resolve: publicResolver, transport: async () => { requests++; return response(302, location); } }), blocked);
    assert.equal(requests, 1);
  }
  const seen: string[] = [], hosts: string[] = [];
  const safe = await fetchWebsite('https://clinic.com/', { resolve: async host => { hosts.push(host); return publicResolver(); }, transport: async destination => { seen.push(destination.url); return seen.length === 1 ? response(302, '//other.com/contact?token=fixture&lang=en') : response(200); } });
  assert.deepEqual(hosts, ['clinic.com', 'other.com']); assert.deepEqual(seen, ['https://clinic.com/', 'https://other.com/contact?lang=en']); assert.equal(safe.redirects, 1);
  let requests = 0;
  await assert.rejects(fetchWebsite('https://clinic.com/', { resolve: publicResolver, transport: async () => { requests++; return response(302, '/again'); } }), error => error instanceof WebsiteFetchError && error.kind === 'redirect');
  assert.equal(requests, fetchLimits.redirects + 1);
});

test('rebinding DNS after validation cannot alter a pinned connection; redirected rebinding is blocked', async () => {
  let resolutions = 0, requests = 0;
  await assert.rejects(fetchWebsite('https://clinic.com/', { resolve: async () => { resolutions++; return resolutions === 1 ? publicResolver() : [{ address: '127.0.0.1', family: 4 }]; }, transport: async destination => {
    requests++; const options = pinnedRequestOptions(destination, new AbortController().signal);
    assert.equal(options.hostname, 'clinic.com'); assert.equal(options.headers.Host, 'clinic.com'); assert.equal(options.servername, 'clinic.com'); assert.equal(options.rejectUnauthorized, true); assert.equal(options.agent, false); assert.equal(options.autoSelectFamily, false);
    for (let i = 0; i < 2; i++) options.lookup('clinic.com', {}, (error, address, family) => { assert.equal(error, null); assert.equal(address, '93.184.216.34'); assert.equal(family, 4); });
    assert.equal(resolutions, 1);
    return response(302, '/next');
  } }), blocked);
  assert.equal(requests, 1); assert.equal(resolutions, 2);
});

test('actual response reader bounds declared/streamed bytes, refuses compression, and never follows redirects', async () => {
  function stream(headers: IncomingMessage['headers'], statusCode = 200) { return Object.assign(new PassThrough(), { headers, statusCode }) as unknown as IncomingMessage & PassThrough; }
  const declared = stream({ 'content-length': String(fetchLimits.bytes + 1) });
  await assert.rejects(readWebsiteResponse(declared), error => error instanceof WebsiteFetchError && error.kind === 'too_large'); assert.equal(declared.destroyed, true);
  const compressed = stream({ 'content-encoding': 'gzip' });
  await assert.rejects(readWebsiteResponse(compressed), error => error instanceof WebsiteFetchError && error.kind === 'encoding');
  const redirect = stream({ location: 'http://127.0.0.1/' }, 302);
  assert.equal((await readWebsiteResponse(redirect)).status, 302); assert.equal(redirect.destroyed, true);
  const oversized = stream({}); const promise = readWebsiteResponse(oversized);
  oversized.write(Buffer.alloc(fetchLimits.bytes + 1));
  await assert.rejects(promise, error => error instanceof WebsiteFetchError && error.kind === 'too_large');
  const bounded = stream({}); const read = readWebsiteResponse(bounded); bounded.end('hello'); assert.equal((await read).bytes, 5);
});

test('audit service rejects foreign leads and field injection, saves only completed audits and throttles retries', async () => {
  const original = lead(); let saves = 0;
  const repository: AuditRepository = { findById: async id => id === original.id ? original : null, saveAudit: async (record, changes) => { saves++; return { ...record, ...changes }; } };
  const service = new AuditService(owner => owner === 'A' ? repository : { ...repository, findById: async () => null }, defaultScoring);
  await assert.rejects(service.detail('B', 'token', original.id), error => error instanceof RequestError && error.status === 404);
  await assert.rejects(service.run('B', 'token', original.id, {}), error => error instanceof RequestError && error.status === 404);
  await assert.rejects(service.run('A', 'token', original.id, { score: 100 }), error => error instanceof RequestError && error.status === 400);
  const audited = await service.run('A', 'token', original.id, {}); assert.equal(audited.classification, 'NO_WEBSITE'); assert.equal(saves, 1);
  await assert.rejects(service.run('A', 'token', original.id, {}), error => error instanceof RequestError && error.status === 429);
  const unsafe = lead('http://127.0.0.1/');
  const declined = new AuditService(() => ({ ...repository, findById: async () => unsafe }), defaultScoring);
  await assert.rejects(declined.run('A', 'token', unsafe.id, {}), error => error instanceof RequestError && error.status === 422); assert.equal(saves, 1);
});

test('audit persistence pins owner/ID/evidence timestamp, rejects stale writes and does not expose database errors', async () => {
  const original = lead(); const changes = await auditLead(original); const filters: [string, unknown][] = [];
  let data: Record<string, unknown> | null = null, failure: unknown = null, update: Record<string, unknown> = {};
  const query = { update: (value: Record<string, unknown>) => { update = value; return query; }, eq: (key: string, value: unknown) => { filters.push([key, value]); return query; }, select: () => query, maybeSingle: async () => ({ data, error: failure }) };
  const repository = new SupabaseAuditRepository({ from: () => query } as unknown as SupabaseClient, 'A');
  await assert.rejects(repository.saveAudit(original, changes), error => error instanceof RequestError && error.status === 409);
  assert.deepEqual(filters, [['owner_id', 'A'], ['id', original.id], ['updated_at', original.updatedAt]]);
  assert.deepEqual(Object.keys(update).sort(), ['audit', 'classification', 'score', 'score_reasons']);
  failure = { message: 'private detail' };
  await assert.rejects(repository.saveAudit(original, changes), error => error instanceof RequestError && error.status === 503 && !error.message.includes('private detail'));
  failure = null; data = { ...leadToRow(original, 'A'), ...update };
  assert.equal((await repository.saveAudit(original, changes)).classification, 'NO_WEBSITE');
});

test('new linked provenance invalidates a prior NO_WEBSITE assessment; identical links preserve a fresh audit', async () => {
  const original = lead(); const assessment = await auditLead(original);
  let row: Record<string, unknown> = leadToRow({ ...original, ...assessment }, 'A');
  let changes: Record<string, unknown> = {};
  const query = { select: () => query, eq: () => query, single: async () => ({ data: row, error: null }), update: (value: Record<string, unknown>) => { changes = value; return query; }, maybeSingle: async () => { row = { ...row, ...changes }; return { data: row, error: null }; } };
  const repo = new SupabaseLeadRepository({ from: () => query } as unknown as SupabaseClient, 'A');
  const addition = { source: 'OSM' as const, sourceId: 'node/2', metadata: { tags: { website: 'https://clinic.com/' } } };
  const linked = await repo.link(original.id, [addition]);
  assert.equal(linked.classification, null); assert.equal(linked.score, null); assert.equal(linked.audit, null); assert.deepEqual(linked.scoreReasons, []);
  assert.equal(linked.website, null); assert.deepEqual(resolveWebsiteEvidence(linked).candidates, ['https://clinic.com/']);
  const refreshed = await auditLead(linked, undefined, defaultScoring, async () => result()); row = leadToRow({ ...linked, ...refreshed }, 'A');
  const repeated = await repo.link(original.id, [addition]); assert.deepEqual(repeated.audit, refreshed.audit); assert.equal(repeated.provenance.length, 2);
});

test('total audit deadline aborts transport and DNS waits are bounded without opening connections', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const audit = fetchWebsite('https://clinic.com/', { resolve: publicResolver, transport: async (_destination, signal) => new Promise((_resolve, reject) => { signal.addEventListener('abort', () => reject(new WebsiteFetchError('timeout', 'Deadline exceeded.')), { once: true }); }) });
  await new Promise(resolve => setImmediate(resolve));
  context.mock.timers.tick(fetchLimits.totalMs);
  await assert.rejects(audit, error => error instanceof WebsiteFetchError && error.kind === 'timeout');
  let requests = 0;
  const dnsWait = fetchWebsite('https://clinic.com/', { resolve: async () => new Promise(() => {}), transport: async () => { requests++; return response(200); } });
  context.mock.timers.tick(5000);
  await assert.rejects(dnsWait, error => error instanceof WebsiteFetchError && error.kind === 'dns'); assert.equal(requests, 0);
  context.mock.timers.reset();
});
