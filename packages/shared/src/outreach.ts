import type { Lead, ManagedLead, OutreachDraft } from './index.js';
import { leadPriority, summarizeLead } from './index.js';

export const outreachVersion = 'outreach-v1.1';
export const draftLimits = { subject: 200, body: 6000 };
const issueText: Record<string, string> = {
  https: 'The audited page used HTTP rather than HTTPS.',
  viewport: 'The page HTML did not include a mobile viewport meta tag; rendered mobile behavior was not verified.',
  performance: 'The initial response exceeded the audit’s timing threshold; real user performance was not measured.',
  page_size: 'The initial HTML exceeded the audit’s size threshold.',
  contact: 'The static page check did not find visible contact details.',
  cta: 'The static page check did not find a clear call to action.',
  structure: 'The static page check found incomplete title, heading or body structure.',
  links: 'The page contained a local fragment link without a matching target.'
};
function failureFinding(lead: Lead): string {
  const audit = lead.audit!, evidence = audit.checks.find(check => check.key === 'reachable' && check.outcome === 'fail')?.evidence;
  // Prefer a measured response over any older/general failure description.
  const status = audit.metrics?.status;
  const httpResponse = typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599 && !(status >= 200 && status < 300);
  const failure = httpResponse ? 'http' : audit.failure
    || (evidence === 'Website DNS lookup failed.' ? 'dns'
      : ['Website request timed out.', 'Website audit timed out.'].includes(evidence || '') ? 'timeout'
        : ['Website connection failed.', 'Website response could not be read.', 'Website response ended early.'].includes(evidence || '') ? 'network' : null);
  const finding = failure === 'http' ? 'The recorded website responded, but the requested page could not be loaded during the check.'
    : failure === 'dns' ? 'The recorded website address could not be resolved during the check.'
      : failure === 'network' ? 'The check encountered a connection problem while trying to load the recorded website.'
        : failure === 'timeout' ? 'The website check timed out before it could finish.'
          : ['No response received.', 'Website did not respond.'].includes(evidence || '') ? 'No response was received during the website check.'
            : 'The recorded website could not be checked successfully.';
  return finding + ' This may be temporary; page quality was not verified.';
}
export function verifiedOutreachIssues(lead: Lead): string[] {
  if (lead.audit?.state === 'unreachable' && lead.audit.checks.some(check => check.key === 'reachable' && check.outcome === 'fail'))
    return [failureFinding(lead)];
  if (lead.audit?.state !== 'reachable') return [];
  return Object.entries(issueText).filter(([key]) => lead.audit!.checks.some(check => check.key === key && check.outcome === 'fail' && Boolean(check.evidence)))
    .sort(([a],[b]) => (lead.audit?.scoring?.weights[b] ?? 0) - (lead.audit?.scoring?.weights[a] ?? 0)).map(([, text]) => text).slice(0, 3);
}
export function outreachEligible(lead: Lead): boolean {
  if (!lead.audit || !Array.isArray(lead.audit.checks) || lead.score === null || !Number.isFinite(lead.score)) return false;
  if (lead.classification === 'NO_WEBSITE') return lead.audit.state === 'missing' && lead.audit.checks.some(check => check.key === 'website_present' && check.outcome === 'fail');
  return lead.classification === 'POOR_WEBSITE' && verifiedOutreachIssues(lead).length > 0;
}
export function worthPursuing(lead: Lead): boolean {
  return outreachEligible(lead) && !['Closed', 'Lost'].includes(lead.status) && (lead.status === 'Qualified' || leadPriority(lead.score, lead.audit?.scoring) !== 'Low');
}
export function templateText(lead: Lead): { subject: string; body: string; reason: string } | null {
  if (!outreachEligible(lead)) return null;
  // Lead fields are recorded data, not claims that we know the business/person.
  const name = lead.businessName.replace(/[\r\n]/g, ' ');
  const context = [lead.niche, lead.city].filter(Boolean).join(' · ');
  const reason = lead.classification === 'NO_WEBSITE'
    ? 'No website was found in the available canonical and linked source information.'
    : verifiedOutreachIssues(lead)[0]!;
  const subject = ('Website question for ' + name).slice(0, draftLimits.subject);
  const finding = lead.classification === 'NO_WEBSITE'
    ? 'The available listing information did not include a website for your business. If you already have one, I would appreciate the correct link.'
    : 'A recent automated check of the recorded website noted:\n' + verifiedOutreachIssues(lead).map(text => '- ' + text).join('\n');
  return { subject, reason, body: `Hello ${name} team,\n\n${context ? `I’m reaching out about ${name} (${context}).\n\n` : ''}${finding}\n\nWould you be open to a brief conversation about a simple, clear website for your business?\n\nThank you` };
}
export function currentDraft(lead: Lead): boolean {
  // Preserve unaffected older drafts. Old failure wording needs regeneration/review;
  // saved user text remains intact, with replacement requiring explicit approval.
  const versionCurrent = lead.outreachDraft?.version === outreachVersion || (lead.outreachDraft?.version === 'outreach-v1' && lead.audit?.state !== 'unreachable');
  return outreachEligible(lead) && Boolean(versionCurrent && lead.outreachDraft?.sourceKey && lead.outreachDraft.stale === false);
}
export async function copyOutreachDraft(draft: OutreachDraft | null, current: boolean, clipboard?: { writeText(text: string): Promise<void> }): Promise<void> {
  if (!draft || !current || draft.approval !== 'approved') throw new Error('Review and approve a current, saved draft before copying.');
  if (!clipboard) throw new Error('Clipboard is unavailable. You can manually copy the reviewed text.');
  try { await clipboard.writeText('Subject: ' + draft.subject + '\n\n' + draft.body); }
  catch { throw new Error('Clipboard access failed. You can manually copy the reviewed text.'); }
}
export type OutreachTab = 'Ready' | 'Contacted' | 'Follow-up Due';
export interface OutreachItem { lead: ManagedLead; draft: OutreachDraft | null; current: boolean; reason: string | null }
export interface OutreachPage { items: OutreachItem[]; total: number; page: number; pageSize: number; hunterConfigured: boolean }
export function outreachItems(leads: Lead[], tab: OutreachTab, today: string): OutreachItem[] {
  return leads.filter(lead => tab === 'Ready' ? worthPursuing(lead) && ['New', 'Qualified'].includes(lead.status)
    : tab === 'Contacted' ? lead.status === 'Contacted'
    : !['Closed', 'Lost'].includes(lead.status) && Boolean(lead.followUpAt && lead.followUpAt.slice(0, 10) <= today))
    .sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || a.id.localeCompare(b.id))
    .map(lead => ({ lead: summarizeLead(lead), draft: lead.outreachDraft, current: currentDraft(lead), reason: templateText(lead)?.reason || null }));
}
