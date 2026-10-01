/** Shared contracts only. Discovery, audit, scoring and persistence belong to later phases. */
export type LeadSource = 'SERPAPI' | 'OSM' | 'CSV';
export type LeadClassification = 'NO_WEBSITE' | 'POOR_WEBSITE' | 'ACCEPTABLE_WEBSITE';
export type LeadStatus = 'New' | 'Qualified' | 'Contacted' | 'Replied' | 'Call Booked' | 'Closed' | 'Lost';
export type LeadPriority = 'High' | 'Medium' | 'Low';
export type IsoDateTime = string;

export interface LeadProvenance {
  source: LeadSource;
  sourceId: string | null;
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
}

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
  status: LeadStatus;
  notes: string;
  followUpAt: IsoDateTime | null;
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
