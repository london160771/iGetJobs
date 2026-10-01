import type { Lead, LeadPriority } from './index.js';
import { leadPriority } from './index.js';

export const leadStatuses = ['New', 'Qualified', 'Contacted', 'Replied', 'Call Booked', 'Closed', 'Lost'] as const;
export const classifications = ['NO_WEBSITE', 'POOR_WEBSITE', 'ACCEPTABLE_WEBSITE'] as const;
export const leadSorts = ['score_desc', 'score_asc', 'newest', 'oldest', 'updated', 'name'] as const;
export interface LeadActivity {
  at: string; fields: string[]; assessmentInvalidated: boolean; auditCompleted: boolean;
  statusFrom?: string; statusTo?: string; followUpFrom?: string | null; followUpTo?: string | null;
}
export interface LeadFilters {
  niche?: string; country?: string; city?: string; classification?: string; priority?: string;
  status?: string; source?: string; hasEmail?: string; hasPhone?: string;
  minScore?: number; maxScore?: number; sort: typeof leadSorts[number]; page: number;
}
export type ManagedLead = Pick<Lead, 'id' | 'businessName' | 'niche' | 'country' | 'city' | 'address' | 'phone' | 'email' | 'website' | 'domain' | 'classification' | 'score' | 'status' | 'source' | 'sourceId' | 'createdAt' | 'updatedAt' | 'followUpAt'> & { priority: LeadPriority | null };
export interface DashboardCounts { total: number; qualified: number; noWebsite: number; poorWebsite: number; contacted: number; replied: number; callsBooked: number; closed: number }
export interface LeadPage {
  leads: ManagedLead[]; total: number; page: number; pageSize: number;
  options: { niches: string[]; countries: string[]; cities: string[] };
}
export function summarizeLead(lead: Lead): ManagedLead {
  const { id, businessName, niche, country, city, address, phone, email, website, domain, classification, score, status, source, sourceId, createdAt, updatedAt, followUpAt } = lead;
  return { id, businessName, niche, country, city, address, phone, email, website, domain, classification, score, status, source, sourceId, createdAt, updatedAt, followUpAt, priority: leadPriority(score, lead.audit?.scoring) };
}
export function filterAndSortLeads(leads: ManagedLead[], query: LeadFilters): ManagedLead[] {
  const rows = leads.filter(lead => {
    for (const key of ['niche', 'country', 'city', 'classification', 'priority', 'status', 'source'] as const) {
      if (query[key] && (key === 'classification' && query[key] === 'UNAUDITED' ? lead.classification !== null : lead[key] !== query[key])) return false;
    }
    if (query.minScore !== undefined && (lead.score === null || lead.score < query.minScore)) return false;
    if (query.maxScore !== undefined && (lead.score === null || lead.score > query.maxScore)) return false;
    if (query.hasEmail && Boolean(lead.email) !== (query.hasEmail === 'yes')) return false;
    if (query.hasPhone && Boolean(lead.phone) !== (query.hasPhone === 'yes')) return false;
    return true;
  });
  const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
  return rows.sort((a, b) => {
    let order = 0;
    switch (query.sort) {
      case 'score_desc': case 'score_asc':
        if (a.score === null || b.score === null) order = a.score === b.score ? 0 : a.score === null ? 1 : -1;
        else order = query.sort === 'score_desc' ? b.score - a.score : a.score - b.score;
        break;
      case 'newest': order = compare(b.createdAt, a.createdAt); break;
      case 'oldest': order = compare(a.createdAt, b.createdAt); break;
      case 'updated': order = compare(b.updatedAt, a.updatedAt); break;
      case 'name': order = compare(a.businessName.toLowerCase(), b.businessName.toLowerCase()); break;
    }
    return order || compare(a.id, b.id);
  });
}
export function dashboardCounts(leads: ManagedLead[]): DashboardCounts {
  const count = (status: string) => leads.filter(lead => lead.status === status).length;
  return { total: leads.length, qualified: count('Qualified'), noWebsite: leads.filter(lead => lead.classification === 'NO_WEBSITE').length,
    poorWebsite: leads.filter(lead => lead.classification === 'POOR_WEBSITE').length, contacted: count('Contacted'), replied: count('Replied'), callsBooked: count('Call Booked'), closed: count('Closed') };
}
/** Follow-up dates are displayed as calendar days, independent of locale formatting. */
export function followUpState(value: string | null, today: string): 'Overdue' | 'Today' | 'Upcoming' | null {
  if (!value) return null;
  const date = value.slice(0, 10);
  return date < today ? 'Overdue' : date === today ? 'Today' : 'Upcoming';
}
