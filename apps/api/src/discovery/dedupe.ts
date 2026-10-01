import type { DuplicateCheck, Lead } from '@igetjobs/shared';
export type LeadIdentity = Pick<Lead, 'id' | 'businessName' | 'domain' | 'phone' | 'address' | 'city' | 'country' | 'source' | 'sourceId'>;
const comparison = (value: string | null) => value?.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '') || '';
export function duplicateCheck(lead: LeadIdentity, candidates: LeadIdentity[], persistedIds = new Set(candidates.map(item => item.id))): DuplicateCheck {
  const matches: { id: string; exact: boolean; reason: string }[] = [];
  for (const existing of candidates) {
    const sameSource = Boolean(lead.sourceId && lead.source === existing.source && lead.sourceId === existing.sourceId);
    const domain = Boolean(lead.domain && lead.domain === existing.domain);
    const phone = Boolean(lead.phone && lead.phone === existing.phone);
    const name = Boolean(comparison(lead.businessName) && comparison(lead.businessName) === comparison(existing.businessName));
    const address = Boolean(comparison(lead.address) && comparison(lead.address) === comparison(existing.address));
    const locationConflict = Boolean(lead.country && existing.country && lead.country !== existing.country)
      || Boolean(lead.city && existing.city && comparison(lead.city) !== comparison(existing.city))
      || Boolean(lead.address && existing.address && comparison(lead.address) !== comparison(existing.address));
    const contactConflict = Boolean(lead.domain && existing.domain && lead.domain !== existing.domain)
      || Boolean(lead.phone && existing.phone && lead.phone !== existing.phone);
    if (sameSource || domain || phone || (name && address)) {
      const exact = name && (sameSource || address) && !locationConflict && !contactConflict;
      const reason = sameSource ? 'Same source identifier' : domain ? 'Matching domain' : phone ? 'Matching phone' : 'Matching business name and address';
      matches.push({ id: existing.id, exact, reason: reason + (locationConflict || contactConflict ? '; conflicting location/contact details require review' : '') });
    }
  }
  if (!matches.length) return { kind: 'new', matchIds: [], reasons: [], canLink: false, matches: [] };
  const exact = matches.length === 1 && matches[0]!.exact;
  return { kind: exact ? 'exact' : 'possible', matchIds: matches.map(item => item.id), reasons: [...new Set(matches.map(item => item.reason))], canLink: exact && persistedIds.has(matches[0]!.id),
    matches: matches.slice(0, 5).map(match => { const item = candidates.find(candidate => candidate.id === match.id)!; return { businessName: item.businessName, address: item.address, city: item.city, source: item.source, persisted: persistedIds.has(item.id) }; }) };
}
