import { useEffect, useRef, useState, type FormEvent } from 'react';
import { copyOutreachDraft, currentDraft, draftLimits, templateText, worthPursuing, type Lead } from '@igetjobs/shared';
import { api, ApiRequestError } from './lib/api';

export function OutreachEditor({ lead, busy, blocked, onBusy, onSaved, onUncertain, onDirty }: { lead: Lead; busy: boolean; blocked: boolean; onBusy(value: boolean): void; onSaved(lead: Lead): void; onUncertain(): void; onDirty(value: boolean): void }) {
  const [error,setError] = useState<string | null>(null), [message,setMessage] = useState<string | null>(null);
  const [edited,setEdited] = useState(false), [configured,setConfigured] = useState(false);
  const [aiConfigured,setAiConfigured] = useState(false), [aiBusy,setAiBusy] = useState(false);
  const [suggestion,setSuggestion] = useState<{ subject:string; body:string } | null>(null);
  const [replace,setReplace] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const subjectRef = useRef<HTMLInputElement | null>(null), bodyRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    const request = new AbortController(); controller.current = request;
    void api<{ hunterConfigured:boolean }>('/api/outreach/config',{ signal:request.signal }).then(result => { if (!request.signal.aborted) setConfigured(result.hunterConfigured); }).catch(() => {});
    void api<{ configured:boolean }>('/api/ai/config',{ signal:request.signal }).then(result => { if (!request.signal.aborted) setAiConfigured(result.configured); }).catch(() => {});
    return () => request.abort();
  },[]);
  const draft = lead.outreachDraft, current = currentDraft(lead), generated = templateText(lead);
  async function action(name: string, input: Record<string, unknown> = {}) {
    if (busy || blocked || !controller.current) return;
    const signal = controller.current.signal; onBusy(true); setError(null); setMessage(null); setSuggestion(null);
    try {
      const result = await api<{ lead:Lead }>('/api/outreach/' + lead.id + '/' + name,{ method:'POST',body:JSON.stringify({ expectedUpdatedAt:lead.updatedAt,...input }),signal });
      if (!signal.aborted) { setEdited(false); setReplace(false); onDirty(false); onSaved(result.lead); }
    } catch (failure) {
      if (!signal.aborted) { setError(failure instanceof Error ? failure.message : 'Outreach changes failed.'); if (!(failure instanceof ApiRequestError) || ![400,429].includes(failure.status)) onUncertain(); }
    } finally { if (!signal.aborted) onBusy(false); }
  }
  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const data = new FormData(event.currentTarget);
    void action('save',{ subject:data.get('subject'),body:data.get('body'),approve:data.get('approve') === 'on' });
  }
  async function copy() {
    if (busy || blocked || edited || !controller.current) return;
    const signal = controller.current.signal; onBusy(true);
    try {
      const result = await api<{ lead:Lead }>('/api/outreach/' + lead.id + '/copy',{ method:'POST',body:JSON.stringify({ expectedUpdatedAt:lead.updatedAt }),signal });
      if (!signal.aborted) { await copyOutreachDraft(result.lead.outreachDraft,currentDraft(result.lead),navigator.clipboard); setMessage('Reviewed draft copied. Nothing was sent.'); setError(null); }
    } catch (failure) { if (!signal.aborted) { setError(failure instanceof Error ? failure.message : 'Copy failed.'); if (failure instanceof ApiRequestError && failure.status === 409) onUncertain(); } }
    finally { if (!signal.aborted) onBusy(false); }
  }
  async function polish() {
    if (busy || blocked || aiBusy || !aiConfigured || !current || !subjectRef.current || !bodyRef.current || !controller.current) return;
    setAiBusy(true); onBusy(true); setError(null); setSuggestion(null);
    try {
      const result = await api<{ subject:string; body:string }>('/api/ai/' + lead.id + '/polish',{
        method:'POST',signal:controller.current.signal,
        body:JSON.stringify({ expectedUpdatedAt:lead.updatedAt,subject:subjectRef.current.value,body:bodyRef.current.value })
      });
      if (!controller.current.signal.aborted) setSuggestion(result);
    } catch (failure) { if (!controller.current?.signal.aborted) setError(failure instanceof Error ? failure.message : 'AI polish is unavailable. Your draft is unchanged.'); }
    finally { setAiBusy(false); onBusy(false); }
  }
  function useSuggestion() {
    if (!suggestion || !subjectRef.current || !bodyRef.current) return;
    subjectRef.current.value = suggestion.subject; bodyRef.current.value = suggestion.body;
    setSuggestion(null); setEdited(true); onDirty(true); setMessage('AI wording placed in the editor. Review and save it manually. Nothing was sent.');
  }
  const disabled = busy || blocked || aiBusy, enrichment = lead.contactEnrichment;
  return <section className="audit-panel"><h2>Outreach draft</h2>
    <p className="muted">Review the evidence and every sentence before copying. Drafts are plain text; sending remains your manual action.</p>
    {!generated && <p>No current outreach opportunity assessment. Review website evidence and run an audit first.</p>}
    {draft && <>
      <p className={current ? 'muted' : 'row-warning'}>{current ? draft.edited ? 'User-edited draft' : 'Generated draft' : 'Stale / review required — saved text is preserved, but cannot be approved or copied.'} · {draft.approval === 'approved' && current ? 'Reviewed and approved' : 'Awaiting review'}</p>
      <p><strong>Reason to contact:</strong> {generated?.reason || 'Assessment unavailable; reaudit before using the draft.'}</p>
      <form className="management-form" onSubmit={save} onChange={() => { setEdited(true); onDirty(true); setMessage(null); setSuggestion(null); }}>
        <fieldset disabled={disabled || !current}><legend className="sr-only">Editable outreach draft</legend>
          <label className="notes-field">Subject<input ref={subjectRef} name="subject" maxLength={draftLimits.subject} defaultValue={draft.subject} required /></label>
          <div className="notes-field"><label htmlFor={'outreach-body-' + lead.id}>Message</label><textarea ref={bodyRef} id={'outreach-body-' + lead.id} name="body" rows={10} maxLength={draftLimits.body} defaultValue={draft.body} required /></div>
          <label className="review-check"><input name="approve" type="checkbox" defaultChecked={draft.approval === 'approved'} />I reviewed the current evidence and this draft for manual outreach.</label>
          <div className="management-actions"><button className="button" type="submit">Save draft / review</button><button className="text-button" type="reset" onClick={() => { setEdited(false); onDirty(false); }}>Discard draft edits</button></div>
        </fieldset>
      </form>
      <div className="ai-assist"><button className="text-button" disabled={disabled || aiBusy || !current || !aiConfigured} onClick={() => void polish()}>{aiBusy ? 'Polishing…' : 'Polish with AI'}</button>
        {!aiConfigured && <small>AI assist is disabled; the deterministic draft remains available.</small>}
        {suggestion && <div className="ai-suggestion" role="status"><p><strong>AI-generated suggestion · not saved</strong></p><pre className="provenance-data">Subject: {suggestion.subject}{'\n\n'}{suggestion.body}</pre><button className="button" disabled={disabled} onClick={useSuggestion}>Use suggestion in editor</button><button className="text-button" onClick={() => setSuggestion(null)}>Discard suggestion</button></div>}
      </div>
      {!current && <details><summary>Preserved draft text</summary><pre className="provenance-data">Subject: {draft.subject}{'\n\n'}{draft.body}</pre></details>}
      <button className="text-button" disabled={disabled || edited || !current || draft.approval !== 'approved'} onClick={() => void copy()}>Copy reviewed draft</button>
    </>}
    {generated && <div className="outreach-generation">{(draft?.edited || edited) && <label className="review-check"><input type="checkbox" checked={replace} onChange={event => setReplace(event.target.checked)} />Replace my edits with a newly generated draft.</label>}
      <button className="button" disabled={disabled || ((draft?.edited || edited) && !replace)} onClick={() => void action('generate',{ replaceEdited:replace })}>{draft ? 'Regenerate draft' : 'Generate draft'}</button></div>}
    <div className="contact-enrichment"><h3>Contact fallback</h3><p className="muted">Hunter is optional, explicit and restricted to worthwhile leads without an email. It searches a recorded domain, never guesses a company match. Provider candidates are not verified delivery guarantees.</p>
      {!configured && <p>Hunter is disabled. A verified Free-plan credential is required; no provider calls are made.</p>}
      {lead.email ? <p>Email already recorded: {lead.email}. No Hunter lookup needed.</p> : <>
        {enrichment && <p role="status">Last Hunter attempt: {enrichment.state.replace('_',' ')} · {enrichment.domain}. {enrichment.state === 'quota' ? 'Free quota/plan protection blocked the lookup.' : enrichment.state === 'no_result' ? 'No safe matching generic contact was returned.' : enrichment.state === 'pending' ? 'Outcome is uncertain. Reload before an explicit retry.' : enrichment.state === 'error' ? 'Provider unavailable; no contact accepted.' : ''}</p>}
        {enrichment?.state === 'found' && <p>Candidate: {enrichment.email} · provider confidence {enrichment.confidence}/100. <button className="text-button" disabled={disabled || edited} onClick={() => void action('acceptEmail')}>Use email (clears assessment)</button></p>}
        {!lead.audit?.requestedWebsite && <p>No audited business domain is available for lookup.</p>}
        <button className="text-button" disabled={disabled || edited || !configured || !worthPursuing(lead) || !lead.audit?.requestedWebsite} onClick={() => void action('enrich',{ retry:Boolean(enrichment) })}>{enrichment ? 'Explicitly retry Hunter lookup' : 'Find email with Hunter'}</button>
      </>}
    </div>
    <button className="text-button" disabled={disabled || edited || lead.status === 'Contacted' || ['Closed','Lost'].includes(lead.status)} onClick={() => void action('contacted')}>Mark Contacted manually</button>
    {error && <p className="message error-message" role="alert">{error}</p>}{message && <p role="status">{message}</p>}
  </section>;
}
