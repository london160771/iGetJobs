import { leadLabelMaxLength, normalizedLeadLabel, validLeadLabel, type DiscoveryConfig, type DiscoveryQuery } from '@igetjobs/shared';
import { RequestError } from './errors.js';

export const CSV_MAX_BYTES = 40 * 1024;
export const MAX_RESULTS = 100;
export interface Niche { id: string; label: string; tags: [string, string][] }
export const starterNiches: Niche[] = [
  { id: 'dentists', label: 'Dentists', tags: [['amenity', 'dentist']] },
  { id: 'med-spas', label: 'Med spas', tags: [['healthcare', 'cosmetic_surgery'], ['leisure', 'spa']] },
  { id: 'gyms', label: 'Gyms', tags: [['leisure', 'fitness_centre']] },
  { id: 'salons', label: 'Salons', tags: [['shop', 'hairdresser'], ['shop', 'beauty']] },
  { id: 'contractors', label: 'Contractors / home services', tags: [['craft', 'electrician'], ['craft', 'plumber'], ['craft', 'carpenter'], ['craft', 'roofer']] },
  { id: 'real-estate', label: 'Real estate', tags: [['office', 'estate_agent']] },
  { id: 'law-firms', label: 'Law firms', tags: [['office', 'lawyer']] },
  { id: 'restaurants', label: 'Restaurants', tags: [['amenity', 'restaurant']] },
  { id: 'small-hotels', label: 'Small hotels', tags: [['tourism', 'hotel'], ['tourism', 'guest_house']] }
];
export function discoveryOptions(env: NodeJS.ProcessEnv) {
  const markets = [...new Set((env.DISCOVERY_MARKETS || 'US,GB,CA,AU').split(',').map(code => code.trim().toUpperCase()))];
  if (!markets.length || markets.some(code => !/^[A-Z]{2}$/.test(code))) throw new Error('DISCOVERY_MARKETS must contain ISO alpha-2 country codes.');
  let niches = starterNiches;
  if (env.DISCOVERY_NICHES_JSON) {
    try {
      const input: unknown = JSON.parse(env.DISCOVERY_NICHES_JSON);
      if (!Array.isArray(input) || !input.length || input.length > 30) throw new Error();
      niches = input.map((item: Niche) => {
        if (!item || !/^[a-z0-9-]{1,40}$/.test(item.id) || typeof item.label !== 'string' || !item.label.trim() || !validLeadLabel(item.label)
          || !Array.isArray(item.tags) || !item.tags.length || item.tags.length > 10 || item.tags.some(tag => !Array.isArray(tag) || tag.length !== 2 || tag.some(value => typeof value !== 'string' || !/^[a-z0-9_:.-]{1,60}$/.test(value)))) throw new Error();
        return { ...item, label: normalizedLeadLabel(item.label)! };
      });
      if (new Set(niches.map(niche => niche.id)).size !== niches.length) throw new Error();
    } catch { throw new Error('DISCOVERY_NICHES_JSON must be a valid niche/tag configuration.'); }
  }
  const displayNames = new Intl.DisplayNames(['en'], { type: 'region' });
  const config: DiscoveryConfig = {
    markets: markets.map(code => ({ code, label: displayNames.of(code) || code })),
    niches: niches.map(({ id, label }) => ({ id, label })),
    sources: [{ id: 'OSM', label: 'OpenStreetMap', available: true }, { id: 'SERPAPI', label: 'SerpAPI', available: Boolean(env.SERPAPI_API_KEY?.trim()) }],
    csvMaxBytes: CSV_MAX_BYTES, maxResults: MAX_RESULTS
  };
  return { config, niches };
}
export function validateQuery(input: Record<string, unknown>, config: DiscoveryConfig): DiscoveryQuery {
  const country = typeof input.country === 'string' ? input.country.trim().toUpperCase() : '';
  const city = normalizedLeadLabel(input.city) || '';
  const niche = typeof input.niche === 'string' ? input.niche : '';
  if (!config.markets.some(market => market.code === country) || city.length < 2 || !validLeadLabel(input.city) || (typeof input.city === 'string' && /\p{Cc}/u.test(input.city))
    || !config.niches.some(item => item.id === niche)) throw new RequestError(400, `Choose a configured country and niche, and enter a city (2–${leadLabelMaxLength} characters).`);
  return { country, city, niche };
}
