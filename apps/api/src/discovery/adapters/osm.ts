import type { DiscoveryQuery } from '@igetjobs/shared';
import type { Collection, SourceAdapter } from './types.js';
import type { Niche } from '../config.js';
import { fetchJson } from '../http.js';
import { RequestError } from '../errors.js';

const headers = { 'User-Agent': 'iGetJobs/1.0 (https://github.com/london160771/iGetJobs)', Accept: 'application/json' };
export const defaultOsmEndpoints = { nominatim: 'https://nominatim.openstreetmap.org/search', overpass: 'https://overpass-api.de/api/interpreter' };
interface Place { boundingbox: string[]; address?: { country_code?: string }; display_name?: string }
export class OsmAdapter implements SourceAdapter {
  readonly source = 'OSM';
  private cities = new Map<string, { bbox: number[]; expires: number }>();
  constructor(private niches: Niche[], private transport: typeof fetch = fetch, private endpoints = defaultOsmEndpoints) {
    for (const endpoint of Object.values(endpoints)) {
      let url: URL;
      try { url = new URL(endpoint); } catch { throw new Error('OSM endpoints must be HTTPS URLs without credentials, query strings, or fragments.'); }
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('OSM endpoints must be HTTPS URLs without credentials, query strings, or fragments.');
    }
  }
  private async cityBounds(query: DiscoveryQuery) {
    const key = query.country + ':' + query.city.toLowerCase();
    const cached = this.cities.get(key);
    if (cached && cached.expires > Date.now()) return cached.bbox;
    const url = new URL(this.endpoints.nominatim);
    for (const [name, value] of Object.entries({ q: query.city, countrycodes: query.country.toLowerCase(), format: 'jsonv2', addressdetails: '1', featureType: 'city', limit: '3' })) url.searchParams.set(name, value);
    const raw = await fetchJson(url, { headers }, this.transport);
    // Nominatim returns a JSON array; fetchJson permits arrays as JSON objects.
    const places = (Array.isArray(raw) ? raw : []).filter((place: Place) => place.address?.country_code?.toUpperCase() === query.country) as Place[];
    if (!places.length) throw new RequestError(422, 'No city matched. Try adding its state, province, or region.');
    if (places.length > 1 && new Set(places.map(place => place.display_name)).size > 1) throw new RequestError(422, 'Several cities matched. Add the state, province, or region to the city field.');
    const bounds = places[0]!.boundingbox?.map(Number);
    if (!bounds || bounds.length !== 4 || bounds.some(value => !Number.isFinite(value)) || bounds[0]! >= bounds[1]! || bounds[2]! >= bounds[3]!
      || bounds[0]! < -90 || bounds[1]! > 90 || bounds[2]! < -180 || bounds[3]! > 180 || bounds[1]! - bounds[0]! > 5 || bounds[3]! - bounds[2]! > 5) throw new RequestError(422, 'The city area is invalid or too large. Choose a more specific city.');
    const bbox = [bounds[0]!, bounds[2]!, bounds[1]!, bounds[3]!];
    if (this.cities.size >= 100) this.cities.delete(this.cities.keys().next().value!);
    this.cities.set(key, { bbox, expires: Date.now() + 86400000 });
    return bbox;
  }
  async collect(query: DiscoveryQuery): Promise<Collection> {
    const bbox = await this.cityBounds(query);
    const niche = this.niches.find(item => item.id === query.niche)!;
    const filters = niche.tags.map(([key, value]) => `nwr["${key}"="${value}"](${bbox.join(',')});`).join('');
    const body = new URLSearchParams({ data: `[out:json][timeout:25][maxsize:8388608];(${filters});out tags center 100;` });
    const data = await fetchJson(this.endpoints.overpass, { method: 'POST', headers, body }, this.transport);
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
