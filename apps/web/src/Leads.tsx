import { useEffect, useState, type FormEvent } from 'react';
import { classifications, followUpState, leadStatuses, type LeadPage } from '@igetjobs/shared';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from './lib/api';
import { EmptyState, PageHeader } from './components';

export function Leads() {
  const [params, setParams] = useSearchParams();
  const query = params.toString();
  const hasFilters = [...params.keys()].some(key => !['page', 'sort'].includes(key));
  const [loaded, setLoaded] = useState<{ query: string; data: LeadPage } | null>(null);
  const [error, setError] = useState<{ query: string; message: string } | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void api<LeadPage>('/api/management/leads?' + query, { signal: controller.signal }).then(data => {
      if (!controller.signal.aborted) { setLoaded({ query, data }); setError(null); }
    }).catch((failure: Error) => { if (!controller.signal.aborted) setError({ query, message: failure.message }); });
    return () => controller.abort();
  }, [query, revision]);
  const data = loaded?.query === query ? loaded.data : null;
  const failure = error?.query === query ? error.message : null;
  const options = loaded?.data.options;
  function apply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const next = new URLSearchParams();
    for (const [key, value] of new FormData(event.currentTarget)) if (typeof value === 'string' && value.trim()) next.set(key, value.trim());
    if (params.get('sort')) next.set('sort', params.get('sort')!);
    setParams(next);
  }
  const select = (name: string, label: string, values: readonly string[], format = (value: string) => value) => {
    const selected = params.get(name) || '', choices = selected && !values.includes(selected) ? [...values, selected] : values;
    return <label>{label}<select name={name} defaultValue={selected}><option value="">Any</option>{choices.map(value => <option key={value} value={value}>{format(value)}</option>)}</select></label>;
  };
  const pageUrl = (page: number) => { const next = new URLSearchParams(params); next.set('page', String(page)); return '/leads?' + next; };
  const today = new Date().toLocaleDateString('en-CA');
  return <><PageHeader title="Leads" description="Review opportunities, manage your pipeline, and keep the next follow-up in view." />
    <form key={query + (options ? ':ready' : ':loading')} className="management-filters" onSubmit={apply}>
      <details open={hasFilters}><summary>Filter leads</summary><div className="management-fields">
        {select('niche', 'Niche', options?.niches || [])}{select('country', 'Country', options?.countries || [])}{select('city', 'City', options?.cities || [])}
        {select('classification', 'Classification', [...classifications, 'UNAUDITED'], value => value === 'UNAUDITED' ? 'Not audited' : value.replace(/_/g, ' '))}
        <label>Minimum score<input name="minScore" type="number" min="0" max="100" defaultValue={params.get('minScore') || ''} placeholder="0" /></label>
        <label>Maximum score<input name="maxScore" type="number" min="0" max="100" defaultValue={params.get('maxScore') || ''} placeholder="100" /></label>
        {select('priority', 'Priority', ['High', 'Medium', 'Low'])}{select('status', 'Pipeline status', leadStatuses)}{select('source', 'Source', ['GEOAPIFY', 'OSM', 'SERPAPI', 'CSV'])}
        {select('hasEmail', 'Has email', ['yes', 'no'], value => value === 'yes' ? 'Yes' : 'No')}{select('hasPhone', 'Has phone', ['yes', 'no'], value => value === 'yes' ? 'Yes' : 'No')}
      </div><div className="management-actions"><button className="button" type="submit">Apply filters</button><button className="text-button" type="button" onClick={() => setParams({})}>Clear filters</button></div></details>
    </form>
    <div className="results-heading"><p role="status">{data ? `${data.total} matching lead${data.total === 1 ? '' : 's'}` : failure ? 'Leads unavailable' : 'Loading leads…'}</p>
      <label className="sort-control">Sort by <select value={params.get('sort') || 'newest'} onChange={event => { const next = new URLSearchParams(params); next.set('sort', event.target.value); next.delete('page'); setParams(next); }}><option value="score_desc">Score: highest first</option><option value="score_asc">Score: lowest first</option><option value="newest">Newest first</option><option value="oldest">Oldest first</option><option value="updated">Recently updated</option><option value="name">Business name</option></select></label>
    </div>
    {failure && <p className="message error-message" role="alert">{failure} <button className="text-button" onClick={() => setRevision(value => value + 1)}>Retry</button></p>}
    {data && data.total === 0 && <EmptyState title={hasFilters ? 'No leads match these filters' : 'Your next lead is waiting'}><p>{hasFilters ? 'Clear or adjust the filters to see more leads.' : 'Search a city or import a CSV, then review and save your results.'}</p>{hasFilters ? <button className="text-button" onClick={() => setParams({})}>Clear filters</button> : <Link to="/search" className="button">Find leads →</Link>}</EmptyState>}
    {data && data.total > 0 && <>
      <table className="leads-table"><caption className="sr-only">Saved leads and opportunity assessments</caption><thead><tr>{['Business', 'Niche', 'Location', 'Classification', 'Score', 'Priority', 'Status', 'Source', 'Updated'].map(label => <th key={label} scope="col">{label}</th>)}</tr></thead><tbody>
        {data.leads.map(lead => <tr key={lead.id}>
          <td data-label="Business"><Link className="lead-business" to={'/leads/' + lead.id}>{lead.businessName}</Link>{lead.followUpAt && <small className={followUpState(lead.followUpAt, today) === 'Overdue' ? 'row-warning' : 'muted'}>{followUpState(lead.followUpAt, today)} · {lead.followUpAt.slice(0, 10)}</small>}</td>
          <td data-label="Niche">{lead.niche || '—'}</td><td data-label="Location">{[lead.city, lead.country].filter(Boolean).join(', ') || '—'}</td>
          <td data-label="Classification">{lead.classification ? <span className={'tag classification-' + lead.classification.toLowerCase()}>{lead.classification.replace(/_/g, ' ')}</span> : <span className="muted">Not audited</span>}</td>
          <td data-label="Score"><strong>{lead.score ?? '—'}</strong></td><td data-label="Priority">{lead.priority || '—'}</td><td data-label="Status">{lead.status}</td><td data-label="Source">{lead.source}</td>
          <td data-label="Updated"><time dateTime={lead.updatedAt}>{new Date(lead.updatedAt).toLocaleDateString()}</time></td>
        </tr>)}
      </tbody></table>
      <div className="pagination"><span>Page {data.page} of {Math.max(1, Math.ceil(data.total / data.pageSize))}</span><div>{data.page > 1 && <Link className="text-button" to={pageUrl(data.page - 1)}>← Previous</Link>}{data.page * data.pageSize < data.total && <Link className="text-button" to={pageUrl(data.page + 1)}>Next →</Link>}</div></div>
    </>}
  </>;
}
