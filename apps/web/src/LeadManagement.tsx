import { useEffect, useRef, useState, type FormEvent } from 'react';
import { followUpState, leadLabelMaxLength, leadStatuses, type Lead, type WebsiteResolution } from '@igetjobs/shared';
import { api, ApiRequestError } from './lib/api';

export function LeadManagement({ lead, busy, needsReload, onBusy, onDirty, onUncertain, onSaved }: { lead: Lead; busy: boolean; needsReload: boolean; onBusy: (value: boolean) => void; onDirty: (value: boolean) => void; onUncertain: () => void; onSaved: (lead: Lead, resolution: WebsiteResolution) => void }) {
  const [error, setError] = useState<string | null>(null), [message, setMessage] = useState<string | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  useEffect(() => () => controllerRef.current?.abort(), []);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = event.currentTarget, values = new FormData(form);
    const input: Record<string, unknown> = { expectedUpdatedAt: lead.updatedAt };
    for (const [key, raw] of values) {
      if (typeof raw !== 'string') continue;
      const value = key === 'notes' || key === 'status' ? raw : key === 'followUpAt' ? raw ? raw + 'T12:00:00.000Z' : null : ['rating', 'reviewCount'].includes(key) ? raw === '' ? null : Number(raw) : raw.trim() || null;
      const previous = key === 'followUpAt' ? lead.followUpAt ? lead.followUpAt.slice(0, 10) + 'T12:00:00.000Z' : null : lead[key as keyof Lead];
      if (value !== previous) input[key] = value;
    }
    const candidate = (form.elements.namedItem('mockupCandidate') as HTMLInputElement).checked;
    if (candidate !== lead.mockupCandidate) input.mockupCandidate = candidate;
    if (Object.keys(input).length === 1) { onDirty(false); setMessage('No changes to save.'); return; }
    const controller = new AbortController(); controllerRef.current = controller;
    onBusy(true); setError(null); setMessage(null);
    try {
      const result = await api<{ lead: Lead; resolution: WebsiteResolution }>('/api/management/leads/' + lead.id, { method: 'PATCH', body: JSON.stringify(input), signal: controller.signal });
      if (!controller.signal.aborted) { onDirty(false); onSaved(result.lead, result.resolution); }
    } catch (failure) {
      if (!controller.signal.aborted) {
        setError(failure instanceof Error ? failure.message : 'Changes could not be saved.');
        if (!(failure instanceof ApiRequestError) || failure.status !== 400) onUncertain();
      }
    }
    finally { if (!controller.signal.aborted) onBusy(false); }
  }
  const text = (name: keyof Lead, label: string, maxLength = 2000, type = 'text') => <label>{label}<input name={name} type={type} maxLength={maxLength} defaultValue={typeof lead[name] === 'string' ? lead[name] as string : ''} /></label>;
  return <section className="audit-panel"><h2>Manage lead</h2>
    <form className="management-form" onSubmit={event => void save(event)} onChange={() => { onDirty(true); setMessage(null); }}>
      <fieldset disabled={busy || needsReload}><legend className="sr-only">Lead management fields</legend><div className="management-fields">
        <label>Pipeline status<select name="status" defaultValue={lead.status}>{leadStatuses.map(status => <option key={status}>{status}</option>)}</select></label>
        <label>Follow-up date<input name="followUpAt" type="date" defaultValue={lead.followUpAt?.slice(0, 10) || ''} />{lead.followUpAt && <small>{followUpState(lead.followUpAt, new Date().toLocaleDateString('en-CA'))}</small>}</label>
      </div><label className="notes-field">Notes<textarea name="notes" rows={5} maxLength={10000} defaultValue={lead.notes} placeholder="Conversation notes, next steps, and useful context…" /></label>
      <label className="review-check"><input name="mockupCandidate" type="checkbox" defaultChecked={lead.mockupCandidate} />Mockup candidate (manual flag only; no mockup is generated)</label>
      <details className="contact-editor"><summary>Edit business and contact data</summary><p className="muted">Contact or business changes clear the assessment. Source history stays preserved; clearing a website does not erase linked website evidence.</p><div className="management-fields">
        {text('businessName', 'Business name', 300)}{text('niche', 'Niche', leadLabelMaxLength)}{text('country', 'Country code', 2)}{text('city', 'City', leadLabelMaxLength)}{text('address', 'Address')}
        {text('website', 'Website', 2000)}{text('email', 'Email', 254, 'email')}{text('phone', 'Phone', 40, 'tel')}
        <label>Rating<input name="rating" type="number" min="0" max="5" step="any" defaultValue={lead.rating ?? ''} /></label><label>Review count<input name="reviewCount" type="number" min="0" max="2147483647" step="1" defaultValue={lead.reviewCount ?? ''} /></label>
      </div></details>
      <div className="management-actions"><button className="button" type="submit">{busy ? 'Please wait…' : 'Save changes'}</button><button className="text-button" type="reset" onClick={() => { onDirty(false); setError(null); setMessage(null); }}>Discard changes</button></div></fieldset>
    </form>
    {error && <p className="message error-message" role="alert">{error} Your edits remain in the form.{needsReload && ' Reload the lead before retrying a stale or uncertain write.'}</p>}
    {message && <p role="status">{message}</p>}
  </section>;
}
