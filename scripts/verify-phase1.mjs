import { config } from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createApp } from '../apps/api/dist/app.js';
import { readServerEnv } from '../apps/api/dist/env.js';
import { createServerSupabase } from '../apps/api/dist/supabase.js';
import { createDiscoveryService, DiscoveryService } from '../apps/api/dist/discovery/service.js';
import { SupabaseLeadRepository } from '../apps/api/dist/discovery/repository.js';
import { ProviderGuard } from '../apps/api/dist/discovery/usage.js';
import { RequestError } from '../apps/api/dist/discovery/errors.js';

config({ path: fileURLToPath(new URL('../.env', import.meta.url)), quiet: true });
config({ path: fileURLToPath(new URL('../apps/api/.env', import.meta.url)), quiet: true });
const clients = [], created = [];
let server;
let checkpoint = 'Configuration';
function check(condition, label) {
  checkpoint = label;
  if (!condition) throw new Error('Verification failed');
  console.log('PASS: ' + label);
}

try {
  const settings = readServerEnv(process.env);
  check(Boolean(settings.supabaseUrl && settings.supabaseKey), 'Validated public Supabase configuration');
  const accounts = [];
  for (const suffix of ['A', 'B']) {
    checkpoint = 'Disposable test account ' + suffix + ' sign-in';
    const client = createClient(settings.supabaseUrl, settings.supabaseKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(15000) }) }
    });
    clients.push(client);
    const result = await client.auth.signInWithPassword({
      email: process.env['SUPABASE_TEST_EMAIL_' + suffix] || '',
      password: process.env['SUPABASE_TEST_PASSWORD_' + suffix] || ''
    });
    check(!result.error && Boolean(result.data.session), checkpoint);
    const verified = await client.auth.getUser();
    check(!verified.error && Boolean(verified.data.user), 'Verified test account ' + suffix);
    accounts.push({ client, token: result.data.session.access_token, userId: verified.data.user.id });
  }
  const [a, b] = accounts;
  const service = createDiscoveryService(process.env);
  server = createApp(createServerSupabase(settings), service).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  async function request(path, account, body) {
    const response = await fetch(base + path, {
      method: body ? 'POST' : 'GET',
      headers: { ...(account ? { Authorization: 'Bearer ' + account.token } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(60000)
    });
    return { status: response.status, data: await response.json() };
  }
  check((await request('/api/leads')).status === 401 && (await request('/api/discovery/config')).status === 401, 'Protected API rejects anonymous access');
  check((await request('/api/session', a)).data.userId === a.userId && (await request('/api/session', b)).data.userId === b.userId, 'API independently verifies both sessions');
  const marker = randomUUID();
  const name = 'Disposable Phase 1 ' + marker;
  const domain = 'verification-' + marker + '.example';
  const csv = 'businessName,country,city,address,website,extra\r\n' + name + ',GB,Bath,"1 Test Street\nBath",' + domain + '/?token=disposable-credential-marker&lang=en,original\r\n';
  const imported = await request('/api/discovery/import', a, { csv, filename: 'disposable-verification.csv' });
  check(imported.status === 200 && imported.data.rows.length === 1 && imported.data.rows[0].duplicate.kind === 'new', 'CSV preview normalizes a quoted multiline record');
  const row = imported.data.rows[0];
  created.push({ client: a.client, id: row.lead.id });
  const saveBody = { previewId: imported.data.id, selections: [{ id: row.lead.id, action: 'save' }], ownerId: b.userId, score: 100 };
  check((await request('/api/discovery/save', b, saveBody)).status === 410, 'A preview cannot be saved by another user');
  const saved = await request('/api/discovery/save', a, saveBody);
  check(saved.status === 200 && saved.data.results[0].status === 'saved', 'Authenticated preview save succeeds');
  const persisted = await a.client.from('leads').select('*').eq('id', row.lead.id).single();
  check(!persisted.error && persisted.data.owner_id === a.userId && persisted.data.score === null && persisted.data.classification === null
    && persisted.data.domain === domain && persisted.data.provenance[0].metadata.fields.extra === 'original', 'Remote persistence retains normalized fields and provenance without mass assignment');
  check(persisted.data.website === 'https://' + domain + '/?lang=en' && !JSON.stringify(persisted.data).includes('disposable-credential-marker'), 'Canonical and provenance URLs exclude credential query values remotely');

  const relativeDomain = 'relative-' + marker + '.example';
  const relativeWebsite = '//' + relativeDomain + '/contact?api_key=relative-credential-marker&lang=en#access_token=relative-credential-marker';
  const relativeSocial = '//facebook.com/verification-' + marker + '?token=relative-credential-marker&page=2';
  const relativeCsv = 'name,website,facebook,extra\nDisposable relative ' + marker + ',' + relativeWebsite + ',' + relativeSocial + ',preserved';
  const relativePreview = await request('/api/discovery/import', a, { csv: relativeCsv, filename: 'relative-verification.csv' });
  check(relativePreview.status === 200 && relativePreview.data.rows.length === 1 && !JSON.stringify(relativePreview.data).includes('relative-credential-marker'), 'Protocol-relative CSV preview contains no credential query or fragment values');
  const relativeLead = relativePreview.data.rows[0].lead;
  created.push({ client: a.client, id: relativeLead.id });
  const relativeSaved = await request('/api/discovery/save', a, { previewId: relativePreview.data.id, selections: [{ id: relativeLead.id, action: 'save' }] });
  const relativeRead = await a.client.from('leads').select('*').eq('id', relativeLead.id).single();
  check(relativeSaved.data.results[0].status === 'saved' && !relativeRead.error && !JSON.stringify(relativeRead.data).includes('relative-credential-marker')
    && relativeRead.data.website === 'https://' + relativeDomain + '/contact?lang=en' && relativeRead.data.socials.facebook === 'https:' + relativeSocial.split('?')[0] + '?page=2'
    && relativeRead.data.provenance[0].metadata.fields.extra === 'preserved' && relativeRead.data.provenance[0].metadata.filename === 'relative-verification.csv'
    && relativeRead.data.source_id === relativeLead.sourceId, 'Remote protocol-relative website/social/provenance persistence preserves safe fields without credentials');
  const relativeReload = await request('/api/leads', a);
  const relativeReloaded = relativeReload.data.leads.find(lead => lead.id === relativeLead.id);
  check(relativeReload.status === 200 && Boolean(relativeReloaded) && !JSON.stringify(relativeReloaded).includes('relative-credential-marker'), 'Reloaded API lead keeps protocol-relative provenance sanitized');
  check((await request('/api/leads', a)).data.leads.some(lead => lead.id === row.lead.id)
    && !(await request('/api/leads', b)).data.leads.some(lead => lead.id === row.lead.id), 'Reloaded API leads remain owner scoped');
  const foreignRead = await b.client.from('leads').select('id').eq('id', row.lead.id);
  const foreignUpdate = await b.client.from('leads').update({ business_name: 'Forbidden change' }).eq('id', row.lead.id).select('id');
  check(!foreignRead.error && foreignRead.data.length === 0 && !foreignUpdate.error && foreignUpdate.data.length === 0, 'Remote RLS denies another user reading or changing the API-saved lead');
  const retry = await request('/api/discovery/save', a, saveBody);
  check(retry.data.results[0].leadId === row.lead.id && retry.data.results[0].status === 'saved', 'Same-preview retries do not duplicate saved leads');
  const linkedPreview = await request('/api/discovery/import', a, { csv: csv.replace('original', 'additional'), filename: 'additional-source.csv' });
  const linkRow = linkedPreview.data.rows[0];
  check(linkRow.duplicate.kind === 'exact' && linkRow.duplicate.canLink, 'Re-import identifies an exact saved duplicate for explicit review');
  const denied = await request('/api/discovery/save', a, { previewId: linkedPreview.data.id, selections: [{ id: linkRow.lead.id, action: 'save' }] });
  check(denied.data.results[0].status === 'failed', 'Duplicate records are not silently saved or merged');
  const linked = await request('/api/discovery/save', a, { previewId: linkedPreview.data.id, selections: [{ id: linkRow.lead.id, action: 'link' }] });
  const reread = await a.client.from('leads').select('business_name, provenance').eq('id', row.lead.id).single();
  check(linked.data.results[0].status === 'linked' && reread.data.business_name === name && reread.data.provenance.length === 2, 'Explicit source linking preserves existing fields and both metadata records');
  const repeatedPreview = await request('/api/discovery/import', a, { csv: csv.replace('original', 'additional'), filename: 'additional-source.csv' });
  const repeatedLink = await request('/api/discovery/save', a, { previewId: repeatedPreview.data.id, selections: [{ id: repeatedPreview.data.rows[0].lead.id, action: 'link' }] });
  const repeatedRead = await a.client.from('leads').select('provenance').eq('id', row.lead.id).single();
  check(repeatedLink.data.results[0].status === 'linked' && !repeatedRead.error && repeatedRead.data.provenance.length === 2, 'Identical source linking after remote JSONB round trip does not grow provenance');

  // Simulate only the lost acknowledgement; use real authenticated persistence/RLS.
  let insertCalls = 0;
  const faultService = new DiscoveryService(process.env, (ownerId, token) => {
    const repository = new SupabaseLeadRepository(createServerSupabase(settings, token), ownerId);
    return {
      identities: () => repository.identities(), list: () => repository.list(), findById: id => repository.findById(id), link: (id, provenance) => repository.link(id, provenance),
      insert: async lead => { insertCalls++; await repository.insert(lead); throw new RequestError(503, 'Simulated lost acknowledgement'); }
    };
  }, new ProviderGuard({ load: async () => ({}), save: async () => {} }));
  const faultPreview = await faultService.importCsv(a.userId, a.token, { csv: 'name\nDisposable retry ' + marker });
  const retryId = faultPreview.rows[0].lead.id;
  created.push({ client: a.client, id: retryId });
  const faultInput = { previewId: faultPreview.id, selections: [{ id: retryId, action: 'save' }] };
  check((await faultService.save(a.userId, a.token, faultInput)).results[0].status === 'failed', 'Lost acknowledgement is simulated after a real owner insert');
  const reconciled = await faultService.save(a.userId, a.token, faultInput);
  check(reconciled.results[0].status === 'saved' && reconciled.results[0].leadId === retryId && insertCalls === 1, 'Retry reconciles the remotely committed lead by owner and preview ID without reinserting');
  const foreignRepository = new SupabaseLeadRepository(createServerSupabase(settings, b.token), b.userId);
  check(await foreignRepository.findById(retryId) === null, 'Remote reconciliation lookup cannot read another owner record');
  const branchPreview = await request('/api/discovery/import', a, { csv: csv.replace(name, name + ' branch').replace('1 Test Street', '2 Test Street') });
  const branch = branchPreview.data.rows[0];
  check(branch.duplicate.kind === 'possible' && !branch.duplicate.canLink, 'Shared domains with conflicting business details require manual review');
  created.push({ client: a.client, id: branch.lead.id });
  const separate = await request('/api/discovery/save', a, { previewId: branchPreview.data.id, selections: [{ id: branch.lead.id, action: 'separate' }] });
  check(separate.data.results[0].status === 'saved', 'Reviewed uncertain duplicate can be kept as a separate lead');
  if (process.argv.includes('--live-source')) {
    checkpoint = 'Live Geoapify discovery';
    const query = { source: 'GEOAPIFY', country: 'GB', city: 'Bath, Somerset', niche: 'dentists' };
    const discovery = await request('/api/discovery/search', a, query);
    check(discovery.status === 200 && discovery.data.rows.length > 0, checkpoint);
    check(discovery.data.rows.every(item => item.lead.source === 'GEOAPIFY' && item.lead.sourceId && item.lead.provenance[0].metadata.properties), 'Live source identifiers and raw metadata are preserved');
    const cached = await request('/api/discovery/search', a, query);
    check(cached.status === 200 && cached.data.cached === true, 'Identical live search uses the free-tier cache');
    const candidate = discovery.data.rows.find(item => item.duplicate.kind === 'new');
    check(Boolean(candidate), 'Live discovery provides an unsaved normalized candidate');
    created.push({ client: a.client, id: candidate.lead.id });
    const liveSave = await request('/api/discovery/save', a, { previewId: discovery.data.id, selections: [{ id: candidate.lead.id, action: 'save' }] });
    const liveRead = await a.client.from('leads').select('source, source_id, provenance').eq('id', candidate.lead.id).single();
    check(liveSave.data.results[0].status === 'saved' && !liveRead.error && liveRead.data.source === 'GEOAPIFY' && liveRead.data.source_id === candidate.lead.sourceId, 'A live discovered lead persists remotely');
    console.log('Live source preview count: ' + discovery.data.rows.length);
  }
} catch {
  // The checkpoint contains only static labels; never emit SDK errors or credentials.
  console.error('FAIL: ' + checkpoint);
  process.exitCode = 1;
} finally {
  for (const row of created) {
    try {
      const result = await row.client.from('leads').delete().eq('id', row.id);
      if (result.error) { console.error('FAIL: Disposable lead cleanup'); process.exitCode = 1; }
    } catch { console.error('FAIL: Disposable lead cleanup'); process.exitCode = 1; }
  }
  for (const client of clients) { try { await client.auth.signOut({ scope: 'local' }); } catch { /* No persisted sessions. */ } }
  if (server) await new Promise(resolve => server.close(resolve));
}
