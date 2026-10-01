import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import type { Lead } from '@igetjobs/shared';
import type { SupabaseClient } from '@supabase/supabase-js';
import { normalizeLead, sanitizeMetadata, websiteUrl } from '../apps/api/src/discovery/normalize.js';
import { SupabaseLeadRepository, leadToRow, type LeadRepository } from '../apps/api/src/discovery/repository.js';
import { DiscoveryService } from '../apps/api/src/discovery/service.js';
import { ProviderGuard } from '../apps/api/src/discovery/usage.js';
import { RequestError } from '../apps/api/src/discovery/errors.js';
import { collectWebsiteEvidence, isPublicWebsiteAddress, validateWebsiteDestination } from '../apps/api/src/website-safety.js';

test('normalization removes credentials from canonical/social/metadata URLs, including fragments and unknown query keys', () => {
  const params = ['api_key', 'access_token', 'refresh-token', 'token', 'key', 'secret', 'auth', 'Authorization', 'password', 'signature', 'client_secret', 'unknown_credential'];
  const query = params.map(key => key + '=private-marker').join('&');
  const raw = 'https://example.com/contact?' + query + '&page=2&lang=en-GB&locale=fr#access_token=private-marker';
  const clean = 'https://example.com/contact?page=2&lang=en-GB&locale=fr';
  const lead = normalizeLead({ businessName: 'Safe Dental', website: raw, socials: { facebook: raw }, sourceId: 'safe', metadata: { website: raw, fields: { domain: raw.replace('https://', ''), token: 'private-marker' } } }, 'CSV').lead;
  assert.equal(lead.website, clean); assert.equal(lead.socials.facebook, clean);
  assert.equal(JSON.stringify(lead).includes('private-marker'), false);
  assert.deepEqual(lead.provenance[0]?.metadata, { website: clean, fields: { domain: clean } });
  assert.equal(websiteUrl('https://example.com/?page=private-marker&lang=private-marker&locale=private-marker'), 'https://example.com/');
  assert.equal(websiteUrl('https://user:private-marker@example.com/'), null);
  assert.equal(websiteUrl('https://example.com/?%61pi_key=private-marker&lang=en&lang=bad%20value'), 'https://example.com/');
  assert.deepEqual(sanitizeMetadata({ url: 'https://user:private-marker@example.com/#private-marker', nested: { KEY: 'private-marker' } }), { url: 'https://example.com/', nested: {} });
  assert.deepEqual(sanitizeMetadata({ website: 'user:private-marker@example.com/?token=private-marker', international: 'bücher.de/?api_key=private-marker', email: 'person@example.com' }), { website: 'https://example.com/', international: 'https://xn--bcher-kva.de/', email: 'person@example.com' });
});

test('protocol-relative contacts and nested provenance use the same filtering as absolute URLs', () => {
  const params = ['api_key', '%61ccess_token', 'token', 'key', 'secret', 'auth', 'password', 'unknown_credential'];
  const raw = '//example.com/contact?' + params.map(key => key + '=relative-credential-marker').join('&') + '&page=2&lang=en-GB#token=relative-credential-marker';
  const expected = 'https://example.com/contact?page=2&lang=en-GB';
  const metadata = { website: '  ' + raw + '  ', nested: [{ social: raw, extra: 'preserved' }] };
  assert.deepEqual(sanitizeMetadata(metadata), { website: expected, nested: [{ social: expected, extra: 'preserved' }] });
  assert.deepEqual(sanitizeMetadata({ url: raw }), sanitizeMetadata({ url: 'https:' + raw }));
  const lead = normalizeLead({ businessName: 'Relative Dental', website: raw, socials: { facebook: raw }, sourceId: 'relative-source', metadata }, 'CSV').lead;
  assert.equal(lead.website, expected); assert.equal(lead.socials.facebook, expected);
  assert.equal(lead.sourceId, 'relative-source');
  assert.equal(JSON.stringify(lead).includes('relative-credential-marker'), false);
  assert.deepEqual(sanitizeMetadata({ credentialed: '//user:relative-credential-marker@example.com/?token=relative-credential-marker&locale=fr', malformed: '//bad host/?key=relative-credential-marker' }), { credentialed: 'https://example.com/?locale=fr', malformed: null });
  assert.equal(websiteUrl('//user:relative-credential-marker@example.com/'), null);
});

