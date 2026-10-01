import { useEffect, useState } from 'react';
import type { Lead } from '@igetjobs/shared';
import { Link } from 'react-router-dom';
import { api } from './lib/api';
import { EmptyState, PageHeader } from './components';
export function Leads() {
  const [leads, setLeads] = useState<Lead[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    void api<{ leads: Lead[] }>('/api/leads').then(value => { if (active) { setLeads(value.leads); setError(null); } }).catch((failure: Error) => { if (active) setError(failure.message); });
    return () => { active = false; };
  }, [revision]);
  return <><PageHeader title="Saved leads" description="Your latest 100 collected businesses. Audits, scoring, and lead management follow in later phases." />
    {error && <p className="message error-message" role="alert">{error} <button className="text-button" onClick={() => setRevision(value => value + 1)}>Retry</button></p>}
    {!leads && !error && <p role="status">Loading saved leads…</p>}
    {leads?.length === 0 && <EmptyState title="Your next lead is waiting"><p>Search a city or import a CSV, then review and save your results.</p><Link to="/search" className="button">Find leads →</Link></EmptyState>}
    {leads && leads.length > 0 && <div className="lead-results">{leads.map(lead => <article className="lead-result" key={lead.id}><div className="lead-result-main"><div className="lead-title"><h3>{lead.businessName}</h3><span className="tag">{lead.source}</span><span className="tag">Not audited</span></div><p className="muted">{[lead.niche, lead.city, lead.country].filter(Boolean).join(' · ')}</p>{lead.address && <p>{lead.address}</p>}<div className="lead-contact">{lead.website ? <a href={lead.website} target="_blank" rel="noreferrer">{lead.domain} ↗</a> : <span className="muted">No website in source</span>}{lead.phone && <span>{lead.phone}</span>}{lead.email && <span>{lead.email}</span>}</div><p className="muted">{lead.provenance.length} source record{lead.provenance.length === 1 ? '' : 's'} preserved</p></div></article>)}</div>}
  </>;
}
