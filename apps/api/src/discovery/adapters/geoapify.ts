import type { DiscoveryQuery } from '@igetjobs/shared';
import type { Collection, SourceAdapter } from './types.js';
import type { Niche } from '../config.js';
import type { SourceRecord } from '../normalize.js';
import { DiscoveryTransportError, fetchJson } from '../http.js';
import { RequestError } from '../errors.js';

export const geoapifyCategories: Readonly<Record<string, readonly string[]>> = {
  dentists: ['healthcare.dentist'],
  'med-spas': ['service.beauty.spa', 'leisure.spa'],
  gyms: ['sport.fitness.fitness_centre', 'sport.fitness.gym'],
  salons: ['service.beauty.hairdresser', 'service.beauty'],
  contractors: ['service.electrician', 'service.carpenter', 'service.chimney_sweeper', 'service.locksmith', 'service.cleaning'],
  'real-estate': ['office.estate_agent', 'service.estate_agent'],
  'law-firms': ['office.lawyer'],
  restaurants: ['catering.restaurant'],
  'small-hotels': ['accommodation.hotel', 'accommodation.guest_house']
};
interface Runtime {
  now?: () => number; sleep?: (ms: number) => Promise<void>;
  reserveNext?: () => Promise<void>; timeoutMs?: number;
}
interface Context { deadline: number; first: boolean; lastCall: number }
interface Feature { properties: Record<string, unknown>; geometry: { type: 'Point'; coordinates: [number, number] } }
const headers = { Accept: 'application/json', 'User-Agent': 'iGetJobs/1.0 (+https://github.com/london160771/iGetJobs)' };
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const string = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value.trim() : null;
function features(value: Record<string, unknown>, limit: number): Feature[] {
  if (value.type !== 'FeatureCollection' || !Array.isArray(value.features) || value.features.length > limit) throw new RequestError(502, 'Geoapify returned an invalid result collection.');
  return value.features.map(value => {
    const feature = object(value), geometry = object(feature.geometry), properties = object(feature.properties);
    const coordinates = geometry.coordinates;
    if (feature.type !== 'Feature' || !Object.keys(properties).length || geometry.type !== 'Point' || !Array.isArray(coordinates) || coordinates.length !== 2
      || coordinates.some(value => typeof value !== 'number' || !Number.isFinite(value)) || Math.abs(coordinates[0]) > 180 || Math.abs(coordinates[1]) > 90
      || typeof properties.place_id !== 'string' || !properties.place_id || properties.place_id.length > 2048) throw new RequestError(502, 'Geoapify returned a malformed place.');
    return { properties, geometry: { type: 'Point', coordinates: coordinates as [number, number] } };
  });
}
export class GeoapifyAdapter implements SourceAdapter {
  readonly source = 'GEOAPIFY';
  private cities = new Map<string, { id: string; expires: number }>();
  private now: () => number;
  private sleep: (ms: number) => Promise<void>;
  private cooldown = 0;
  constructor(private key: string | null, private niches: Niche[], private transport: typeof fetch = fetch, private runtime: Runtime = {}) {
    this.now = runtime.now || Date.now;
    this.sleep = runtime.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
    if (runtime.timeoutMs !== undefined && (!Number.isInteger(runtime.timeoutMs) || runtime.timeoutMs < 1 || runtime.timeoutMs > 10000)) throw new Error('Invalid Geoapify timeout.');
  }
  private async request(path: string, params: Record<string, string>, context: Context): Promise<Record<string, unknown>> {
    const url = new URL(path, 'https://api.geoapify.com');
    for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
    url.searchParams.set('apiKey', this.key!);
    for (let attempt = 0; attempt < 2; attempt++) {
      const wait = context.first ? 0 : Math.max(0, context.lastCall + 5000 - this.now(), this.cooldown - this.now());
      if (wait + 1000 >= context.deadline - this.now()) throw new RequestError(429, 'Geoapify is cooling down. Try again later.');
      if (wait) await this.sleep(wait);
      // ProviderGuard reserves the first request. Charge every later request,
      // including geocoding, pagination and retries, before any network I/O.
      if (!context.first) {
        if (!this.runtime.reserveNext) throw new RequestError(503, 'Geoapify usage protection is unavailable.');
        await this.runtime.reserveNext();
      }
      context.first = false; context.lastCall = this.now();
      const remaining = context.deadline - this.now();
      if (remaining <= 0) throw new RequestError(502, 'Geoapify search timed out. Try a more specific city.');
      try {
        return await fetchJson(url, { headers }, this.transport, undefined, { timeoutMs: Math.min(this.runtime.timeoutMs ?? 10000, remaining) });
      } catch (error) {
        if (!(error instanceof DiscoveryTransportError)) throw error;
        if (error.category === 'HTTP_429') this.cooldown = this.now() + Math.max(10000, error.retryAfterMs);
        if (!error.retryable || attempt === 1) throw error;
        this.cooldown = Math.max(this.cooldown, this.now() + Math.max(5000, error.retryAfterMs));
      }
    }
    throw new RequestError(502, 'Geoapify is unavailable. Please try again later.');
  }
  private async city(query: DiscoveryQuery, context: Context): Promise<string> {
    const cacheKey = query.country + ':' + query.city.trim().replace(/\s+/g, ' ').toLowerCase();
    const cached = this.cities.get(cacheKey);
    if (cached && cached.expires > this.now()) return cached.id;
    const result = features(await this.request('/v1/geocode/search', {
      text: query.city, type: 'city', filter: 'countrycode:' + query.country.toLowerCase(), bias: 'countrycode:none', limit: '3', format: 'geojson'
    }, context), 3).filter(place => string(place.properties.country_code)?.toUpperCase() === query.country);
    const ids = [...new Set(result.map(place => place.properties.place_id as string))];
    if (!ids.length) throw new RequestError(422, 'No city matched. Try adding its state, province, or region.');
    if (ids.length !== 1) throw new RequestError(422, 'Several cities matched. Add the state, province, or region to the city field.');
    if (this.cities.size >= 100) this.cities.delete(this.cities.keys().next().value!);
    this.cities.set(cacheKey, { id: ids[0]!, expires: this.now() + 7 * 86400000 });
    return ids[0]!;
  }
  private record(feature: Feature, query: DiscoveryQuery, niche: Niche): SourceRecord | null {
    const properties = feature.properties, contact = object(properties.contact), raw = object(object(properties.datasource).raw);
    const name = string(properties.name) || string(raw.name);
    if (!name) return null;
    const websiteEvidence = [properties.website, contact.website, raw.website, raw['contact:website']].flat().filter(value => value !== undefined && value !== null && value !== '');
    const website = websiteEvidence.find(value => typeof value === 'string') ?? websiteEvidence[0];
    return {
      businessName: name, niche: niche.label, country: string(properties.country_code)?.toUpperCase() || query.country,
      city: string(properties.city) || query.city,
      address: string(properties.formatted) || [properties.housenumber, properties.street, properties.city, properties.postcode].filter(value => typeof value === 'string' && value).join(', ') || null,
      phone: contact.phone || properties.phone || raw['contact:phone'] || raw.phone,
      email: contact.email || properties.email || raw['contact:email'] || raw.email, website,
      sourceId: properties.place_id as string,
      metadata: { properties, geometry: feature.geometry, latitude: feature.geometry.coordinates[1], longitude: feature.geometry.coordinates[0],
        // The existing evidence resolver reads metadata.website, including arrays.
        // Conflicts and malformed evidence remain visible rather than guessed away.
        ...(websiteEvidence.length ? { website: websiteEvidence.length === 1 ? websiteEvidence[0] : websiteEvidence } : {}) }
    };
  }
  async collect(query: DiscoveryQuery): Promise<Collection> {
    if (!this.key?.trim()) throw new RequestError(503, 'Geoapify is not configured. Use CSV import or another available source.');
    if (this.cooldown > this.now()) throw new RequestError(429, 'Geoapify is cooling down. Please try again later.');
    const niche = this.niches.find(item => item.id === query.niche), categories = niche?.geoapifyCategories || geoapifyCategories[query.niche];
    if (!niche || !categories?.length) throw new RequestError(400, 'This niche has no Geoapify category mapping. Choose a mapped niche or use CSV import.');
    const context: Context = { deadline: this.now() + 110000, first: true, lastCall: 0 };
    const city = await this.city(query, context), records: SourceRecord[] = [], seen = new Set<string>();
    const warnings = ['Geoapify coverage and contact fields vary. Missing provider fields do not prove a business has no contact details.',
      'Category matches need review: spa results do not verify medical services, hotel results do not verify business size, and home-service coverage is limited to the mapped trades.'];
    for (let page = 0; page < 5; page++) {
      const result = features(await this.request('/v2/places', { categories: categories.join(','), filter: 'place:' + city, limit: '20', offset: String(page * 20) }, context), 20);
      let added = 0;
      for (const feature of result) {
        const id = feature.properties.place_id as string;
        if (seen.has(id)) continue;
        seen.add(id); added++;
        const country = string(feature.properties.country_code)?.toUpperCase();
        if (country && country !== query.country) { warnings.push('A result outside the selected country was excluded.'); continue; }
        const record = this.record(feature, query, niche);
        if (record) records.push(record); else warnings.push('An unnamed provider result was excluded.');
      }
      if (result.length < 20) break;
      if (!added) { warnings.push('Repeated provider page detected; pagination stopped.'); break; }
      if (page === 4) warnings.push('Result limit reached. This preview is capped at 100 businesses.');
    }
    return { records, warnings: [...new Set(warnings)], attribution: 'Geoapify · © OpenStreetMap contributors · ODbL' };
  }
}
