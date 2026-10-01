import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { DashboardCounts } from '@igetjobs/shared';
import { api } from './lib/api';
import { EmptyState, PageHeader } from './components';
const cards: { key: keyof DashboardCounts; label: string; query: string }[] = [
  { key: 'total', label: 'Total leads', query: '' }, { key: 'qualified', label: 'Qualified', query: 'status=Qualified' },
  { key: 'noWebsite', label: 'No website', query: 'classification=NO_WEBSITE' }, { key: 'poorWebsite', label: 'Poor website', query: 'classification=POOR_WEBSITE' },
  { key: 'contacted', label: 'Contacted', query: 'status=Contacted' }, { key: 'replied', label: 'Replied', query: 'status=Replied' },
  { key: 'callsBooked', label: 'Calls booked', query: 'status=Call+Booked' }, { key: 'closed', label: 'Closed', query: 'status=Closed' }
];
export function Dashboard() {
  const [counts, setCounts] = useState<DashboardCounts | null>(null), [error, setError] = useState<string | null>(null), [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void api<DashboardCounts>('/api/management/counts', { signal: controller.signal }).then(value => { if (!controller.signal.aborted) { setCounts(value); setError(null); } }).catch((failure: Error) => { if (!controller.signal.aborted) setError(failure.message); });
    return () => controller.abort();
  }, [revision]);
  return <><PageHeader title="Your lead workspace" description="Find the next opportunity, review the evidence, and keep every conversation moving." />
    {error && <p className="message error-message" role="alert">{error} <button className="text-button" onClick={() => setRevision(value => value + 1)}>Retry</button></p>}
    {!counts && !error && <p role="status">Loading your pipeline…</p>}
    {counts && <div className="dashboard-counts">{cards.map(card => <Link className="count-card" key={card.key} to={'/leads' + (card.query ? '?' + card.query : '')}><span>{card.label}</span><strong>{counts[card.key]}</strong><small>View leads →</small></Link>)}</div>}
    {counts?.total === 0 ? <EmptyState title="Your workspace starts with a lead"><p>Search local businesses or import a CSV, review matches, and save your next opportunities.</p><Link className="button" to="/search">Find leads →</Link></EmptyState> : <div className="workspace-note"><span className="note-label">YOUR NEXT STEP</span><p>Review scores, qualify prospects, and record follow-ups.</p><Link className="text-button" to="/leads?sort=score_desc">Review opportunities →</Link></div>}
  </>;
}
