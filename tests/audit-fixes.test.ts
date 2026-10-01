import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { Worker } from 'node:worker_threads';
import { normalizeLead } from '../apps/api/src/discovery/normalize.js';
import { leadFromRow, leadToRow } from '../apps/api/src/discovery/repository.js';
import { RequestError } from '../apps/api/src/discovery/errors.js';
import { resolveWebsiteEvidence } from '../apps/api/src/website-safety.js';
import { auditLead } from '../apps/api/src/audit/engine.js';
import { analysisLimits, hasContactText, inspectHtml, inspectHtmlIsolated } from '../apps/api/src/audit/html.js';
import { defaultScoring } from '../apps/api/src/audit/policy.js';
import type { WebsiteFetchResult } from '../apps/api/src/audit/fetcher.js';

const response = (body: string): WebsiteFetchResult => ({ url: 'https://clinic.com/', body, bytes: Buffer.byteLength(body), status: 200, headers: { 'content-type': 'text/html' }, durationMs: 100, redirects: 0 });
const fixtureLead = () => normalizeLead({ businessName: 'Audit fixture', sourceId: 'fixture', metadata: {} }, 'CSV').lead;
const invalid = (error: unknown) => error instanceof RequestError && error.status === 409;
const limited = (error: unknown) => error instanceof RequestError && error.status === 422;

test('contact inspection stays bounded on reproduced long text and finds a later normal email', () => {
  for (const text of ['a'.repeat(40000), 'a'.repeat(20000) + '@' + 'b'.repeat(20000), 'a'.repeat(64000)]) {
    const start = performance.now();
    const checks = inspectHtml(response('<html><body>' + text + '</body></html>'), defaultScoring);
    assert.equal(checks.find(check => check.key === 'contact')?.outcome, 'fail');
    assert.ok(performance.now() - start < 750, 'Bounded long-text inspection must finish well below one second.');
  }
  assert.equal(hasContactText('a'.repeat(40000) + ' Contact: public@clinic.com.'), true);
  for (const text of ['Write to (Public+booking@clinic.co.uk).', 'Call +44 (20) 7946-0958']) assert.equal(hasContactText(text), true);
  for (const text of ['not-an-email', 'public@clinic', 'public@@clinic.com', 'public@-clinic.com', '12345']) assert.equal(hasContactText(text), false);
});

test('HTML, text, tree depth and node limits decline rather than score a partial page', async () => {
  const oversized = '<body>' + 'x'.repeat(analysisLimits.htmlBytes) + '</body>';
  const tooMuchText = '<body>' + 'x'.repeat(analysisLimits.textChars + 1) + '</body>';
  const deep = '<div>'.repeat(analysisLimits.depth + 1) + 'text' + '</div>'.repeat(analysisLimits.depth + 1);
  const manyNodes = '<span>x</span>'.repeat(analysisLimits.nodes);
  for (const html of [oversized, tooMuchText, deep, manyNodes]) assert.throws(() => inspectHtml(response(html), defaultScoring), limited);
  const lead = { ...fixtureLead(), website: 'https://clinic.com/' };
  await assert.rejects(auditLead(lead, undefined, defaultScoring, async () => response(oversized)), limited);
  assert.equal(lead.audit, null); assert.equal(lead.classification, null); assert.equal(lead.score, null);
});

test('production HTML inspection yields the API event loop and equals deterministic bounded inspection', async () => {
  const result = response('<html><body>' + 'a'.repeat(40000) + '</body></html>');
  const start = performance.now();
  const analysis = inspectHtmlIsolated(result, defaultScoring);
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(performance.now() - start < 500, 'Worker startup must not block the API event loop.');
  assert.deepEqual(await analysis, inspectHtml(result, defaultScoring));
  await assert.rejects(inspectHtmlIsolated(response('<body>' + '<div>'.repeat(80)), defaultScoring), limited);
});

test('worker deadline terminates incomplete analysis without inventing a quality result', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const analysis = inspectHtmlIsolated(response('<html><body>Fixture</body></html>'), defaultScoring);
  context.mock.timers.tick(analysisLimits.startupMs);
  await assert.rejects(analysis, limited);
});

test('inspection deadline also terminates a ready worker that stops responding', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let workerReady!: () => void;
  const ready = new Promise<void>(resolve => { workerReady = resolve; });
  // Hold the work message after a real worker initializes, simulating stalled
  // analysis. The execution deadline must work independently of startup.
  context.mock.method(Worker.prototype, 'postMessage', () => workerReady());
  const analysis = inspectHtmlIsolated(response('<html><body>Fixture</body></html>'), defaultScoring);
  await ready;
  context.mock.timers.tick(analysisLimits.workerMs);
  await assert.rejects(analysis, limited);
});

