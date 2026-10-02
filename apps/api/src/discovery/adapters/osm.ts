import type { DiscoveryQuery } from '@igetjobs/shared';
import type { Collection, SourceAdapter } from './types.js';
import type { Niche } from '../config.js';
import { DiscoveryTransportError, fetchJson } from '../http.js';
import { RequestError } from '../errors.js';

const headers = { 'User-Agent': 'iGetJobs/1.0 (+https://github.com/london160771/iGetJobs)', Accept: 'application/json' };
export const approvedOverpassEndpoints = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter'] as const;
export const defaultOsmEndpoints = { nominatim: 'https://nominatim.openstreetmap.org/search', overpass: [...approvedOverpassEndpoints] as string[] };
export function osmEndpoints(env: NodeJS.ProcessEnv) {
  if (env.OSM_OVERPASS_URLS?.trim() && env.OSM_OVERPASS_URL?.trim()) throw new Error('Configure only one Overpass endpoint setting.');
  const preferred = env.OSM_OVERPASS_URL?.trim();
  const overpass = env.OSM_OVERPASS_URLS?.trim() ? env.OSM_OVERPASS_URLS.split(',').map(value => value.trim())
    : preferred ? [preferred, ...approvedOverpassEndpoints.filter(value => value !== preferred)] : [...approvedOverpassEndpoints];
  return { nominatim: env.OSM_NOMINATIM_URL?.trim() || defaultOsmEndpoints.nominatim, overpass };
}
interface OsmRuntime { now?: () => number; sleep?: (ms: number) => Promise<void>; reserveRetry?: () => Promise<void> }
interface Place { boundingbox: string[]; address?: { country_code?: string }; display_name?: string }
export class OsmAdapter implements SourceAdapter {
  readonly source = 'OSM';
  private cities = new Map<string, { bbox: number[]; expires: number }>();
  private cityPending = new Map<string, Promise<number[]>>();
  private cityQueue: Promise<void> = Promise.resolve();
  private nextCityRequest = 0;
  private cooldowns = new Map<string, number>();
  private now: () => number;
  private sleep: (ms: number) => Promise<void>;
  constructor(private niches: Niche[], private transport: typeof fetch = fetch, private endpoints = defaultOsmEndpoints, private runtime: OsmRuntime = {}) {
    this.now = runtime.now || Date.now;
    this.sleep = runtime.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
    if (!endpoints.overpass.length || endpoints.overpass.length > 2 || new Set(endpoints.overpass).size !== endpoints.overpass.length
      || endpoints.overpass.some(endpoint => !approvedOverpassEndpoints.some(approved => approved === endpoint))) throw new Error('Overpass must use one or two distinct approved public interpreter endpoints.');
    for (const endpoint of [endpoints.nominatim, ...endpoints.overpass]) {
      let url: URL;
      try { url = new URL(endpoint); } catch { throw new Error('OSM endpoints must be HTTPS URLs without credentials, query strings, or fragments.'); }
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('OSM endpoints must be HTTPS URLs without credentials, query strings, or fragments.');
    }
  }
  private async request(endpoints: string[], init: RequestInit, stage: 'OSM_CITY' | 'OSM_BUSINESSES', deadline: number, transport = this.transport) {
    const cooldownKey = (endpoint: string) => stage === 'OSM_CITY' ? this.endpoints.nominatim : endpoint;
    const available = endpoints.filter(endpoint => (this.cooldowns.get(cooldownKey(endpoint)) || 0) <= this.now());
    if (!available.length) throw new RequestError(429, 'OpenStreetMap is cooling down. Please try again later.');
    // At most two attempts. Every retry/fallback is charged before network I/O.
    for (let attempt = 0; attempt < 2; attempt++) {
      const endpoint = available[attempt % available.length]!;
      const remaining = deadline - this.now();
      if (remaining <= 0) throw new RequestError(502, 'OpenStreetMap request deadline reached. Please try again later.');
      try {
        return await fetchJson(endpoint, init, transport, stage, {
          timeoutMs: Math.min(stage === 'OSM_CITY' ? 10000 : 30000, remaining),
          endpointLabel: stage === 'OSM_BUSINESSES' ? new URL(endpoint).hostname : 'nominatim'
        });
      } catch (error) {
        if (!(error instanceof DiscoveryTransportError)) throw error;
        const wait = Math.max(error.category === 'HTTP_429' ? 30000 : 15000, error.retryAfterMs);
        if (error.category === 'HTTP_429') this.cooldowns.set(cooldownKey(endpoint), this.now() + wait);
        const alternateInstance = stage === 'OSM_BUSINESSES' && available.length > 1 && ['HTTP_403','HTTP_404'].includes(error.category);
        if ((!error.retryable && !alternateInstance) || attempt === 1 || !this.runtime.reserveRetry || wait + 1000 >= deadline - this.now()) throw error;
        await this.sleep(wait);
        if (deadline <= this.now()) throw error;
        await this.runtime.reserveRetry();
      }
    }
    throw new RequestError(502, 'OpenStreetMap is unavailable. Please try again later.');
  }
  private async cityBounds(query: DiscoveryQuery, deadline: number) {
    const key = query.country.toUpperCase() + ':' + query.city.trim().replace(/\s+/g, ' ').toLowerCase();
    const cached = this.cities.get(key);
    if (cached && cached.expires > this.now()) return cached.bbox;
    const pending = this.cityPending.get(key);
    if (pending) return pending;
    const task = this.lookupCity(query, key, deadline);
    this.cityPending.set(key, task);
    try { return await task; } finally { this.cityPending.delete(key); }
  }
  private async lookupCity(query: DiscoveryQuery, key: string, deadline: number) {
    // Serialize geocoding across different cities too, including retries.
    const previous = this.cityQueue;
    let release!: () => void;
    this.cityQueue = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try {
      const wait = Math.max(0, this.nextCityRequest - this.now());
      if (wait) await this.sleep(wait);
      const transport = this.transport;
      const cityTransport: typeof fetch = async (input, init) => {
        this.nextCityRequest = this.now() + 1000;
        return transport(input, init);
      };
      const url = new URL(this.endpoints.nominatim);
      for (const [name, value] of Object.entries({ q: query.city, countrycodes: query.country.toLowerCase(), format: 'jsonv2', addressdetails: '1', featureType: 'city', limit: '3' })) url.searchParams.set(name, value);
      // The URL is built solely from the server-owned endpoint and validated city.
      // Use a wrapper to retain the one-second start spacing for every attempt.
      const raw = await this.request([url.href], { headers }, 'OSM_CITY', deadline, cityTransport);
      // Nominatim returns a JSON array; fetchJson permits arrays as JSON objects.
      const places = (Array.isArray(raw) ? raw : []).filter((place: Place) => place.address?.country_code?.toUpperCase() === query.country) as Place[];
      if (!places.length) throw new RequestError(422, 'No city matched. Try adding its state, province, or region.');
      if (places.length > 1 && new Set(places.map(place => place.display_name)).size > 1) throw new RequestError(422, 'Several cities matched. Add the state, province, or region to the city field.');
      const bounds = places[0]!.boundingbox?.map(Number);
      if (!bounds || bounds.length !== 4 || bounds.some(value => !Number.isFinite(value)) || bounds[0]! >= bounds[1]! || bounds[2]! >= bounds[3]!
        || bounds[0]! < -90 || bounds[1]! > 90 || bounds[2]! < -180 || bounds[3]! > 180 || bounds[1]! - bounds[0]! > 5 || bounds[3]! - bounds[2]! > 5) throw new RequestError(422, 'The city area is invalid or too large. Choose a more specific city.');
      const bbox = [bounds[0]!, bounds[2]!, bounds[1]!, bounds[3]!];
      if (this.cities.size >= 100) this.cities.delete(this.cities.keys().next().value!);
      this.cities.set(key, { bbox, expires: this.now() + 7 * 86400000 });
      return bbox;
    } finally { release(); }
  }
  async collect(query: DiscoveryQuery): Promise<Collection> {
    const deadline = this.now() + 110000;
    const bbox = await this.cityBounds(query, deadline);
    const niche = this.niches.find(item => item.id === query.niche)!;
    const filters = niche.tags.map(([key, value]) => `nwr["${key}"="${value}"](${bbox.join(',')});`).join('');
    const body = new URLSearchParams({ data: `[out:json][timeout:25][maxsize:8388608];(${filters});out tags center 100;` });
    const data = await this.request(this.endpoints.overpass, { method: 'POST', headers, body }, 'OSM_BUSINESSES', deadline);
    if (data.remark || !Array.isArray(data.elements)) throw new RequestError(502, 'OpenStreetMap could not complete the city query. Please try again later.');
    const items = data.elements as { id: number; type: string; tags?: Record<string, string> }[];
    return {
      records: items.filter(item => item.tags?.name).slice(0, 100).map(item => {
        const tags = item.tags!;
        const street = [tags['addr:housenumber'], tags['addr:street']].filter(Boolean).join(' ');
        const address = [street, tags['addr:city'], tags['addr:postcode']].filter(Boolean).join(', ');
        return {
          businessName: tags.name, niche: niche.label, country: tags['addr:country'] || query.country, city: tags['addr:city'] || query.city,
          address: tags['addr:full'] || address || null, phone: tags['contact:phone'] || tags.phone,
          website: tags['contact:website'] || tags.website, email: tags['contact:email'] || tags.email,
          socials: Object.fromEntries(['facebook', 'instagram', 'linkedin', 'twitter'].map(name => [name, tags['contact:' + name] || tags[name]])),
          sourceId: item.type + '/' + item.id, metadata: item as unknown as Record<string, unknown>
        };
      }),
      warnings: ['OpenStreetMap coverage varies. Results are capped at 100 and city bounding boxes may include nearby businesses.', ...(items.length >= 100 ? ['Result limit reached. This is a bounded preview, not every business in the city.'] : [])],
      attribution: '© OpenStreetMap contributors · ODbL. City lookup: Nominatim; discovery: Overpass.'
    };
  }
}