test('CSV protocol-relative URLs remain sanitized through preview, save, and reload with safe provenance intact', async () => {
  const rows: Lead[] = [];
  const repository: LeadRepository = {
    identities: async () => structuredClone(rows), list: async () => structuredClone(rows),
    findById: async id => structuredClone(rows.find(row => row.id === id) || null),
    insert: async lead => { rows.push(structuredClone(lead)); return structuredClone(lead); },
    link: async () => { throw new Error('Unexpected source link'); }
  };
  const service = new DiscoveryService({}, () => repository, new ProviderGuard({ load: async () => ({}), save: async () => {} }));
  const csv = 'name,website,facebook,extra\nRelative Dental,//example.com/?api_key=relative-credential-marker&lang=en,//facebook.com/relative?token=relative-credential-marker&page=2,preserved';
  const preview = await service.importCsv('A', 'token', { csv, filename: 'relative.csv' });
  const lead = preview.rows[0]!.lead;
  assert.equal(JSON.stringify(preview).includes('relative-credential-marker'), false);
  assert.equal(lead.website, 'https://example.com/?lang=en');
  assert.equal(lead.socials.facebook, 'https://facebook.com/relative?page=2');
  const metadata = lead.provenance[0]!.metadata!;
  assert.deepEqual(metadata.fields, { name: 'Relative Dental', website: lead.website, facebook: lead.socials.facebook, extra: 'preserved' });
  assert.equal(metadata.filename, 'relative.csv'); assert.equal(metadata.rowNumber, 2);
  const saved = await service.save('A', 'token', { previewId: preview.id, selections: [{ id: lead.id, action: 'save' }] });
  assert.equal(saved.results[0]?.status, 'saved');
  const reloaded = await service.list('A', 'token');
  assert.deepEqual(reloaded[0]?.provenance, lead.provenance);
  assert.equal(JSON.stringify(leadToRow(reloaded[0]!, 'A')).includes('relative-credential-marker'), false);
  assert.equal(reloaded[0]?.sourceId, lead.sourceId);
});

test('lost insert responses reconcile by owner + server preview ID without duplicate inserts, including separate saves', async () => {
  for (const action of ['save', 'separate'] as const) {
    const rows = new Map<string, Lead[]>(); let inserts = 0;
    const repository = (owner: string): LeadRepository => {
      if (!rows.has(owner)) rows.set(owner, []);
      return {
        identities: async () => structuredClone(rows.get(owner)!), list: async () => structuredClone(rows.get(owner)!),
        findById: async id => structuredClone(rows.get(owner)!.find(item => item.id === id) || null),
        insert: async lead => { inserts++; rows.get(owner)!.push(structuredClone(lead)); throw new RequestError(503, 'Response lost'); },
        link: async () => { throw new Error('Unexpected link'); }
      };
    };
    const service = new DiscoveryService({}, repository, new ProviderGuard({ load: async () => ({}), save: async () => {} }));
    const preview = await service.importCsv('A', 'token', { csv: 'name,address,website\nDental,1 Main Street,example.com' });
    const id = preview.rows[0]!.lead.id;
    // A row with the same ID belonging to B must not authorize A's reconciliation.
    rows.set('B', [{ ...preview.rows[0]!.lead, businessName: 'Foreign record' }]);
    const input = { previewId: preview.id, selections: [{ id, action }] };
    const first = await service.save('A', 'token', input);
    assert.equal(first.results[0]?.status, 'failed'); assert.equal(inserts, 1);
    const retry = await service.save('A', 'token', input);
    assert.deepEqual(retry.results, [{ rowId: id, status: 'saved', leadId: id }]);
    assert.deepEqual(await service.save('A', 'token', input), retry);
    assert.equal(inserts, 1); assert.equal(rows.get('A')?.length, 1);
    assert.equal(rows.get('B')?.[0]?.businessName, 'Foreign record');
    await assert.rejects(service.save('B', 'token', input), error => error instanceof RequestError && error.status === 410);
  }
});

test('repository reconciliation reads require owner and ID and fail closed on database errors', async () => {
  const filters: [string, unknown][] = [];
  let fail = false;
  const query = { select: () => query, eq: (key: string, value: unknown) => { filters.push([key, value]); return query; }, maybeSingle: async () => ({ data: null, error: fail ? { message: 'private database detail' } : null }) };
  const repository = new SupabaseLeadRepository({ from: () => query } as unknown as SupabaseClient, 'A');
  assert.equal(await repository.findById('preview-id'), null);
  assert.deepEqual(filters, [['owner_id', 'A'], ['id', 'preview-id']]);
  fail = true;
  await assert.rejects(repository.findById('preview-id'), error => error instanceof RequestError && error.status === 503 && !error.message.includes('private database detail'));
});

