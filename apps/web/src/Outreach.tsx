import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { copyOutreachDraft, type Lead, type OutreachPage, type OutreachTab } from '@igetjobs/shared';
import { api } from './lib/api';
import { EmptyState, PageHeader } from './components';

export function Outreach() {
  const [params,setParams] = useSearchParams(), tab = (params.get('tab') || 'Ready') as OutreachTab;
  const [loaded,setLoaded] = useState<{ query:string; value:OutreachPage } | null>(null), [error,setError] = useState<string | null>(null);
  const [message,setMessage] = useState<string | null>(null), [revision,setRevision] = useState(0), [busy,setBusy] = useState<string | null>(null);
  const query = new URLSearchParams({ tab,page:params.get('page') || '1',today:new Date().toLocaleDateString('en-CA') }).toString();
  useEffect(() => {
    const controller = new AbortController();
    void api<OutreachPage>('/api/outreach?' + query,{ signal:controller.signal }).then(value => { if (!controller.signal.aborted) { setLoaded({ query,value }); setError(null); } }).catch((failure:Error) => { if (!controller.signal.aborted) { setLoaded(null); setError(failure.message); } });
    return () => controller.abort();
  },[query,revision]);
  const data = loaded?.query === query ? loaded.value : null;
  async function contacted(id:string,expectedUpdatedAt:string) {
    if (busy) return; setBusy(id); setError(null); setMessage(null);
    try { await api<{ lead:Lead }>('/api/outreach/' + id + '/contacted',{ method:'POST',body:JSON.stringify({ expectedUpdatedAt }) }); setMessage('Marked Contacted. No message was sent.'); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Status could not be saved.'); }
    finally { setLoaded(null); setRevision(value => value + 1); setBusy(null); }
  }
  async function copy(id:string,expectedUpdatedAt:string) {
    if (busy) return; setBusy(id); setError(null); setMessage(null);
    try {
      const result = await api<{ lead:Lead }>('/api/outreach/' + id + '/copy',{ method:'POST',body:JSON.stringify({ expectedUpdatedAt }) });
      await copyOutreachDraft(result.lead.outreachDraft,true,navigator.clipboard); setMessage('Reviewed draft copied. Nothing was sent.');
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Copy failed.'); setLoaded(null); setRevision(value => value + 1); }
    finally { setBusy(null); }
  }
  return <><PageHeader title="Outreach" description="Prepare a reviewed draft, copy it, and record contact manually." />
    <div className="outreach-tabs" role="group" aria-label="Outreach views">{(['Ready','Contacted','Follow-up Due'] as const).map(value => <button key={value} aria-pressed={tab === value} className={tab === value ? 'button' : 'text-button'} onClick={() => { setParams({ tab:value }); setMessage(null); }}>{value}</button>)}</div>
    {error && <p className="message error-message" role="alert">{error} <button className="text-button" onClick={() => setRevision(value => value + 1)}>Reload</button></p>}
    {message && <p className="message" role="status">{message}</p>}
    {!data && !error && <p role="status">Loading outreach leads…</p>}
    {data && data.total === 0 && <EmptyState title={'No leads in ' + tab}><p>Ready shows assessed Medium/High opportunities (or manually Qualified leads). Reaudit invalidated leads before preparing outreach.</p><Link className="button" to="/leads">Review leads →</Link></EmptyState>}
    {data && <><p className="muted">{data.total} leads · Drafts require review. Status changes never send a message.</p><div className="outreach-list">{data.items.map(item => <article className="audit-panel" key={item.lead.id}>
      <div className="lead-title"><h2><Link className="lead-business" to={'/leads/' + item.lead.id}>{item.lead.businessName}</Link></h2><span className="tag">{item.lead.classification?.replace(/_/g,' ') || 'Not audited'}</span><strong>{item.lead.score ?? '—'}/100</strong><span className="tag">{item.lead.priority || 'Unscored'} · {item.lead.status}</span></div>
      <p>{[item.lead.niche,item.lead.city,item.lead.country].filter(Boolean).join(' · ')}</p><p><strong>Reason:</strong> {item.reason || 'No current assessment. Review lead evidence.'}</p>
      <p>Email: {item.lead.email || 'Not recorded'} · Phone: {item.lead.phone || 'Not recorded'}{item.lead.followUpAt && ' · Follow-up: ' + item.lead.followUpAt.slice(0,10)}</p>
      {item.draft ? <><p className={item.current ? 'muted' : 'row-warning'}>{item.current ? item.draft.edited ? 'User-edited' : 'Generated' : 'Stale / review required'} · {item.current ? item.draft.approval : 'Approval revoked'}</p><details><summary>Draft preview</summary><pre className="provenance-data">Subject: {item.draft.subject}{'\n\n'}{item.draft.body}</pre></details></> : <p>No draft yet. Generate and edit it in Lead Detail.</p>}
      <div className="management-actions"><Link className="button" to={'/leads/' + item.lead.id}>Review / edit draft</Link><button className="text-button" disabled={Boolean(busy) || !item.current || item.draft?.approval !== 'approved'} onClick={() => void copy(item.lead.id,item.lead.updatedAt)}>Copy reviewed draft</button><button className="text-button" disabled={Boolean(busy) || item.lead.status === 'Contacted' || ['Closed','Lost'].includes(item.lead.status)} onClick={() => void contacted(item.lead.id,item.lead.updatedAt)}>Mark Contacted</button></div>
    </article>)}</div>{data.total > 0 && <div className="pagination"><span>Page {data.page} of {Math.ceil(data.total/data.pageSize)}</span><div>{data.page > 1 && <button className="text-button" onClick={() => setParams({ tab,page:String(data.page-1) })}>← Previous</button>}{data.page*data.pageSize < data.total && <button className="text-button" onClick={() => setParams({ tab,page:String(data.page+1) })}>Next →</button>}</div></div>}</>}
  </>;
}
