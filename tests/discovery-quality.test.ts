import assert from 'node:assert/strict';
import test from 'node:test';
import type { DiscoveryPreview } from '@igetjobs/shared';
import { normalizeLead } from '../apps/api/src/discovery/normalize.js';
import { discoveryQuality } from '../apps/api/src/discovery/quality.js';
import { duplicateCheck } from '../apps/api/src/discovery/dedupe.js';
import { initialPreviewChoices, selectedPreviewChoices } from '../apps/web/src/discovery-selection.js';

const record = (extra: Record<string, unknown> = {}) => normalizeLead({ businessName: 'Example Dentist', city: 'Bath', country: 'GB', sourceId: 'place-1', metadata: {}, ...extra }, 'GEOAPIFY').lead;

test('new and duplicate preview rows all start at Skip with selected count zero', () => {
  const first = record({ website: 'example.com' });
  const second = { ...record({ phone: '+442079460018' }), id: 'second' };
  const preview: DiscoveryPreview = { id: 'preview', expiresAt: new Date().toISOString(), attribution: '', cached: false, warnings: [], rows: [
    { lead: first, warnings: [], duplicate: duplicateCheck(first, []), ...discoveryQuality(first) },
    { lead: second, warnings: [], duplicate: duplicateCheck(second, [first]), ...discoveryQuality(second) }
  ] };
  assert.equal(preview.rows[0]!.duplicate.kind, 'new');
  assert.equal(preview.rows[1]!.duplicate.kind, 'exact');
  const choices = initialPreviewChoices(preview);
  assert.deepEqual(choices, { [first.id]: 'skip', [second.id]: 'skip' });
  assert.equal(selectedPreviewChoices(choices, {}).length, 0);
  choices[first.id] = 'save';
  assert.equal(selectedPreviewChoices(choices, {}).length, 1);
  assert.equal(selectedPreviewChoices(choices, { [first.id]: { status: 'saved' } }).length, 0);
});

test('discovery signals use source evidence without assigning an audit classification or score', () => {
  const phone = record({ phone: '+442079460018' });
  const email = record({ email: 'hello@example.com' });
  const social = record({ socials: { instagram: 'https://instagram.com/example' } });
  const empty = record();
  const website = record({ website: 'https://example.com' });
  const websiteWithPhone = record({ website: 'example.com', phone: '+442079460018' });
  for (const lead of [phone, email, social]) assert.deepEqual(discoveryQuality(lead), { discoverySignal: 'STRONG_DISCOVERY_SIGNAL', contactable: true });
  assert.deepEqual(discoveryQuality(empty), { discoverySignal: 'NEEDS_CONTACT_ENRICHMENT', contactable: false });
  assert.deepEqual(discoveryQuality(website), { discoverySignal: 'WEBSITE_PRESENT', contactable: false });
  assert.deepEqual(discoveryQuality(websiteWithPhone), { discoverySignal: 'WEBSITE_PRESENT', contactable: true });
  for (const lead of [phone, email, social, empty, website, websiteWithPhone]) {
    assert.equal(lead.classification, null);
    assert.equal(lead.score, null);
    assert.equal(lead.audit, null);
  }
});

test('preserved or malformed website evidence requires review instead of a false no-website signal', () => {
  const preserved = record({ website: ['bad', 'https://example.com'], metadata: { website: ['bad', 'https://example.com'] } });
  const malformed = record({ website: { url: 'https://example.com' } });
  assert.equal(discoveryQuality(preserved).discoverySignal, 'WEBSITE_EVIDENCE_REVIEW');
  assert.equal(discoveryQuality(malformed).discoverySignal, 'WEBSITE_EVIDENCE_REVIEW');
});
