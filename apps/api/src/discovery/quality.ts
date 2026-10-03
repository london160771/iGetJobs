import type { DiscoverySignal, Lead } from '@igetjobs/shared';
import { resolveWebsiteEvidence } from '../website-safety.js';

// Preview qualification describes source data only. Final classification and
// scores remain exclusively the result of an explicit website audit.
export function discoveryQuality(lead: Lead): { discoverySignal: DiscoverySignal; contactable: boolean } {
  const website = resolveWebsiteEvidence(lead);
  const contactable = Boolean(lead.phone || lead.email || Object.values(lead.socials).some(Boolean));
  if (website.candidates.length > 0 && !website.requiresChoice) return { discoverySignal: 'WEBSITE_PRESENT', contactable };
  if (website.requiresChoice) return { discoverySignal: 'WEBSITE_EVIDENCE_REVIEW', contactable };
  return { discoverySignal: contactable ? 'STRONG_DISCOVERY_SIGNAL' : 'NEEDS_CONTACT_ENRICHMENT', contactable };
}
