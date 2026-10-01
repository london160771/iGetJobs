import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type RequestOptions } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { LookupFunction } from 'node:net';
import { performance } from 'node:perf_hooks';
import { validateWebsiteDestination, WebsiteDestinationError, type ValidatedWebsiteDestination, type WebsiteResolver } from '../website-safety.js';

export const fetchLimits = { redirects: 3, requestMs: 8000, totalMs: 20000, bytes: 1024 * 1024 };
export class WebsiteFetchError extends Error {
  constructor(readonly kind: 'blocked' | 'dns' | 'network' | 'timeout' | 'too_large' | 'encoding' | 'redirect', message: string) { super(message); }
}
export interface WebsiteResponse { status: number; headers: IncomingHttpHeaders; body: string; bytes: number }
export interface WebsiteFetchResult extends WebsiteResponse { url: string; durationMs: number; redirects: number }
export type PinnedTransport = (destination: ValidatedWebsiteDestination, signal: AbortSignal) => Promise<WebsiteResponse>;

export function pinnedRequestOptions(destination: ValidatedWebsiteDestination, signal: AbortSignal) {
  const url = new URL(destination.url);
  const pinned = destination.addresses[0]!;
  // No resolver is called here. Disable family selection so Node cannot perform
  // a second lookup; a fresh non-pooled connection uses exactly this approved IP.
  const lookup: LookupFunction = (_hostname, _options, callback) => callback(null, pinned.address, pinned.family);
  return {
    protocol: url.protocol, hostname: destination.hostname, port: url.port || (url.protocol === 'https:' ? 443 : 80),
    path: url.pathname + url.search, method: 'GET', agent: false as const, lookup, autoSelectFamily: false,
    servername: destination.hostname, rejectUnauthorized: true, signal, maxHeaderSize: 16384,
    headers: { Host: url.host, Accept: 'text/html,application/xhtml+xml', 'Accept-Encoding': 'identity', 'User-Agent': 'iGetJobs/1.0 website audit (https://github.com/london160771/iGetJobs)' }
  } satisfies RequestOptions & { autoSelectFamily: boolean; servername: string; rejectUnauthorized: boolean };
}

export function readWebsiteResponse(response: IncomingMessage): Promise<WebsiteResponse> {
  return new Promise((resolve, reject) => {
    const status = response.statusCode || 0;
    // Do not consume redirect/error payloads. Never follow a Location in transport.
    if (status >= 300) { response.destroy(); resolve({ status, headers: response.headers, body: '', bytes: 0 }); return; }
    if (response.headers['content-encoding'] && response.headers['content-encoding'].toLowerCase() !== 'identity') {
      response.destroy(); reject(new WebsiteFetchError('encoding', 'Compressed website response was declined.')); return;
    }
    const declared = Number(response.headers['content-length']);
    if (Number.isFinite(declared) && declared > fetchLimits.bytes) { response.destroy(); reject(new WebsiteFetchError('too_large', 'Website response exceeds 1MB.')); return; }
    const chunks: Buffer[] = []; let bytes = 0;
    response.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > fetchLimits.bytes) { reject(new WebsiteFetchError('too_large', 'Website response exceeds 1MB.')); response.destroy(); return; }
      chunks.push(chunk);
    });
    response.on('end', () => resolve({ status, headers: response.headers, body: Buffer.concat(chunks).toString('utf8'), bytes }));
    response.on('error', error => reject(error instanceof WebsiteFetchError ? error : new WebsiteFetchError('network', 'Website response could not be read.')));
    response.on('aborted', () => reject(new WebsiteFetchError('network', 'Website response ended early.')));
  });
}
export const pinnedTransport: PinnedTransport = (destination, signal) => new Promise((resolve, reject) => {
  const options = pinnedRequestOptions(destination, signal);
  const send = options.protocol === 'https:' ? httpsRequest : httpRequest;
  const aborted = () => reject(new WebsiteFetchError('timeout', 'Website audit timed out.'));
  signal.addEventListener('abort', aborted, { once: true });
  const request = send(options, response => { void readWebsiteResponse(response).then(resolve, reject); });
  const timer = setTimeout(() => { reject(new WebsiteFetchError('timeout', 'Website request timed out.')); request.destroy(); }, fetchLimits.requestMs);
  request.on('close', () => { clearTimeout(timer); signal.removeEventListener('abort', aborted); });
  request.on('error', error => reject(error instanceof WebsiteFetchError ? error : new WebsiteFetchError(signal.aborted ? 'timeout' : 'network', signal.aborted ? 'Website audit timed out.' : 'Website connection failed.')));
  request.end();
});

export async function fetchWebsite(input: string, dependencies: { resolve?: WebsiteResolver; transport?: PinnedTransport } = {}): Promise<WebsiteFetchResult> {
  const started = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), fetchLimits.totalMs);
  let current = input;
  try {
    for (let hop = 0; hop <= fetchLimits.redirects; hop++) {
      let destination: ValidatedWebsiteDestination;
      try { destination = await validateWebsiteDestination(current, dependencies.resolve, controller.signal); }
      catch (error) {
        if (controller.signal.aborted) throw new WebsiteFetchError('timeout', 'Website audit timed out.');
        throw new WebsiteFetchError(error instanceof WebsiteDestinationError && error.kind === 'dns' ? 'dns' : 'blocked', error instanceof WebsiteDestinationError && error.kind === 'dns' ? 'Website DNS lookup failed.' : 'Unsafe website destination was blocked.');
      }
      if (controller.signal.aborted) throw new WebsiteFetchError('timeout', 'Website audit timed out.');
      const response = await (dependencies.transport || pinnedTransport)(destination, controller.signal);
      if (controller.signal.aborted) throw new WebsiteFetchError('timeout', 'Website audit timed out.');
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        if (hop === fetchLimits.redirects || !response.headers.location) throw new WebsiteFetchError('redirect', 'Website redirect limit or missing destination.');
        let next: URL;
        try { next = new URL(response.headers.location, destination.url); } catch { throw new WebsiteFetchError('redirect', 'Invalid website redirect.'); }
        // Validate the original Location before sanitizing so userinfo cannot vanish
        // before the guard checks it. No cookies/auth headers follow redirects.
        current = next.href;
        continue;
      }
      return { ...response, url: destination.url, durationMs: Math.round(performance.now() - started), redirects: hop };
    }
    throw new WebsiteFetchError('redirect', 'Website redirect limit reached.');
  } finally { clearTimeout(timer); }
}
