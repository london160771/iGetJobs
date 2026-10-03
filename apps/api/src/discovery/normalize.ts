import { randomUUID } from 'node:crypto';
import { isSupportedCountry, parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js';
import { leadLabelMaxLength, normalizedLeadLabel, validLeadLabel, type Lead, type LeadSource } from '@igetjobs/shared';
import { RequestError } from './errors.js';

export interface SourceRecord {
  businessName?: unknown; niche?: unknown; country?: unknown; city?: unknown; address?: unknown;
  phone?: unknown; website?: unknown; email?: unknown; socials?: Record<string, unknown>;
  rating?: unknown; reviewCount?: unknown; sourceId: string | null; metadata: Record<string, unknown>;
}
export function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().normalize('NFKC').replace(/\p{Cc}/gu, ' ').slice(0, 2000) : null;
}
// Only bounded language/pagination selectors have a known non-credential purpose.
// Unknown parameters and fragments are discarded, including OAuth fragment tokens.
export function sanitizeHttpUrl(url: URL): string {
  url.username = ''; url.password = ''; url.hash = '';
  for (const [key, value] of [...url.searchParams.entries()]) {
    const safe = key === 'page' ? /^[1-9]\d{0,5}$/.test(value)
      : ['lang', 'locale'].includes(key) && /^[a-z]{2,3}(?:[-_][a-z0-9]{2,8})?$/i.test(value);
    if (!safe) url.searchParams.delete(key);
  }
  return url.href;
}
export function websiteUrl(value: unknown): string | null {
  const input = text(value);
  if (!input) return null;
  try {
    const url = new URL(/^[a-z][a-z\d+.-]*:/i.test(input) ? input : 'https://' + input);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !url.hostname.includes('.')) return null;
    return sanitizeHttpUrl(url);
  } catch { return null; }
}
const privateField = /^(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|secret|service[_-]?role[_-]?key|token|key|auth|jwt|credential|credentials|session[_-]?(?:id|token)|client[_-]?secret|signature)$/i;
export function sanitizeMetadata(record: Record<string, unknown>): Record<string, unknown> {
  function clean(value: unknown, depth: number): unknown {
    if (depth > 12) return null;
    if (Array.isArray(value)) return value.map(item => clean(item, depth + 1));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !privateField.test(key)).map(([key, item]) => [key, clean(item, depth + 1)]));
    if (typeof value === 'string' && /^(?:https?:\/\/|\/\/|[^\s/?#]+\.[^\s/?#]+[/?#]|[^\s/?#]+:[^\s/?#]*@[^\s/?#]+\.[^\s/?#]+$)/i.test(value.trim())) {
      try {
        const input = value.trim();
        const url = new URL(input.startsWith('//') ? 'https:' + input : /^https?:\/\//i.test(input) ? input : 'https://' + input);
        return sanitizeHttpUrl(url);
      } catch { return null; }
    }
    return value;
  }
  return clean(record, 0) as Record<string, unknown>;
}
export function normalizeLead(record: SourceRecord, source: LeadSource): { lead: Lead; warnings: string[] } {
  const businessName = text(record.businessName);
  if (!businessName || businessName.length > 300) throw new RequestError(400, 'Business name is missing or exceeds 300 characters.');
  for (const key of ['city', 'niche'] as const) if (!validLeadLabel(record[key])) throw new RequestError(400, `City and niche must not exceed ${leadLabelMaxLength} characters; record was not imported.`);
  const warnings: string[] = [];
  const countryText = text(record.country)?.toUpperCase();
  const country = countryText && /^[A-Z]{2}$/.test(countryText) ? countryText : null;
  if (record.country && !country) warnings.push('Country code could not be normalized.');
  const website = websiteUrl(record.website);
  if (record.website && !website) warnings.push('Website could not be normalized; original value is preserved in source metadata.');
  const phoneInput = text(record.phone);
  let phone: string | null = null;
  try {
    const number = phoneInput ? parsePhoneNumberFromString(phoneInput, country && isSupportedCountry(country) ? country as CountryCode : undefined) : null;
    phone = number?.isValid() ? number.number : null;
  } catch { /* Unknown numbers stay null rather than being fabricated. */ }
  if (phoneInput && !phone) warnings.push('Phone could not be validated; original value is preserved in source metadata.');
  const emailText = text(record.email);
  const email = emailText && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailText) ? emailText.toLowerCase() : null;
  if (emailText && !email) warnings.push('Email format is invalid; original value is preserved in source metadata.');
  const numeric = (value: unknown) => typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value.replace(/,/g, '')) : NaN;
  const rating = numeric(record.rating), reviews = numeric(record.reviewCount);
  const now = new Date().toISOString();
  const metadata = sanitizeMetadata(record.metadata);
  // Keep a non-sensitive invalid-evidence marker even when URL sanitization had
  // to discard the source string. Null canonical data must not imply NO_WEBSITE.
  if (record.website !== null && record.website !== undefined && !(typeof record.website === 'string' && !record.website.trim()) && !website) {
    metadata.websiteEvidenceInvalid = true;
    // Structured source values cannot become a canonical URL by guessing. Retain
    // sanitized candidates for explicit audit review if the adapter omitted them.
    if (typeof record.website !== 'string' && metadata.website === undefined) metadata.website = sanitizeMetadata({ website: record.website }).website;
  }
  const provenance = { source, sourceId: record.sourceId, metadata };
  return { warnings, lead: {
    id: randomUUID(), businessName, niche: normalizedLeadLabel(record.niche), country, city: normalizedLeadLabel(record.city), address: text(record.address),
    phone, website, domain: website ? new URL(website).hostname.toLowerCase().replace(/^www\./, '') : null,
    email, socials: Object.fromEntries(Object.entries(record.socials || {}).map(([key, value]) => [key, websiteUrl(value)]).filter((entry): entry is [string, string] => Boolean(entry[1]))),
    rating: Number.isFinite(rating) && rating >= 0 && rating <= 5 ? rating : null,
    reviewCount: Number.isInteger(reviews) && reviews >= 0 ? reviews : null,
    source, sourceId: record.sourceId, provenance: [provenance], audit: null, classification: null, score: null,
    scoreReasons: [], outreachDraft: null, mockupCandidate: false, status: 'New', notes: '', followUpAt: null, createdAt: now, updatedAt: now
  } };
}
