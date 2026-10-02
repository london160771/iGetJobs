import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { AuditDetail, Lead } from '@igetjobs/shared';
import { api, ApiRequestError } from './lib/api';
import { PageHeader } from './components';
import { AuditSummary } from './AuditSummary';
import { LeadManagement } from './LeadManagement';
import { OutreachEditor } from './OutreachEditor';
export function LeadDetail() {
  const { leadId } = useParams();
  return <LeadAudit key={leadId} leadId={leadId || ''} />;
}
function LeadAudit({ leadId }: { leadId: string }) {
  const [detail, setDetail] = useState<AuditDetail | null>(null);
  const [selection, setSelection] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [success, setSuccess] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draftEditing, setDraftEditing] = useState(false);
  const [saved, setSaved] = useState(false);
  const [needsReload, setNeedsReload] = useState(false);
  const controllerRef = useRef<AbortController | null>(null);
  const unsaved = editing || draftEditing;
  useEffect(() => {
    const controller = new AbortController(); controllerRef.current = controller;
    void api<AuditDetail>('/api/leads/' + encodeURIComponent(leadId), { signal: controller.signal }).then(value => {
      if (!controller.signal.aborted) { setDetail(value); setSelection(value.resolution.requiresChoice ? '' : value.resolution.candidates[0] || ''); }
    }).catch((failure: Error) => { if (!controller.signal.aborted) setError(failure.message); });
    return () => controller.abort();
  }, [leadId, revision]);
  async function audit() {
    if (!detail || busy || unsaved || needsReload) return;
    const controller = controllerRef.current;
    if (!controller) return;
    setBusy(true); setError(null); setSuccess(false); setSaved(false);
    try {
      const value = await api<{ lead: Lead }>('/api/leads/' + encodeURIComponent(detail.lead.id) + '/audit', { method: 'POST', body: JSON.stringify(selection ? { website: selection } : {}), signal: controller.signal });
      if (!controller.signal.aborted) { setDetail({ ...detail, lead: value.lead }); setSuccess(true); }
    } catch (failure) { if (!controller.signal.aborted) { setError(failure instanceof Error ? failure.message : 'Audit failed. Please retry.'); if (failure instanceof ApiRequestError && failure.status === 409) setNeedsReload(true); } }
    finally { if (!controller.signal.aborted) setBusy(false); }
  }
  return <>
    <Link className="text-button" to="/leads">← Saved leads</Link>
    <PageHeader title={detail?.lead.businessName || 'Lead detail'} description={detail ? [detail.lead.niche, detail.lead.city, detail.lead.country].filter(Boolean).join(' · ') : 'Website evidence and opportunity assessment.'} />
    <button className="text-button reload-lead" onClick={() => { setDetail(null); setError(null); setSuccess(false); setSaved(false); setEditing(false); setDraftEditing(false); setNeedsReload(false); setRevision(value => value + 1); }} disabled={busy}>{unsaved ? 'Reload / discard edits' : 'Reload lead'}</button>
    {error && <p className="message error-message" role="alert">{error}</p>}
    {!detail && !error && <p role="status">Loading lead…</p>}
    {detail && <>
      {saved && <p className="message success-message" role="status">Changes saved.{!detail.lead.audit && ' No current assessment; run an audit after reviewing website evidence.'}</p>}
      <LeadManagement key={detail.lead.updatedAt} lead={detail.lead} busy={busy} needsReload={needsReload || draftEditing} onBusy={setBusy} onDirty={value => { setEditing(value); if (value) { setSaved(false); setSuccess(false); } }} onUncertain={() => { setNeedsReload(true); setSaved(false); setSuccess(false); }} onSaved={(lead, resolution) => { setDetail({ ...detail, lead, resolution }); setSelection(resolution.requiresChoice ? '' : resolution.candidates[0] || ''); setSuccess(false); setSaved(true); }} />
      <section className="audit-panel"><h2>Website evidence</h2><p className="muted">Canonical contact data and linked source websites are checked together. Choose the website to audit when evidence conflicts.</p>
        {detail.resolution.invalidCount > 0 && <p className="row-warning">{detail.resolution.invalidCount} source website value(s) could not be normalized. Select a valid candidate explicitly, or import corrected evidence before auditing. This lead cannot be assumed to have no website.</p>}
        {detail.resolution.requiresChoice && detail.resolution.candidates.length > 0 && <p className="row-warning">Evidence needs review. Your choice is recorded in the audit and does not overwrite source data.</p>}
        {detail.resolution.candidates.length > 0 && <label className="audit-choice">Website to audit<select value={selection} onChange={event => setSelection(event.target.value)} disabled={busy}><option value="">Choose a website…</option>{detail.resolution.candidates.map(url => <option key={url} value={url}>{url}</option>)}</select></label>}
        {detail.resolution.evidence.length === 0 && <p>No website is present in the canonical or preserved source fields. Run the audit to record this finding.</p>}
        <ul className="evidence-list">{detail.resolution.evidence.map((evidence, index) => <li key={index}><span className="tag">{evidence.source}</span> {evidence.url || 'Invalid website value (not used)'}<small>{evidence.path} · {evidence.sourceId || 'No source identifier'}</small></li>)}</ul>
        <button className="button" disabled={busy || unsaved || needsReload || (detail.resolution.requiresChoice && !selection) || (detail.resolution.candidates.length > 0 && !selection)} onClick={() => void audit()}>{busy ? 'Please wait…' : detail.lead.audit ? 'Run audit again' : 'Audit website'}</button>
        {unsaved && <p className="muted">Save or discard your edits before auditing.</p>}
        <p className="muted">One bounded request chain; no scripts or assets run. Static checks cannot verify rendered mobile layout or actual CTA behavior.</p>
      </section>
      {success && <p className="message success-message" role="status">Audit, classification, and score saved.</p>}
      <section className="audit-panel"><h2>Opportunity assessment</h2>{needsReload ? <p className="row-warning">Lead state is uncertain. Reload before using an assessment or saving further changes.</p> : <AuditSummary lead={detail.lead} detailed />}</section>
      <OutreachEditor key={'draft-' + detail.lead.updatedAt} lead={detail.lead} busy={busy} blocked={needsReload || editing} onBusy={setBusy} onDirty={setDraftEditing} onUncertain={() => { setNeedsReload(true); setSuccess(false); setSaved(false); }} onSaved={lead => { setDetail({ ...detail,lead }); setDraftEditing(false); setSuccess(false); setSaved(true); }} />
      <section className="audit-panel"><h2>Business and contact</h2><p>{detail.lead.address || 'No address recorded'}</p><div className="lead-contact">{detail.lead.website && <a href={detail.lead.website} target="_blank" rel="noreferrer">{detail.lead.domain} ↗</a>}{detail.lead.phone && <span>{detail.lead.phone}</span>}{detail.lead.email && <span>{detail.lead.email}</span>}{Object.entries(detail.lead.socials).map(([label, url]) => <a key={label} href={url} target="_blank" rel="noreferrer">{label} ↗</a>)}</div><p className="muted">Recorded data; not independently verified. Rating: {detail.lead.rating ?? 'unknown'} · Reviews: {detail.lead.reviewCount ?? 'unknown'}</p></section>
      <section className="audit-panel"><h2>Source history</h2><p>Canonical source: {detail.lead.source} · {detail.lead.sourceId || 'No source identifier'}</p>{detail.lead.provenance.map((entry, index) => <details key={index}><summary>{entry.source} · {entry.sourceId || 'No source identifier'}</summary><pre className="provenance-data">{JSON.stringify(entry.metadata || {}, null, 2)}</pre></details>)}</section>
      <section className="audit-panel"><h2>Activity</h2><p className="muted">Created {new Date(detail.lead.createdAt).toLocaleString()}. Latest 100 recorded changes; earlier edits before activity tracking are unavailable.</p>
        {detail.lead.activity?.length ? <ol className="activity-list">{[...detail.lead.activity].reverse().map((entry, index) => <li key={index}><time dateTime={entry.at}>{new Date(entry.at).toLocaleString()}</time><p>{entry.statusTo ? `Status: ${entry.statusFrom} → ${entry.statusTo}. ` : ''}{Object.hasOwn(entry, 'followUpTo') ? `Follow-up: ${entry.followUpTo?.slice(0, 10) || 'cleared'}. ` : ''}{entry.auditCompleted ? 'Website audit saved. ' : ''}{entry.fields.length ? 'Changed: ' + entry.fields.map(field => field.replace(/_/g, ' ')).join(', ') + '. ' : ''}{entry.assessmentInvalidated ? 'Assessment cleared; reaudit required.' : ''}</p></li>)}</ol> : <p>No changes recorded yet.</p>}
      </section>
    </>}
  </>;
}
