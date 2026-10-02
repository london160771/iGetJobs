import { config } from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { createApp } from '../apps/api/dist/app.js';
import { readServerEnv } from '../apps/api/dist/env.js';
import { createServerSupabase } from '../apps/api/dist/supabase.js';
import { createManagementService } from '../apps/api/dist/management.js';
import { createAuditService } from '../apps/api/dist/audit/service.js';
import { createDiscoveryService } from '../apps/api/dist/discovery/service.js';
import { normalizeLead } from '../apps/api/dist/discovery/normalize.js';
import { leadToRow, leadFromRow } from '../apps/api/dist/discovery/repository.js';
import { dashboardCounts, leadLabelMaxLength, summarizeLead } from '@igetjobs/shared';

config({ path: fileURLToPath(new URL('../.env', import.meta.url)), quiet: true });
config({ path: fileURLToPath(new URL('../apps/api/.env', import.meta.url)), quiet: true });
const created = [], clients = [];
let server, checkpoint = 'Phase 3 configuration';
function check(condition, label) { checkpoint = label; if (!condition) throw new Error('Verification failed'); console.log('PASS: ' + label); }
try {
  const settings = readServerEnv(process.env), accounts = [];
  for (const suffix of ['A', 'B']) {
    checkpoint = 'Phase 3 disposable account sign-in ' + suffix;
    const client = createClient(settings.supabaseUrl, settings.supabaseKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(15000) }) } });
    clients.push(client);
    const result = await client.auth.signInWithPassword({ email: process.env['SUPABASE_TEST_EMAIL_' + suffix] || '', password: process.env['SUPABASE_TEST_PASSWORD_' + suffix] || '' });
    check(!result.error && Boolean(result.data.session), checkpoint);
    const user = await client.auth.getUser(); check(!user.error && Boolean(user.data.user), 'Verified live identity ' + suffix);
    const schema = await client.from('leads').select('id,activity').limit(1);
    check(!schema.error, 'Management migration available ' + suffix);
    const snapshotSchema = await client.rpc('lead_management_snapshot');
    check(!snapshotSchema.error && Array.isArray(snapshotSchema.data), 'Owner snapshot migration available ' + suffix);
    accounts.push({ client, token: result.data.session.access_token, owner: user.data.user.id, suffix });
  }
  const [a, b] = accounts;
  const anonymousSnapshot = await createServerSupabase(settings).rpc('lead_management_snapshot');
  check(Boolean(anonymousSnapshot.error) && !Array.isArray(anonymousSnapshot.data), 'Anonymous callers cannot execute the snapshot RPC');
  server = createApp(createServerSupabase(settings), createDiscoveryService(process.env), createAuditService(process.env), createManagementService(process.env)).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  async function request(path, account = a, body) {
    const response = await fetch(base + path, { method: body === undefined ? 'GET' : path.endsWith('/audit') || path.startsWith('/api/discovery/') ? 'POST' : 'PATCH', headers: { 'Content-Type': 'application/json', ...(account ? { Authorization: 'Bearer ' + account.token } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(35000) });
    return { status: response.status, data: await response.json() };
  }
  check((await request('/api/management/counts', null)).status === 401, 'Management routes require authentication');
  const initialA = (await request('/api/management/counts')).data, initialB = (await request('/api/management/counts', b)).data;
  const marker = 'Phase3-' + randomUUID();
  const rows = Array.from({ length: 201 }, (_, i) => {
    const lead = normalizeLead({ businessName: 'Disposable Phase 3 ' + marker + ' ' + String(i).padStart(2, '0'), niche: marker, country: 'GB', city: i === 0 ? 'London' : 'Oxford', ...(i === 0 ? { email: 'public@clinic.com', phone: '+442079460958' } : {}), sourceId: randomUUID(), metadata: {} }, 'CSV').lead;
    lead.createdAt = new Date(Date.UTC(2026, 0, 1 + i, 12)).toISOString();
    return lead;
  });
  const foreign = normalizeLead({ businessName: 'Disposable Phase 3 foreign ' + marker, niche: marker, sourceId: randomUUID(), metadata: {} }, 'OSM').lead;
  created.push(...rows.map(row => ({ id: row.id, account: 'A' })), { id: foreign.id, account: 'B' });
  await mkdir(fileURLToPath(new URL('../.local', import.meta.url)), { recursive: true });
  await writeFile(fileURLToPath(new URL('../.local/phase3-verification-ids.json', import.meta.url)), JSON.stringify(created));
  checkpoint = 'Insert disposable owner records';
  const insertA = await a.client.from('leads').insert(rows.map(row => leadToRow(row, a.owner))).select('*');
  const insertB = await b.client.from('leads').insert(leadToRow(foreign, b.owner)).select('*').single();
  check(!insertA.error && !insertB.error, checkpoint);
  let lead = leadFromRow(insertA.data.find(row => row.id === rows[0].id));
  const list = await request('/api/management/leads?' + new URLSearchParams({ niche: marker, sort: 'name' }));
  check(list.status === 200 && list.data.total === 201 && list.data.leads.length === 25 && list.data.leads[0].id === lead.id, 'Complete collection filters and name sorting with pagination');
  const second = await request('/api/management/leads?' + new URLSearchParams({ niche: marker, page: '2', sort: 'oldest' }));
  check(second.data.leads.length === 25 && second.data.leads[0].id === rows[25].id, 'Second page and chronological sorting');
  check((await request('/api/management/counts')).data.total === initialA.total + 201 && (await request('/api/management/counts', b)).data.total === initialB.total + 1, 'Dashboard counts include only the complete owner collection');
  check((await request('/api/management/leads?' + new URLSearchParams({ niche: marker }), b)).data.total === 1, 'Cross-user management collection isolation');
  const audited = await request('/api/leads/' + lead.id + '/audit', a, {});
  check(audited.status === 200 && audited.data.lead.classification === 'NO_WEBSITE', 'Existing audit endpoint persists a current assessment');
  lead = audited.data.lead;
  const snapshot = lead.updatedAt;
  async function edit(input) {
    const saved = await request('/api/management/leads/' + lead.id, a, { expectedUpdatedAt: lead.updatedAt, ...input });
    check(saved.status === 200, 'Guarded management save'); lead = saved.data.lead; return saved;
  }
  await edit({ status: 'Qualified', notes: 'Disposable follow-up notes', followUpAt: '2026-10-02T12:00:00.000Z' });
  check(lead.audit !== null && lead.notes === 'Disposable follow-up notes' && Date.parse(lead.followUpAt) === Date.parse('2026-10-02T12:00:00Z') && lead.activity.at(-1).statusTo === 'Qualified', 'Notes, status, follow-up and history persist without invalidating unchanged evidence');
  const read = await a.client.from('leads').select('*').eq('id', lead.id).single();
  check(!read.error && read.data.notes === lead.notes && read.data.status === lead.status && read.data.activity.length >= 2, 'Management data survives remote database reload');
  check((await request('/api/management/leads/' + lead.id, a, { expectedUpdatedAt: snapshot, notes: 'Stale' })).status === 409, 'Stale management write rejected');
  check((await request('/api/management/leads/' + lead.id, b, { expectedUpdatedAt: lead.updatedAt, notes: 'Foreign' })).status === 404, 'Foreign owner API edit rejected');
  const foreignRead = await b.client.from('leads').select('id').eq('id', lead.id), foreignWrite = await b.client.from('leads').update({ notes: 'Foreign' }).eq('id', lead.id).select('id');
  check(!foreignRead.error && foreignRead.data.length === 0 && !foreignWrite.error && foreignWrite.data.length === 0, 'Remote RLS blocks foreign management read/write');
  check((await request('/api/management/leads/' + lead.id, a, { expectedUpdatedAt: lead.updatedAt, score: 100 })).status === 400, 'Derived field injection rejected');
  const filtered = await request('/api/management/leads?' + new URLSearchParams({ niche: marker, country: 'GB', city: 'London', classification: 'NO_WEBSITE', minScore: '75', maxScore: '75', priority: 'High', status: 'Qualified', source: 'CSV', hasEmail: 'yes', hasPhone: 'yes' }));
  check(filtered.data.total === 1 && filtered.data.leads[0].id === lead.id, 'All management filters combine and honor stored score priority');
  const counts = (await request('/api/management/counts')).data;
  check(counts.qualified === initialA.qualified + 1 && counts.noWebsite === initialA.noWebsite + 1, 'Dashboard classification and stage counts update');
  for (const status of ['Contacted', 'Replied', 'Call Booked', 'Closed', 'Lost', 'New']) { await edit({ status }); check(lead.status === status, 'Pipeline status persists: ' + status); }
  await edit({ notes: '', followUpAt: null });
  check(lead.notes === '' && lead.followUpAt === null && lead.activity.at(-1).followUpTo === null, 'Notes and follow-up clearing persist');
  await edit({ website: '//clinic.com/?api_key=fixture-management-secret' });
  check(lead.website === 'https://clinic.com/' && lead.domain === 'clinic.com' && lead.audit === null && lead.classification === null && lead.score === null && lead.scoreReasons.length === 0 && lead.activity.at(-1).assessmentInvalidated, 'Canonical website correction sanitizes credentials and atomically clears all assessment fields');
  check(!JSON.stringify(lead).includes('fixture-management-secret'), 'Management persistence does not retain URL credentials');
  checkpoint = 'Database-level invalidation guard';
  const reset = await a.client.from('leads').update({ audit: { checks: [] }, classification: 'ACCEPTABLE_WEBSITE', score: 5, score_reasons: [{ points: 5 }] }).eq('id', lead.id);
  const changed = await a.client.from('leads').update({ rating: 4.5, audit: { forged: true }, score: 100, activity: [] }).eq('id', lead.id).select('*').single();
  check(!reset.error && !changed.error && changed.data.audit === null && changed.data.classification === null && changed.data.score === null && changed.data.score_reasons.length === 0 && changed.data.activity.at(-1).assessmentInvalidated, 'Direct authenticated database edit cannot retain a stale assessment or forge history');
  check((await request('/api/management/counts')).data.noWebsite === initialA.noWebsite, 'Invalidated classifications disappear from dashboard counts');
  const cleared = await request('/api/management/leads?' + new URLSearchParams({ niche: marker, classification: 'UNAUDITED' }));
  check(cleared.data.total === 201, 'Invalidated lead returns to the unaudited filter');

  const concurrent = Array.from({ length: 8 }, (_, i) => {
    const row = normalizeLead({ businessName: 'Disposable concurrent ' + marker + ' ' + i, niche: marker, sourceId: randomUUID(), metadata: {} }, 'CSV').lead;
    row.status = 'Qualified'; return row;
  });
  created.push(...concurrent.map(row => ({ id: row.id, account: 'A' })));
  await writeFile(fileURLToPath(new URL('../.local/phase3-verification-ids.json', import.meta.url)), JSON.stringify(created));
  checkpoint = 'Concurrent owner snapshot / insertion regression';
  const concurrencyResults = await Promise.allSettled([
    (async () => { for (const row of concurrent) { const inserted = await a.client.from('leads').insert(leadToRow(row, a.owner)); if (inserted.error) throw new Error('Concurrent fixture insert failed'); } })(),
    (async () => {
      for (let i = 0; i < 8; i++) {
        const snapshot = await a.client.rpc('lead_management_snapshot');
        check(!snapshot.error && Array.isArray(snapshot.data) && new Set(snapshot.data.map(row => row.id)).size === snapshot.data.length, 'Concurrent snapshot contains each lead exactly once');
        const own = snapshot.data.filter(row => row.niche === marker), counts = dashboardCounts(own.map(row => summarizeLead(leadFromRow(row))));
        check(counts.total >= 201 && counts.total <= 209 && counts.qualified === counts.total - 201, 'Concurrent snapshot counts match its exact rows');
        const apiCounts = await request('/api/management/counts');
        check(apiCounts.status === 200 && apiCounts.data.total >= initialA.total + 201 && apiCounts.data.total <= initialA.total + 209 && apiCounts.data.qualified - initialA.qualified === apiCounts.data.total - initialA.total - 201, 'Concurrent dashboard counts remain coherent');
      }
    })()
  ]);
  if (concurrencyResults.some(result => result.status === 'rejected')) throw new Error('Concurrent snapshot regression failed');
  const completeCounts = await request('/api/management/counts');
  check(completeCounts.data.total === initialA.total + 209 && completeCounts.data.qualified === initialA.qualified + 8, 'Settled dashboard totals equal all unique inserted leads');
  const foreignSnapshot = await b.client.rpc('lead_management_snapshot');
  const idsA = new Set(created.filter(row => row.account === 'A').map(row => row.id));
  check(!foreignSnapshot.error && foreignSnapshot.data.every(row => !idsA.has(row.id)), 'Snapshot RPC obeys cross-user RLS');

  lead = (await request('/api/leads/' + lead.id)).data.lead;
  const historyLength = lead.activity.length;
  await edit({ notes: lead.notes, status: lead.status, followUpAt: lead.followUpAt });
  check(lead.activity.length === historyLength, 'Identical management retries do not duplicate history');
  const boundary = 'x'.repeat(leadLabelMaxLength);
  await edit({ city: boundary, niche: boundary });
  const boundaryQuery = await request('/api/management/leads?' + new URLSearchParams({ city: boundary, niche: boundary }));
  check(boundaryQuery.status === 200 && boundaryQuery.data.total === 1 && boundaryQuery.data.leads[0].id === lead.id, 'Boundary city/niche values save and filter consistently');
  for (const field of ['city', 'niche']) {
    check((await request('/api/management/leads/' + lead.id, a, { expectedUpdatedAt: lead.updatedAt, [field]: boundary + 'x' })).status === 400, 'Oversized management label rejected');
    check((await request('/api/management/leads?' + new URLSearchParams({ [field]: boundary + 'x' }))).status === 400, 'Oversized filter label rejected');
  }
  const csvPreview = await request('/api/discovery/import', a, { csv: 'businessName,city,niche,country\nDisposable CSV boundary ' + marker + ',' + boundary + ',' + boundary + ',GB' });
  check(csvPreview.status === 200 && csvPreview.data.rows.length === 1 && csvPreview.data.rows[0].lead.city === boundary && csvPreview.data.rows[0].lead.niche === boundary, 'CSV preview accepts exact shared label boundary');
  const csvLead = csvPreview.data.rows[0].lead;
  created.push({ id: csvLead.id, account: 'A' });
  await writeFile(fileURLToPath(new URL('../.local/phase3-verification-ids.json', import.meta.url)), JSON.stringify(created));
  const csvSaved = await request('/api/discovery/save', a, { previewId: csvPreview.data.id, selections: [{ id: csvLead.id, action: 'save' }] });
  const csvRead = await a.client.from('leads').select('city,niche').eq('id', csvLead.id).single();
  check(csvSaved.status === 200 && csvSaved.data.results[0].status === 'saved' && !csvRead.error && csvRead.data.city === boundary && csvRead.data.niche === boundary, 'CSV boundary values persist without truncation');
  const invalidCsv = await request('/api/discovery/import', a, { csv: 'businessName,city,niche\nOversized,' + boundary + 'x,' + boundary });
  check(invalidCsv.status === 200 && invalidCsv.data.rows.length === 0 && invalidCsv.data.warnings.length > 0, 'Oversized CSV labels produce a visible row warning');
} catch { console.error('FAIL: ' + checkpoint); process.exitCode = 1; }
finally {
  for (const suffix of ['A', 'B']) {
    const client = clients[suffix === 'A' ? 0 : 1], ids = created.filter(row => row.account === suffix).map(row => row.id);
    if (client && ids.length) try { const result = await client.from('leads').delete().in('id', ids); if (result.error) { console.error('FAIL: Phase 3 disposable fixture cleanup'); process.exitCode = 1; } } catch { console.error('FAIL: Phase 3 disposable fixture cleanup'); process.exitCode = 1; }
  }
  for (const client of clients) { try { await client.auth.signOut({ scope: 'local' }); } catch { /* Local-only test sessions. */ } }
  if (server) await new Promise(resolve => server.close(resolve));
}