test('flat website arrays retain sanitized candidates and explicit conflicts through persistence', async () => {
  const lead = normalizeLead({ businessName: 'Array website', website: ['//clinic.com/?token=fixture-secret', 'https://other.com/'], sourceId: 'fixture', metadata: {} }, 'SERPAPI').lead;
  const reloaded = leadFromRow(JSON.parse(JSON.stringify(leadToRow(lead, 'owner'))));
  const evidence = resolveWebsiteEvidence(reloaded);
  assert.deepEqual(evidence.candidates, ['https://clinic.com/', 'https://other.com/']);
  assert.equal(evidence.requiresChoice, true); assert.equal(reloaded.website, null);
  assert.ok(evidence.evidence.some(item => item.path === 'metadata.website[0]'));
  assert.equal(JSON.stringify(evidence).includes('fixture-secret'), false);
  await assert.rejects(auditLead(reloaded), invalid);
  const audited = await auditLead(reloaded, 'https://clinic.com/', defaultScoring, async () => response('<html><body>Fixture</body></html>'));
  assert.notEqual(audited.classification, 'NO_WEBSITE'); assert.equal(audited.audit.requestedWebsite, 'https://clinic.com/');
});

test('malformed website evidence and containers cannot become NO_WEBSITE or invent a candidate', async () => {
  for (const value of [{ url: 'https://clinic.com/' }, [['https://clinic.com/']], ['https://clinic.com/', { url: 'https://other.com/' }], 42, false, Array.from({ length: 17 }, () => 'https://clinic.com/')]) {
    const lead = fixtureLead(); lead.provenance[0]!.metadata = { fields: { website: value } };
    const resolution = resolveWebsiteEvidence(lead);
    assert.ok(resolution.invalidCount > 0); assert.equal(resolution.requiresChoice, true);
    await assert.rejects(auditLead(lead), invalid);
  }
  for (const fields of [{ website: { unexpected: 'https://clinic.com/' } }, [{ website: 'https://clinic.com/' }], 'https://clinic.com/']) {
    const lead = fixtureLead(); lead.provenance[0]!.metadata = { fields };
    await assert.rejects(auditLead(lead), invalid);
  }
  const unknown = fixtureLead(); unknown.provenance[0]!.metadata = { website: { url: 'https://clinic.com/' } };
  assert.deepEqual(resolveWebsiteEvidence(unknown).candidates, []);
  const supported = fixtureLead(); supported.provenance[0]!.metadata = { fields: { domain: ['clinic.com'] } };
  assert.deepEqual(resolveWebsiteEvidence(supported).candidates, ['https://clinic.com/']);
  assert.equal(resolveWebsiteEvidence(supported).requiresChoice, false);
  const malformed = normalizeLead({ businessName: 'Unknown website shape', website: { url: 'https://clinic.com/' }, sourceId: 'fixture', metadata: {} }, 'SERPAPI').lead;
  await assert.rejects(auditLead(malformed), invalid);
});

test('unused, desktop-only, overridden and inline CSS earn no unverified mobile penalty', async () => {
  const body = '<html><head><title>Clinic</title></head><body><p>' + 'Clinic details for visitors and patients. '.repeat(5) + '</p><a href="mailto:public@clinic.com">Contact us</a></body></html>';
  const styles = ['.unused { min-width: 900px; }', '@media (min-width: 1200px) { body { min-width: 900px; } }', 'body { min-width: 900px; } @media (max-width: 760px) { body { min-width: 0; } }'];
  const lead = { ...fixtureLead(), website: 'https://clinic.com/' };
  const base = await auditLead(lead, undefined, defaultScoring, async () => response(body));
  for (const html of [...styles.map(style => body.replace('</head>', '<style>' + style + '</style></head>')), body.replace('<body>', '<body style="min-width:900px">')]) {
    const audited = await auditLead(lead, undefined, defaultScoring, async () => response(html));
    assert.equal(audited.audit.checks.find(check => check.key === 'mobile_width')?.outcome, 'unknown');
    assert.equal(audited.score, base.score); assert.equal(audited.classification, 'ACCEPTABLE_WEBSITE');
    assert.ok(!audited.scoreReasons.some(reason => reason.key === 'mobile_width'));
  }
});
