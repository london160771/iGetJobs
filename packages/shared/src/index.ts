/** Shared V1 contracts. */
export * from './management.js';
export * from './validation.js';
export * from './outreach.js';
import type { LeadActivity } from './management.js';
export type LeadSource = 'SERPAPI' | 'GEOAPIFY' | 'OSM' | 'CSV';
export type LeadClassification = 'NO_WEBSITE' | 'POOR_WEBSITE' | 'ACCEPTABLE_WEBSITE';
export type LeadStatus = 'New' | 'Qualified' | 'Contacted' | 'Replied' | 'Call Booked' | 'Closed' | 'Lost';
export type LeadPriority = 'High' | 'Medium' | 'Low';
export type IsoDateTime = string;

export interface LeadProvenance {
  source: LeadSource;
  sourceId: string | null;
  /** Original source fields, with credential fields/URL credentials removed. */
  metadata?: Record<string, unknown>;
}

export interface AuditCheck {
  key: string;
  label: string;
  outcome: 'pass' | 'fail' | 'unknown';
  /** Measured evidence; never an invented result. */
  evidence: string | null;
}

export interface WebsiteAudit {
  auditedAt: IsoDateTime;
  website: string | null;
  checks: AuditCheck[];
  version?: string;
  state?: 'missing' | 'reachable' | 'unreachable';
  /** Recorded fetch failure, never inferred from an opportunity score. */
  failure?: 'http' | 'dns' | 'network' | 'timeout';
  requestedWebsite?: string | null;
  evidence?: WebsiteEvidence[];
  classificationReasons?: string[];
  scoring?: ScoringConfig;
  metrics?: { status: number | null; durationMs: number | null; bytes: number | null; redirects: number | null };
}

export interface WebsiteEvidence { url: string | null; source: LeadSource; sourceId: string | null; path: string }
export interface WebsiteResolution { evidence: WebsiteEvidence[]; candidates: string[]; invalidCount: number; requiresChoice: boolean }
export interface ScoringConfig {
  weights: Record<string, number>;
  poorThreshold: number;
  highPriority: number;
  mediumPriority: number;
  slowMs: number;
  largeBytes: number;
}
export function leadPriority(score: number | null, config?: ScoringConfig): LeadPriority | null {
  return score === null ? null : score >= (config?.highPriority ?? 70) ? 'High' : score >= (config?.mediumPriority ?? 40) ? 'Medium' : 'Low';
}
export interface AuditDetail { lead: Lead; resolution: WebsiteResolution; scoring: ScoringConfig }

export interface ScoreReason {
  key: string;
  label: string;
  points: number;
  evidence: string;
}

export interface OutreachDraft {
  subject: string;
  body: string;
  approval: 'pending' | 'approved';
  updatedAt: IsoDateTime;
  version?: string;
  sourceKey?: string;
  stale?: boolean;
  edited?: boolean;
  generatedSubject?: string;
  generatedBody?: string;
  reason?: string;
}

export interface ContactEnrichment {
  provider: 'HUNTER'; inputKey: string; domain: string; attemptedAt: string;
  state: 'pending' | 'found' | 'no_result' | 'error' | 'quota' | 'accepted';
  email?: string; confidence?: number;
}

/** Missing source data and work not yet performed are null, never fabricated defaults. */
export interface Lead extends LeadProvenance {
  id: string;
  /** Trimmed display name. Name/address comparison keys are derived separately in Phase 1. */
  businessName: string;
  niche: string | null;
  /** ISO 3166-1 alpha-2 country code when known. Markets remain configurable. */
  country: string | null;
  city: string | null;
  address: string | null;
  /** International/E.164 form where source and country data permit it; otherwise null. */
  phone: string | null;
  /** Absolute HTTP(S) URL when available. */
  website: string | null;
  /** Lowercase hostname without a leading www.; no scheme, port, path or query. */
  domain: string | null;
  /** Trimmed contact email when available. */
  email: string | null;
  socials: Record<string, string>;
  rating: number | null;
  reviewCount: number | null;
  /** Preserve additional source metadata when records are merged in Phase 1. */
  provenance: LeadProvenance[];
  audit: WebsiteAudit | null;
  /** Null until deterministic classification runs in Phase 2. */
  classification: LeadClassification | null;
  /** Null until scored; populated scores must be within 0–100. */
  score: number | null;
  scoreReasons: ScoreReason[];
  outreachDraft: OutreachDraft | null;
  contactEnrichment?: ContactEnrichment | null;
  status: LeadStatus;
  notes: string;
  followUpAt: IsoDateTime | null;
  /** Database-generated, bounded management/audit history. Legacy rows may omit it. */
  activity?: LeadActivity[];
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface HealthResponse {
  status: 'ok';
  service: 'igetjobs-api';
  supabase: 'configured' | 'unconfigured';
}

export interface ApiError {
  error: string;
}

export interface DiscoveryQuery { country: string; city: string; niche: string }
export interface DiscoveryConfig {
  markets: { code: string; label: string }[];
  niches: { id: string; label: string }[];
  sources: { id: 'GEOAPIFY' | 'SERPAPI'; label: string; available: boolean }[];
  csvMaxBytes: number;
  maxResults: number;
}
export interface DuplicateCheck {
  kind: 'new' | 'exact' | 'possible';
  matchIds: string[];
  reasons: string[];
  canLink: boolean;
  matches: { businessName: string; address: string | null; city: string | null; source: LeadSource; persisted: boolean }[];
}
export type DiscoverySignal = 'STRONG_DISCOVERY_SIGNAL' | 'WEBSITE_PRESENT' | 'NEEDS_CONTACT_ENRICHMENT' | 'WEBSITE_EVIDENCE_REVIEW';
export interface PreviewRow { lead: Lead; duplicate: DuplicateCheck; warnings: string[]; discoverySignal: DiscoverySignal; contactable: boolean }
export interface DiscoveryPreview {
  id: string;
  expiresAt: IsoDateTime;
  rows: PreviewRow[];
  warnings: string[];
  attribution: string;
  cached: boolean;
}
export type SaveAction = 'save' | 'link' | 'separate';
export interface SaveSelection { id: string; action: SaveAction }
export interface SaveResult {
  results: { rowId: string; status: 'saved' | 'linked' | 'failed'; leadId?: string; error?: string }[];
}
