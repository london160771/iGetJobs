import type { ContactEnrichment } from '@igetjobs/shared';
import { RequestError } from '../discovery/errors.js';
import type { UsageStore } from '../discovery/usage.js';

export function usableEmail(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 254 && /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[a-z0-9.-]+\.[a-z]{2,63}$/i.test(value);
}
export interface ContactAdapter { readonly configured: boolean; lookup(domain: string): Promise<Pick<ContactEnrichment, 'state' | 'email' | 'confidence'>> }
export class HunterAdapter implements ContactAdapter {
  readonly configured: boolean;
  private busy = false;
  constructor(private key: string | null, private store: UsageStore, private limit = 10, private transport: typeof fetch = fetch, private now = () => Date.now()) {
    this.configured = Boolean(key);
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error('HUNTER_MONTHLY_LIMIT must be an integer from 1 to 50.');
  }
  private async json(path: string, query: Record<string, string> = {}): Promise<Record<string, unknown>> {
    try {
      const url = new URL('https://api.hunter.io/v2/' + path);
      for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
      const response = await this.transport(url, { headers: { 'X-API-KEY': this.key! }, redirect: 'error', signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new RequestError(response.status === 429 || response.status === 403 ? 429 : 502, 'Hunter lookup was unavailable or rate limited.');
      const reader = response.body?.getReader();
      if (!reader) throw new Error();
      const chunks: Uint8Array[] = []; let size = 0;
      while (true) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.byteLength; if (size > 65536) { await reader.cancel(); throw new Error(); } chunks.push(chunk.value); }
      const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString());
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !('data' in parsed) || !parsed.data || typeof parsed.data !== 'object' || Array.isArray(parsed.data)) throw new Error();
      return parsed.data as Record<string, unknown>;
    } catch (error) { if (error instanceof RequestError) throw error; throw new RequestError(502, 'Hunter lookup could not be verified. No contact was accepted.'); }
  }
  async lookup(domain: string): Promise<Pick<ContactEnrichment, 'state' | 'email' | 'confidence'>> {
    if (!this.key) throw new RequestError(503, 'Hunter is not configured. Existing contacts and manual drafts remain available.');
    if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(domain) || domain.length > 253) throw new RequestError(400, 'A recorded public business domain is required.');
    if (this.busy) throw new RequestError(429, 'Another Hunter lookup is running.');
    this.busy = true;
    try {
      const usage = await this.store.load(), previous = usage.HUNTER, period = new Date(this.now()).toISOString().slice(0,7);
      if (previous && this.now() - previous.lastCall < 5000) throw new RequestError(429, 'Wait five seconds before another Hunter lookup.');
      const count = previous?.period === period ? previous.count : 0;
      if (count >= this.limit) throw new RequestError(429, 'The local monthly Hunter attempt cap is exhausted.');
      usage.HUNTER = { period, count: count + 1, lastCall: this.now() };
      await this.store.save(usage); // Reserve before network I/O; failures/no-result consume attempts.
      const account = await this.json('account');
      if (account.plan_name !== 'Free' || (account.plan_level !== undefined && account.plan_level !== 0)) throw new RequestError(403, 'Only a verified Hunter Free account is allowed.');
      const requests = account.requests as Record<string, unknown> | undefined;
      const credits = (requests?.credits || requests?.searches) as Record<string, unknown> | undefined;
      if (!credits || typeof credits.remaining !== 'number' || !Number.isFinite(credits.remaining) || credits.remaining < 1
        || typeof credits.available !== 'number' || !Number.isFinite(credits.available) || credits.available < 1 || credits.available > 50
        || credits.remaining > credits.available) throw new RequestError(429, 'Hunter free credits are exhausted or cannot be verified.');
      // One generic contact only: no pagination, verification charge, company guess or retry.
      const data = await this.json('domain-search', { domain, limit: '1', type: 'generic' });
      if (typeof data.domain !== 'string' || data.domain.toLowerCase().replace(/^www\./,'') !== domain) throw new RequestError(502, 'Hunter returned a mismatched domain. No contact was accepted.');
      if (!Array.isArray(data.emails)) throw new RequestError(502, 'Hunter returned invalid contact data.');
      const email = data.emails[0] as Record<string, unknown> | undefined;
      if (!email || !usableEmail(email.value) || email.value.split('@')[1]?.toLowerCase() !== domain || email.type !== 'generic'
        || typeof email.confidence !== 'number' || !Number.isFinite(email.confidence) || email.confidence < 80 || email.confidence > 100)
        return { state: 'no_result' };
      return { state: 'found', email: email.value.toLowerCase(), confidence: email.confidence };
    } finally { this.busy = false; }
  }
}