test('repeated provenance links survive actual JSONB reordering without losing genuinely changed metadata', async () => {
  const db = new PGlite();
  try {
    const original = normalizeLead({ businessName: 'Dental', sourceId: 'row-1', metadata: { filename: 'same.csv', fields: { country: 'GB', name: 'Dental' }, nested: [{ z: 2, a: 1 }] } }, 'CSV').lead;
    let row: Record<string, unknown> = leadToRow(original, 'A');
    async function jsonb(value: typeof row): Promise<typeof row> {
      const result = await db.query<{ value: typeof row }>('select $1::jsonb as value', [JSON.stringify(value)]);
      return result.rows[0]!.value;
    }
    row = await jsonb(row);
    assert.notEqual(JSON.stringify(row.provenance), JSON.stringify(original.provenance));
    const filters: [string, unknown][] = [];
    let pending: Record<string, unknown> = {};
    const query = {
      select: () => query, eq: (key: string, value: unknown) => { filters.push([key, value]); return query; },
      single: async () => ({ data: structuredClone(row), error: null }),
      update: (value: Record<string, unknown>) => { pending = value; return query; },
      maybeSingle: async () => { row = await jsonb({ ...row, ...pending }); return { data: structuredClone(row), error: null }; }
    };
    const repository = new SupabaseLeadRepository({ from: () => query } as unknown as SupabaseClient, 'A');
    for (let i = 0; i < 4; i++) {
      assert.equal((await repository.link(original.id, original.provenance)).provenance.length, 1);
    }
    assert.ok(filters.some(([key, value]) => key === 'owner_id' && value === 'A'));
    const changed = structuredClone(original.provenance);
    changed[0]!.metadata!.filename = 'different.csv';
    assert.equal((await repository.link(original.id, changed)).provenance.length, 2);
    assert.equal((await repository.link(original.id, changed)).provenance.length, 2);
    const changedArray = structuredClone(original.provenance);
    changedArray[0]!.metadata!.nested = [{ z: 3, a: 1 }];
    assert.equal((await repository.link(original.id, changedArray)).provenance.length, 3);
  } finally { await db.close(); }
});

test('future audits can see sanitized canonical and linked-source website evidence without auto-selecting it', () => {
  const lead = normalizeLead({ businessName: 'Dental', sourceId: 'csv-1', metadata: { fields: { Website: 'csv.example.com/?token=private-marker' } } }, 'CSV').lead;
  lead.provenance.push({ source: 'OSM', sourceId: 'node/1', metadata: { tags: { 'contact:website': 'https://osm.example.com/?lang=en' } } });
  lead.provenance.push({ source: 'SERPAPI', sourceId: 'place-1', metadata: { website: 'https://serp.example.com/', url: 'https://maps.example.com/' } });
  const evidence = collectWebsiteEvidence(lead);
  assert.equal(lead.website, null);
  assert.deepEqual(evidence.map(item => [item.url, item.sourceId]), [['https://csv.example.com/', 'csv-1'], ['https://osm.example.com/?lang=en', 'node/1'], ['https://serp.example.com/', 'place-1']]);
  assert.equal(evidence.some(item => item.url.includes('maps.')), false);
  lead.website = 'https://canonical.example.com/';
  assert.equal(collectWebsiteEvidence(lead)[0]?.path, 'website');
});

test('website destination validation blocks private/internal/metadata targets before DNS or any HTTP fetching', async () => {
  let resolutions = 0;
  const publicResolver = async () => { resolutions++; return [{ address: '93.184.216.34', family: 4 }]; };
  for (const target of [
    'http://localhost/', 'http://localhost./', 'http://singlehost/', 'http://a.internal/', 'http://a.local/', 'http://a.home.arpa/',
    'http://metadata.google.internal/', 'http://127.0.0.1/', 'http://2130706433/', 'http://0x7f000001/', 'http://127.1/',
    'http://10.1.2.3/', 'http://172.16.0.1/', 'http://192.168.1.1/', 'http://169.254.169.254/latest/meta-data/',
    'http://100.100.100.200/', 'http://168.63.129.16/', 'http://0.0.0.0/', 'http://224.0.0.1/',
    'http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'http://[fd00::1]/', 'http://[fe80::1]/',
    'http://[2002:7f00:1::]/', 'file:///etc/passwd', 'https://user:pass@public.com/', 'http://public.com:3001/'
  ]) {
    const before = resolutions;
    await assert.rejects(validateWebsiteDestination(target, publicResolver), error => error instanceof RequestError && error.status === 400);
    assert.equal(resolutions, before, target);
  }
  for (const answers of [[], [{ address: '127.0.0.1', family: 4 }], [{ address: '93.184.216.34', family: 4 }, { address: '::1', family: 6 }], [{ address: '93.184.216.34', family: 6 }]]) {
    await assert.rejects(validateWebsiteDestination('https://public.com/', async () => answers));
  }
  await assert.rejects(validateWebsiteDestination('https://public.com/', async () => { throw new Error('private DNS detail'); }), error => error instanceof RequestError && !error.message.includes('DNS detail'));
  const safe = await validateWebsiteDestination('https://public.com/?token=private-marker&lang=en', publicResolver);
  assert.equal(safe.url, 'https://public.com/?lang=en'); assert.equal(safe.hostname, 'public.com');
  assert.deepEqual(safe.addresses, [{ address: '93.184.216.34', family: 4 }]);
  assert.equal(isPublicWebsiteAddress('2606:4700:4700::1111'), true);
  assert.equal((await validateWebsiteDestination('https://[2606:4700:4700::1111]/')).addresses[0]?.family, 6);
});
