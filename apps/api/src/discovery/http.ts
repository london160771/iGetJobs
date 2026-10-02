import { RequestError } from './errors.js';
export async function fetchJson(url: string | URL, init: RequestInit, transport: typeof fetch = fetch, stage?: 'OSM_CITY' | 'OSM_BUSINESSES'): Promise<Record<string, unknown>> {
  let upstreamStatus: number | undefined;
  try {
    const response = await transport(url, { ...init, signal: AbortSignal.timeout(35000), redirect: 'error' });
    if (!response.ok) { upstreamStatus=response.status; throw new RequestError(response.status === 429 ? 429 : 502, response.status === 429 ? 'The discovery source is rate limited. Please try again later.' : 'The discovery source could not complete this request.'); }
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
    if (stage) {
      // Fixed stage/category only: never log URLs, bodies, keys or raw errors.
      const code = error instanceof Error && 'cause' in error && error.cause && typeof error.cause === 'object' && 'code' in error.cause ? error.cause.code : undefined;
      const category = upstreamStatus ? 'HTTP_'+upstreamStatus : typeof code === 'string' && ['ENOTFOUND','EAI_AGAIN','ECONNREFUSED','ECONNRESET','ENETUNREACH','UND_ERR_CONNECT_TIMEOUT','ETIMEDOUT','CERT_HAS_EXPIRED','UNABLE_TO_VERIFY_LEAF_SIGNATURE','ERR_TLS_CERT_ALTNAME_INVALID'].includes(code) ? code
        : error instanceof RequestError ? 'HTTP_OR_RESPONSE' : error instanceof SyntaxError ? 'INVALID_JSON' : error instanceof Error && ['TimeoutError','AbortError'].includes(error.name) ? 'TIMEOUT' : 'NETWORK';
      if (process.env.NODE_ENV === 'production') console.warn('[discovery] ' + stage + ' ' + category);
    }
    const prefix = stage === 'OSM_CITY' ? 'OpenStreetMap city lookup: ' : stage === 'OSM_BUSINESSES' ? 'OpenStreetMap business search: ' : '';
    if (error instanceof RequestError) throw new RequestError(error.status,prefix+error.message);
    // Provider URLs can contain keys; never forward errors or response bodies.
    throw new RequestError(502, prefix+'The discovery source is unavailable or timed out. Please try again later.');
  }
}
