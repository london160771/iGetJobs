import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import type { Lead, LeadSource } from '@igetjobs/shared';
import { sanitizeHttpUrl, websiteUrl } from './discovery/normalize.js';
import { RequestError } from './discovery/errors.js';

export interface WebsiteEvidence { url: string; source: LeadSource; sourceId: string | null; path: string }
// Source linking deliberately preserves canonical contact fields. Future audits must
// consider these alternatives and explicitly resolve conflicts, not assume null = no site.
export function collectWebsiteEvidence(lead: Lead): WebsiteEvidence[] {
  const evidence: WebsiteEvidence[] = [];
  function add(value: unknown, source: LeadSource, sourceId: string | null, path: string) {
    const url = websiteUrl(value);
    if (url) evidence.push({ url, source, sourceId, path });
  }
  add(lead.website, lead.source, lead.sourceId, 'website');
  for (const entry of lead.provenance) {
    const metadata = entry.metadata || {};
    add(metadata.website, entry.source, entry.sourceId, 'metadata.website');
    const fields = entry.source === 'OSM' ? metadata.tags : entry.source === 'CSV' ? metadata.fields : null;
    if (fields && typeof fields === 'object' && !Array.isArray(fields)) {
      for (const [key, value] of Object.entries(fields)) {
        const name = key.toLowerCase().replace(/[_\s-]/g, '');
        if (['website', 'domain', 'contact:website'].includes(name)) add(value, entry.source, entry.sourceId, 'metadata.' + (entry.source === 'OSM' ? 'tags.' : 'fields.') + key);
      }
    }
  }
  return evidence;
}

const blocked = new BlockList();
// Conservatively exclude special-purpose IPv4 ranges, including cloud metadata.
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]
] as const) blocked.addSubnet(address, prefix, 'ipv4');
blocked.addAddress('168.63.129.16', 'ipv4'); // Azure platform virtual address.
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
for (const [address, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]] as const) blocked.addSubnet(address, prefix, 'ipv6');

export function isPublicWebsiteAddress(address: string): boolean {
  const family = isIP(address);
  return family === 4 ? !blocked.check(address, 'ipv4')
    : family === 6 && globalV6.check(address, 'ipv6') && !blocked.check(address, 'ipv6');
}
export interface WebsiteAddress { address: string; family: number }
export type WebsiteResolver = (hostname: string) => Promise<WebsiteAddress[]>;
export interface ValidatedWebsiteDestination { url: string; hostname: string; addresses: WebsiteAddress[] }

// Validation only: no website HTTP requests are made here. A future transport MUST
// pin one returned address while keeping the original Host/TLS name, and validate
// every redirect afresh. Ordinary fetch(url) would re-resolve DNS and is unsafe.
export async function validateWebsiteDestination(input: string, resolve: WebsiteResolver = hostname => lookup(hostname, { all: true, verbatim: true })): Promise<ValidatedWebsiteDestination> {
  const denied = () => new RequestError(400, 'Website destination is not an allowed public HTTP(S) address.');
  let url: URL;
  try { url = new URL(input); } catch { throw denied(); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || (url.port && !['80', '443'].includes(url.port))) throw denied();
  const hostname = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (!hostname || hostname.includes('%') || (!isIP(hostname) && (!hostname.includes('.') || /(?:^|\.)(?:localhost|local|internal|intranet|lan|home|corp|test|invalid|example|onion)$/.test(hostname) || hostname.endsWith('.home.arpa')))) throw denied();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let addresses: WebsiteAddress[];
  try {
    addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }]
      : await Promise.race([
        resolve(hostname),
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(denied()), 5000); })
      ]);
  } catch { throw denied(); } finally { if (timer) clearTimeout(timer); }
  if (!addresses.length || addresses.some(item => item.family !== isIP(item.address) || !isPublicWebsiteAddress(item.address))) throw denied();
  return { url: sanitizeHttpUrl(url), hostname, addresses };
}
