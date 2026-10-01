import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import type { Lead, LeadSource, WebsiteResolution } from '@igetjobs/shared';
import { sanitizeHttpUrl, websiteUrl } from './discovery/normalize.js';
import { RequestError } from './discovery/errors.js';

export interface WebsiteEvidence { url: string; source: LeadSource; sourceId: string | null; path: string }
// Source linking deliberately preserves canonical contact fields. Audits must
// consider these alternatives and explicitly resolve conflicts, not assume null = no site.
export function collectWebsiteEvidence(lead: Lead): WebsiteEvidence[] {
  return resolveWebsiteEvidence(lead).evidence.filter((item): item is WebsiteEvidence => item.url !== null);
}
export function resolveWebsiteEvidence(lead: Lead): WebsiteResolution {
  const evidence: WebsiteResolution['evidence'] = [];
  function add(value: unknown, source: LeadSource, sourceId: string | null, path: string) {
    if (typeof value !== 'string' || !value.trim()) return;
    const url = websiteUrl(value);
    evidence.push({ url, source, sourceId, path });
  }
  add(lead.website, lead.source, lead.sourceId, 'website');
  for (const entry of lead.provenance) {
    const metadata = entry.metadata || {};
    const start = evidence.length;
    add(metadata.website, entry.source, entry.sourceId, 'metadata.website');
    const fields = entry.source === 'OSM' ? metadata.tags : entry.source === 'CSV' ? metadata.fields : null;
    if (fields && typeof fields === 'object' && !Array.isArray(fields)) {
      for (const [key, value] of Object.entries(fields)) {
        const name = key.toLowerCase().replace(/[_\s-]/g, '');
        if (['website', 'domain', 'contact:website'].includes(name)) add(value, entry.source, entry.sourceId, 'metadata.' + (entry.source === 'OSM' ? 'tags.' : 'fields.') + key);
      }
    }
    if (metadata.websiteEvidenceInvalid === true && !evidence.slice(start).some(item => item.url === null)) evidence.push({ url: null, source: entry.source, sourceId: entry.sourceId, path: 'metadata.websiteEvidenceInvalid' });
  }
  const candidates = [...new Set(evidence.flatMap(item => item.url ? [item.url] : []))];
  const invalidCount = evidence.filter(item => !item.url).length;
  return { evidence, candidates, invalidCount, requiresChoice: candidates.length > 1 || invalidCount > 0 };
}

export class WebsiteDestinationError extends RequestError {
  constructor(readonly kind: 'blocked' | 'dns') { super(400, kind === 'dns' ? 'Website DNS lookup failed.' : 'Website destination is not an allowed public HTTP(S) address.'); }
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

// Validation only: no website HTTP requests are made here. The transport MUST
// pin one returned address while keeping the original Host/TLS name, and validate
// every redirect afresh. Ordinary fetch(url) would re-resolve DNS and is unsafe.
export async function validateWebsiteDestination(input: string, resolve: WebsiteResolver = hostname => lookup(hostname, { all: true, verbatim: true }), signal?: AbortSignal): Promise<ValidatedWebsiteDestination> {
  const denied = () => new WebsiteDestinationError('blocked');
  let url: URL;
  try { url = new URL(input); } catch { throw denied(); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || (url.port && !['80', '443'].includes(url.port))) throw denied();
  const hostname = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (!hostname || hostname.includes('%') || (!isIP(hostname) && (!hostname.includes('.') || /(?:^|\.)(?:localhost|local|internal|intranet|lan|home|corp|test|invalid|example|onion)$/.test(hostname) || hostname.endsWith('.home.arpa')))) throw denied();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let aborted: (() => void) | undefined;
  let addresses: WebsiteAddress[];
  try {
    if (signal?.aborted) throw denied();
    addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }]
      : await Promise.race([
        resolve(hostname),
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(denied()), 5000); }),
        ...(signal ? [new Promise<never>((_resolve, reject) => { aborted = () => reject(denied()); signal.addEventListener('abort', aborted, { once: true }); })] : [])
      ]);
  } catch { throw new WebsiteDestinationError('dns'); } finally { if (timer) clearTimeout(timer); if (aborted) signal?.removeEventListener('abort', aborted); }
  if (!addresses.length || addresses.some(item => item.family !== isIP(item.address) || !isPublicWebsiteAddress(item.address))) throw denied();
  return { url: sanitizeHttpUrl(url), hostname, addresses };
}
