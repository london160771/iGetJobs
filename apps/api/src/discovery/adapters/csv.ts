import { parse } from 'csv-parse/sync';
import { createHash } from 'node:crypto';
import type { Collection, ImportAdapter } from './types.js';
import { CSV_MAX_BYTES } from '../config.js';
import { RequestError } from '../errors.js';
import { text } from '../normalize.js';

export class CsvAdapter implements ImportAdapter {
  readonly source = 'CSV';
  collect(csv: string, filename: string, defaults: { country?: string; city?: string; niche?: string } = {}): Collection {
    if (Buffer.byteLength(csv) > CSV_MAX_BYTES) throw new RequestError(413, 'CSV files must be 40KB or smaller.');
    if (!csv.trim() || [...csv].some(char => /\p{Cc}/u.test(char) && !['\t', '\r', '\n'].includes(char))) throw new RequestError(400, 'Choose a UTF-8 CSV file with a header row.');
    let rows: Record<string, string>[];
    try {
      rows = parse(csv, {
        bom: true, skip_empty_lines: true, max_record_size: CSV_MAX_BYTES,
        columns: (headers: string[]) => {
          const keys = headers.map(header => header.trim());
          if (new Set(keys.map(key => key.toLowerCase().replace(/[_\s-]/g, ''))).size !== keys.length) throw new Error();
          if (keys.filter(key => /^(businessname|name|title)$/i.test(key.replace(/[_\s-]/g, ''))).length !== 1) throw new Error();
          return keys;
        }
      }) as Record<string, string>[];
    } catch { throw new RequestError(400, 'CSV could not be parsed. Include a businessName (or name) header, unique columns, and valid quoting.'); }
    if (!rows.length || rows.length > 200) throw new RequestError(400, 'CSV import supports 1–200 data rows.');
    const digest = createHash('sha256').update(csv).digest('hex');
    const countries: Record<string, string> = { 'united states': 'US', usa: 'US', 'united kingdom': 'GB', uk: 'GB', canada: 'CA', australia: 'AU' };
    return {
      records: rows.map((raw, index) => {
        const row = Object.fromEntries(Object.entries(raw).map(([key, value]) => [key.toLowerCase().replace(/[_\s-]/g, ''), value]));
        const country = text(row.country || defaults.country);
        return {
          businessName: row.businessname || row.name || row.title, niche: row.niche || defaults.niche,
          country: country ? countries[country.toLowerCase()] || country.toUpperCase() : null,
          city: row.city || defaults.city, address: row.address, phone: row.phone, website: row.website || row.domain,
          email: row.email, rating: row.rating, reviewCount: row.reviewcount || row.reviews,
          socials: Object.fromEntries(['facebook', 'instagram', 'linkedin', 'twitter'].map(name => [name, row[name]])),
          sourceId: digest + ':' + (index + 1), metadata: { filename: filename.slice(0, 200), rowNumber: index + 2, fields: raw }
        };
      }),
      warnings: [], attribution: 'Manual CSV import. Original columns and row numbers are preserved.'
    };
  }
}
