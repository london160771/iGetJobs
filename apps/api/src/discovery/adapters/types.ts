import type { DiscoveryQuery, LeadSource } from '@igetjobs/shared';
import type { SourceRecord } from '../normalize.js';
export interface Collection { records: SourceRecord[]; warnings: string[]; attribution: string }
export interface SourceAdapter {
  readonly source: LeadSource;
  collect(query: DiscoveryQuery): Promise<Collection>;
}
export interface ImportAdapter {
  readonly source: 'CSV';
  collect(csv: string, filename: string, defaults?: { country?: string; city?: string; niche?: string }): Collection;
}
