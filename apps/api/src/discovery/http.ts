import { RequestError } from './errors.js';
export async function fetchJson(url: string | URL, init: RequestInit, transport: typeof fetch = fetch): Promise<Record<string, unknown>> {
  try {
    const response = await transport(url, { ...init, signal: AbortSignal.timeout(35000), redirect: 'error' });
    if (!response.ok) throw new RequestError(response.status === 429 ? 429 : 502, response.status === 429 ? 'The discovery source is rate limited. Please try again later.' : 'The discovery source could not complete this request.');
    const reader = response.body?.getReader();
    if (!reader) throw new RequestError(502, 'The discovery source returned an empty response.');
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > 8 * 1024 * 1024) { await reader.cancel(); throw new RequestError(502, 'The discovery response is too large. Try a smaller city.'); }
      chunks.push(result.value);
    }
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString());
    if (!value || typeof value !== 'object') throw new RequestError(502, 'The discovery source returned an invalid response.');
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof RequestError) throw error;
    // Provider URLs can contain keys; never forward errors or response bodies.
    throw new RequestError(502, 'The discovery source is unavailable or timed out. Please try again later.');
  }
}
