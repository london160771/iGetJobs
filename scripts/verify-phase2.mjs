import { config } from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { createApp } from '../apps/api/dist/app.js';
import { readServerEnv } from '../apps/api/dist/env.js';
import { createServerSupabase } from '../apps/api/dist/supabase.js';
import { normalizeLead } from '../apps/api/dist/discovery/normalize.js';
import { leadToRow, SupabaseLeadRepository } from '../apps/api/dist/discovery/repository.js';
import { AuditService, SupabaseAuditRepository } from '../apps/api/dist/audit/service.js';
import { defaultScoring } from '../apps/api/dist/audit/policy.js';
import { auditLead } from '../apps/api/dist/audit/engine.js';
import { fetchWebsite, WebsiteFetchError } from '../apps/api/dist/audit/fetcher.js';

config({ path: fileURLToPath(new URL('../.env', import.meta.url)), quiet: true });
config({ path: fileURLToPath(new URL('../apps/api/.env', import.meta.url)), quiet: true });
const clients = [], created = [];
let server, checkpoint = 'Phase 2 configuration';
function check(condition, label) { checkpoint = label; if (!condition) throw new Error('Verification failed'); console.log('PASS: ' + label); }
const html = '<html><head><title>Fixture clinic</title><meta name="viewport" content="width=device-width"></head><body><h1>Clinic</h1><p>' + 'Fixture information for visitors and patients. '.repeat(5) + '</p><a href="mailto:fixture@clinic.com">Contact us</a></body></html>';
// Only named fixtures are injected; --live-website uses the production DNS/pinned transport.
const fixtureFetcher = async url => {
  if (url.includes('unreachable-audit.example')) throw new WebsiteFetchError('network', 'Website connection failed.');
  if (url.includes('good-audit.example') || url.includes('poor-audit.example')) {
    const body = url.includes('good-audit.example') ? html : '<html><body>Fixture poor page</body></html>';
    return { url, body, status: 200, headers: { 'content-type': 'text/html' }, bytes: Buffer.byteLength(body), durationMs: 100, redirects: 0 };
  }
  return fetchWebsite(url);
};
try {
  const settings = readServerEnv(process.env);
  const accounts = [];
  for (const suffix of ['A', 'B']) {
    checkpoint = 'Phase 2 account ' + suffix + ' sign-in';
    const client = createClient(settings.supabaseUrl, settings.supabaseKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(15000) }) } });
    clients.push(client);
    const signed = await client.auth.signInWithPassword({ email: process.env['SUPABASE_TEST_EMAIL_' + suffix] || '', password: process.env['SUPABASE_TEST_PASSWORD_' + suffix] || '' });
    check(!signed.error && Boolean(signed.data.session), checkpoint);
    const verified = await client.auth.getUser(); check(!verified.error && Boolean(verified.data.user), 'Phase 2 verified identity ' + suffix);
    accounts.push({ client, token: signed.data.session.access_token, id: verified.data.user.id, suffix });
  }
  const [a, b] = accounts;
  const repository = (owner, token) => new SupabaseAuditRepository(createServerSupabase(settings, token), owner);
  server = createApp(createServerSupabase(settings), undefined, new AuditService(repository, defaultScoring, fixtureFetcher)).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  async function request(id, account, body) {
    const response = await fetch(base + '/api/leads/' + id + (body === undefined ? '' : '/audit'), { method: body === undefined ? 'GET' : 'POST', headers: { ...(account ? { Authorization: 'Bearer ' + account.token } : {}), 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(35000) });
    return { status: response.status, data: await response.json() };
  }
  async function insert(account, website, provenance) {
    const lead = normalizeLead({ businessName: 'Disposable Phase 2 ' + randomUUID(), website, sourceId: randomUUID(), metadata: {} }, 'CSV').lead;
    if (provenance) lead.provenance.push(provenance);
    created.push({ client: account.client, id: lead.id, account: account.suffix });
    // Ignored UUID-only recovery journal: never credentials, tokens or contact data.
    await mkdir(fileURLToPath(new URL('../.local', import.meta.url)), { recursive: true });
    await writeFile(fileURLToPath(new URL('../.local/phase2-verification-ids.json', import.meta.url)), JSON.stringify(created.map(row => ({ id: row.id, account: row.account }))));
    const saved = await account.client.from('leads').insert(leadToRow(lead, account.id));
    if (saved.error) console.error('Database failure category: ' + (/abort|timeout|fetch failed/i.test(saved.error.message) ? 'connection/timeout' : /jwt|token/i.test(saved.error.message) ? 'authentication' : 'database response'));
    check(!saved.error, 'Disposable audit fixture inserted by its owner'); return lead;
  }
  const missing = await insert(a);
  check((await request(missing.id)).status === 401 && (await request(missing.id, null, {})).status === 401, 'Detail and audit routes require authentication');
  check((await request(missing.id, b)).status === 404 && (await request(missing.id, b, {})).status === 404, 'Foreign lead is invisible to detail and audit endpoints');
  check((await request(missing.id, a, { score: 100 })).status === 400, 'Audit API rejects browser score injection');
  const cases = [[missing, 'NO_WEBSITE', 65], [await insert(a, 'https://good-audit.example/'), 'ACCEPTABLE_WEBSITE', 5], [await insert(a, 'http://poor-audit.example/'), 'POOR_WEBSITE', 39], [await insert(a, 'https://unreachable-audit.example/'), 'POOR_WEBSITE', 55]];
  for (const [lead, classification, score] of cases) {
    checkpoint = 'Authenticated ' + classification + ' audit persistence';
    const audited = await request(lead.id, a, {});
    check(audited.status === 200 && audited.data.lead.classification === classification && audited.data.lead.score === score, checkpoint);
    const read = await a.client.from('leads').select('*').eq('id', lead.id).single();
    check(!read.error && read.data.owner_id === a.id && read.data.audit.version === 'static-v1' && read.data.score === score && read.data.score_reasons.reduce((sum, reason) => sum + reason.points, 0) === score && read.data.provenance.length === lead.provenance.length, 'Audit JSONB, reasons, owner and source history survive remote reload');
    const forbidden = await b.client.from('leads').update({ audit: {}, score: 100 }).eq('id', lead.id).select('id');
    const foreign = await b.client.from('leads').select('id').eq('id', lead.id);
    check(!forbidden.error && forbidden.data.length === 0 && !foreign.error && foreign.data.length === 0, 'Remote RLS prevents foreign audit read/write');
    check((await request(lead.id, a, {})).status === 429, 'Audit cooldown rejects immediate repeats');
    await new Promise(resolve => setTimeout(resolve, 5100));
  }
  const ownB = await insert(b);
  check((await request(ownB.id, b, {})).data.lead.classification === 'NO_WEBSITE' && (await request(ownB.id, a)).status === 404, 'Bidirectional API isolation and account B audit persistence');
  const discarded = await insert(a, '//bad host/?api_key=discarded-fixture');
  const discardedDetail = await request(discarded.id, a);
  check(discardedDetail.data.resolution.invalidCount === 1 && (await request(discarded.id, a, {})).status === 409 && !JSON.stringify(discardedDetail.data).includes('discarded-fixture'), 'Discarded invalid URL evidence remains unclassified without retaining credential values');
  const conflicted = await insert(a, 'https://good-audit.example/', { source: 'OSM', sourceId: 'node/fixture', metadata: { tags: { website: 'http://poor-audit.example/' } } });
  check((await request(conflicted.id, a, {})).status === 409, 'Unresolved provenance conflict cannot be classified');
  const chosen = await request(conflicted.id, a, { website: 'http://poor-audit.example/' });
  check(chosen.status === 200 && chosen.data.lead.audit.requestedWebsite === 'http://poor-audit.example/' && chosen.data.lead.website === 'https://good-audit.example/' && chosen.data.lead.audit.evidence.length === 2, 'Explicit choice persists evidence without overwriting canonical website');
  await new Promise(resolve => setTimeout(resolve, 5100));
  const unsafe = await insert(a, 'http://127.0.0.1/');
  check((await request(unsafe.id, a, {})).status === 422 && (await request(unsafe.id, a)).data.lead.audit === null, 'Unsafe destination stays unclassified and unfetched');
  const repo = repository(a.id, a.token);
  const stale = await repo.findById(missing.id);
  const changed = await a.client.from('leads').update({ notes: 'Disposable concurrency fixture' }).eq('id', missing.id);
  check(!changed.error, 'Disposable lead timestamp changed for concurrency verification');
  let conflict = false;
  try { await repo.saveAudit(stale, await auditLead(stale)); } catch (error) { conflict = error.status === 409; }
  check(conflict, 'Optimistic timestamp prevents saving an audit of stale evidence');
  const linking = new SupabaseLeadRepository(createServerSupabase(settings, a.token), a.id);
  const addition = { source: 'OSM', sourceId: 'node/audit-link-fixture', metadata: { tags: { website: 'https://good-audit.example/' } } };
  const linked = await linking.link(missing.id, [addition]);
  check(linked.audit === null && linked.classification === null && linked.score === null && linked.scoreReasons.length === 0, 'New remote website evidence clears a previous NO_WEBSITE assessment');
  const refreshed = await repo.saveAudit(linked, await auditLead(linked, undefined, defaultScoring, fixtureFetcher));
  const repeated = await linking.link(missing.id, [addition]);
  check(repeated.audit.auditedAt === refreshed.audit.auditedAt && repeated.score === refreshed.score && repeated.provenance.length === 2, 'Identical linking after remote JSONB round trip preserves the refreshed audit');
  if (process.argv.includes('--live-website')) {
    await new Promise(resolve => setTimeout(resolve, 5100));
    const live = await insert(a, 'https://example.com/');
    checkpoint = 'Live validated, pinned HTTPS website fetch';
    const verified = await request(live.id, a, {});
    check(verified.status === 200 && verified.data.lead.audit.state === 'reachable' && verified.data.lead.audit.metrics.status === 200 && verified.data.lead.audit.metrics.bytes > 0 && verified.data.lead.audit.checks.some(item => item.key === 'https' && item.outcome === 'pass'), checkpoint);
  }
} catch { console.error('FAIL: ' + checkpoint); process.exitCode = 1; }
finally {
  for (const row of created) { try { const deleted = await row.client.from('leads').delete().eq('id', row.id); if (deleted.error) { console.error('FAIL: Disposable Phase 2 cleanup'); process.exitCode = 1; } } catch { console.error('FAIL: Disposable Phase 2 cleanup'); process.exitCode = 1; } }
  for (const client of clients) { try { await client.auth.signOut({ scope: 'local' }); } catch { /* Sessions are not persisted. */ } }
  if (server) await new Promise(resolve => server.close(resolve));
}
