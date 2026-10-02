import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { RequestError } from './errors.js';
export type Usage = Record<string, { period: string; count: number; lastCall: number }>;
export type QuotaProvider = 'OSM' | 'SERPAPI' | 'HUNTER';
export interface UsageStore { load(): Promise<Usage>; save(usage: Usage): Promise<void>; reserve?(provider: QuotaProvider, limit: number): Promise<void> }
export async function reserveUsage(store: UsageStore, source: QuotaProvider, limit: number, now: number) {
  if (store.reserve) return store.reserve(source,limit);
  const usage = await store.load(), previous = usage[source];
  const period = new Date(now).toISOString().slice(0,source === 'OSM' ? 10 : 7);
  if (previous && now - previous.lastCall < (source === 'OSM' ? 15000 : 5000)) throw new RequestError(429,'Please wait before another provider lookup.');
  const count = previous?.period === period ? previous.count : 0;
  if (count >= limit) throw new RequestError(429,'The configured provider attempt cap is exhausted.');
  usage[source] = { period,count:count + 1,lastCall:now };
  await store.save(usage); // Local development only; reserve even failed attempts.
}
export function fileUsageStore(path: string): UsageStore {
  return {
    async load() {
      try {
        const value: unknown = JSON.parse(await readFile(path, 'utf8'));
        if (!value || typeof value !== 'object' || Array.isArray(value) || Object.values(value).some(row => !row || typeof row.period !== 'string' || !Number.isInteger(row.count) || row.count < 0 || !Number.isFinite(row.lastCall))) throw new Error();
        return value as Usage;
      } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return {};
        throw new RequestError(503, 'Discovery usage protection is unavailable.');
      }
    },
    async save(usage) {
      try {
        await mkdir(dirname(path), { recursive: true });
        const temporary = path + '.' + randomUUID() + '.tmp';
        await writeFile(temporary, JSON.stringify(usage), { mode: 0o600 });
        await rename(temporary, path);
      } catch { throw new RequestError(503, 'Discovery usage protection is unavailable.'); }
    }
  };
}
export class ProviderGuard {
  private busy = false;
  private cache = new Map<string, { value: unknown; expires: number; bytes: number }>();
  private pending = new Map<string, Promise<{ value: unknown; cached: boolean }>>();
  constructor(private store: UsageStore, private serpLimit = 50, private now = () => Date.now()) {}
  async reserveOsmRetry() {
    if (!this.busy) throw new RequestError(503, 'OSM retry protection is unavailable.');
    await reserveUsage(this.store, 'OSM', 30, this.now());
  }
  async run<T>(source: 'OSM' | 'SERPAPI', key: string, collect: () => Promise<T>): Promise<{ value: T; cached: boolean }> {
    const cached = this.cache.get(key);
    if (cached && cached.expires > this.now()) return { value: structuredClone(cached.value) as T, cached: true };
    const pending = this.pending.get(key);
    if (pending) return { value: structuredClone((await pending).value) as T, cached: true };
    if (this.busy) throw new RequestError(429, 'Another discovery request is running. Please wait for it to finish.');
    this.busy = true;
    const task = (async () => {
      try {
        await reserveUsage(this.store,source,source === 'OSM' ? 30 : this.serpLimit,this.now());
        const value = await collect();
        for (const [cacheKey, entry] of this.cache) if (entry.expires <= this.now()) this.cache.delete(cacheKey);
        const bytes = Buffer.byteLength(JSON.stringify(value));
        let total = [...this.cache.values()].reduce((sum, entry) => sum + entry.bytes, 0);
        while (this.cache.size && (this.cache.size >= 100 || total + bytes > 16 * 1024 * 1024)) {
          const oldest = this.cache.keys().next().value!;
          total -= this.cache.get(oldest)!.bytes; this.cache.delete(oldest);
        }
        if (bytes <= 16 * 1024 * 1024) this.cache.set(key, { value: structuredClone(value), expires: this.now() + 3600000, bytes });
        return { value, cached: false };
      } finally { this.busy = false; this.pending.delete(key); }
    })();
    this.pending.set(key, task);
    return await task;
  }
}
