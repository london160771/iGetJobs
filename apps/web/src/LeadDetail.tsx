import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { AuditDetail, Lead } from '@igetjobs/shared';
import { api } from './lib/api';
import { PageHeader } from './components';
import { AuditSummary } from './AuditSummary';
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
  const controllerRef = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController(); controllerRef.current = controller;
    void api<AuditDetail>('/api/leads/' + encodeURIComponent(leadId), { signal: controller.signal }).then(value => {
      if (!controller.signal.aborted) { setDetail(value); setSelection(value.resolution.requiresChoice ? '' : value.resolution.candidates[0] || ''); }
    }).catch((failure: Error) => { if (!controller.signal.aborted) setError(failure.message); });
    return () => controller.abort();
  }, [leadId, revision]);
  async function audit() {
    if (!detail || busy) return;
    const controller = controllerRef.current;
    if (!controller) return;
    setBusy(true); setError(null); setSuccess(false);
    try {
      const value = await api<{ lead: Lead }>('/api/leads/' + encodeURIComponent(detail.lead.id) + '/audit', { method: 'POST', body: JSON.stringify(selection ? { website: selection } : {}), signal: controller.signal });
      if (!controller.signal.aborted) { setDetail({ ...detail, lead: value.lead }); setSuccess(true); }
    } catch (failure) { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : 'Audit failed. Please retry.'); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  }
  return <>
    <Link className="text-button" to="/leads">← Saved leads</Link>
    <PageHeader title={detail?.lead.businessName || 'Lead detail'} description={detail ? [detail.lead.niche, detail.lead.city, detail.lead.country].filter(Boolean).join(' · ') : 'Website evidence and opportunity assessment.'} />
    {error && <p className="message error-message" role="alert">{error} <button className="text-button" onClick={() => { setDetail(null); setError(null); setSuccess(false); setRevision(value => value + 1); }} disabled={busy}>Reload lead</button></p>}
    {!detail && !error && <p role="status">Loading lead…</p>}
    {detail && <>
      <section className="audit-panel"><h2>Website evidence</h2><p className="muted">Canonical contact data and linked source websites are checked together. Choose the website to audit when evidence conflicts.</p>
        {detail.resolution.invalidCount > 0 && <p className="row-warning">{detail.resolution.invalidCount} source website value(s) could not be normalized. Select a valid candidate explicitly, or import corrected evidence before auditing. This lead cannot be assumed to have no website.</p>}
        {detail.resolution.requiresChoice && detail.resolution.candidates.length > 0 && <p className="row-warning">Evidence needs review. Your choice is recorded in the audit and does not overwrite source data.</p>}
        {detail.resolution.candidates.length > 0 && <label className="audit-choice">Website to audit<select value={selection} onChange={event => setSelection(event.target.value)} disabled={busy}><option value="">Choose a website…</option>{detail.resolution.candidates.map(url => <option key={url} value={url}>{url}</option>)}</select></label>}
        {detail.resolution.evidence.length === 0 && <p>No website is present in the canonical or preserved source fields. Run the audit to record this finding.</p>}
        <ul className="evidence-list">{detail.resolution.evidence.map((evidence, index) => <li key={index}><span className="tag">{evidence.source}</span> {evidence.url || 'Invalid website value (not used)'}<small>{evidence.path} · {evidence.sourceId || 'No source identifier'}</small></li>)}</ul>
        <button className="button" disabled={busy || (detail.resolution.requiresChoice && !selection) || (detail.resolution.candidates.length > 0 && !selection)} onClick={() => void audit()}>{busy ? 'Auditing website…' : detail.lead.audit ? 'Run audit again' : 'Audit website'}</button>
        <p className="muted">One bounded request chain; no scripts or assets run. Static checks cannot verify rendered mobile layout or actual CTA behavior.</p>
      </section>
      {success && <p className="message success-message" role="status">Audit, classification, and score saved.</p>}
      <section className="audit-panel"><h2>Opportunity assessment</h2><AuditSummary lead={detail.lead} detailed /></section>
      <section className="audit-panel"><h2>Contact</h2><p>{detail.lead.address || 'No address recorded'}</p><div className="lead-contact">{detail.lead.phone && <span>{detail.lead.phone}</span>}{detail.lead.email && <span>{detail.lead.email}</span>}</div><p className="muted">Source contact data; not independently verified.</p></section>
    </>}
  </>;
}
