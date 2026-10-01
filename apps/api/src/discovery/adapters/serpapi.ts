import type { DiscoveryQuery } from '@igetjobs/shared';
import type { Collection, SourceAdapter } from './types.js';
import type { Niche } from '../config.js';
import { fetchJson } from '../http.js';
import { RequestError } from '../errors.js';
import { text } from '../normalize.js';

export class SerpApiAdapter implements SourceAdapter {
  readonly source = 'SERPAPI';
  constructor(private apiKey: string | null, private niches: Niche[], private transport: typeof fetch = fetch) {}
  async collect(query: DiscoveryQuery): Promise<Collection> {
    if (!this.apiKey) throw new RequestError(503, 'SerpAPI is not configured. Choose OpenStreetMap or CSV import.');
    const accountUrl = new URL('https://serpapi.com/account.json');
    accountUrl.searchParams.set('api_key', this.apiKey);
    const account = await fetchJson(accountUrl, {}, this.transport);
    if (account.plan_monthly_price !== 0 || typeof account.plan_name !== 'string' || !/^free(?:\s|$)/i.test(account.plan_name) || account.account_status !== 'Active') throw new RequestError(403, 'Only an active SerpAPI free plan can be used.');
    if (typeof account.plan_searches_left !== 'number' || account.plan_searches_left < 1
      || typeof account.this_hour_searches !== 'number' || typeof account.account_rate_limit_per_hour !== 'number'
      || account.this_hour_searches >= account.account_rate_limit_per_hour) throw new RequestError(429, 'SerpAPI free-plan quota is exhausted or cannot be verified.');
    const niche = this.niches.find(item => item.id === query.niche)!;
    const country = new Intl.DisplayNames(['en'], { type: 'region' }).of(query.country) || query.country;
    const url = new URL('https://serpapi.com/search.json');
    for (const [key, value] of Object.entries({ api_key: this.apiKey, engine: 'google_maps', type: 'search', q: niche.label + ' in ' + query.city + ', ' + country, hl: 'en', gl: query.country.toLowerCase() })) url.searchParams.set(key, value);
    const data = await fetchJson(url, {}, this.transport);
    if (data.error) throw new RequestError(502, 'SerpAPI could not complete the search.');
    if (data.local_results !== undefined && !Array.isArray(data.local_results)) throw new RequestError(502, 'SerpAPI returned invalid search results.');
    const items = (data.local_results || []) as Record<string, unknown>[];
    return {
      records: items.slice(0, 100).filter(item => item && typeof item === 'object').map(item => ({
        businessName: item.title, niche: niche.label, country: query.country, city: query.city, address: item.address,
        phone: item.phone, website: item.website, email: item.email, rating: item.rating, reviewCount: item.reviews,
        sourceId: text(item.place_id) || text(item.data_id), metadata: item
      })),
      warnings: ['One result page only; no automatic pagination. Search relevance should be reviewed before saving.'],
      attribution: 'Business discovery via SerpAPI (Google Maps results).'
    };
  }
}
