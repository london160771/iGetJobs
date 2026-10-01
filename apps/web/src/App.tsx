import { useEffect, useState } from 'react';
import { Link, NavLink, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import type { HealthResponse } from '@igetjobs/shared';
import { supabase } from './lib/supabase';

const navigation = [
  { path: '/', label: 'Dashboard', number: '01' },
  { path: '/search', label: 'Search', number: '02' },
  { path: '/leads', label: 'Leads', number: '03' },
  { path: '/outreach', label: 'Outreach', number: '04' },
  { path: '/settings', label: 'Settings', number: '05' }
];

function ApiStatus() {
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  useEffect(() => {
    const controller = new AbortController();
    async function check() {
      try {
        const response = await fetch('/api/health', { signal: controller.signal });
        if (!response.ok) throw new Error('API unavailable');
        const health = await response.json() as HealthResponse;
        if (health.status !== 'ok' || health.service !== 'igetjobs-api') throw new Error('Unexpected response');
        setStatus('ready');
      } catch {
        if (!controller.signal.aborted) setStatus('error');
      }
    }
    void check();
    return () => controller.abort();
  }, []);
  return <span className={`connection ${status}`} role="status">
    <span className="connection-dot" aria-hidden="true" />
    {status === 'loading' ? 'Checking API…' : status === 'ready' ? 'API available' : 'API unavailable'}
  </span>;
}

function AppShell() {
  const location = useLocation();
  const current = navigation.find(item => item.path === location.pathname);
  return <div className="app-shell">
    <a className="skip-link" href="#main">Skip to content</a>
    <aside className="sidebar">
      <Link className="brand" to="/" aria-label="iGetJobs dashboard">
        <span className="brand-mark" aria-hidden="true">i</span>
        <span>iGetJobs<span className="brand-subtitle">CLIENT WORKSPACE</span></span>
      </Link>
      <span className="nav-label">WORKSPACE</span>
      <nav aria-label="Main navigation">
        {navigation.map(item => <NavLink key={item.path} to={item.path} end={item.path === '/'}
          className={({ isActive }) => isActive ? 'nav-link active' : 'nav-link'}>
          <span className="nav-number" aria-hidden="true">{item.number}</span>{item.label}
        </NavLink>)}
      </nav>
      <div className="sidebar-footer"><span className="phase-dot" aria-hidden="true" />Phase 0 · Foundation</div>
    </aside>
    <div className="workspace">
      <header className="topbar">
        <span><span className="muted">Workspace</span><span className="breadcrumb-divider">/</span>{current?.label || (location.pathname.startsWith('/leads/') ? 'Lead detail' : 'Page not found')}</span>
        <ApiStatus />
      </header>
      <main id="main" tabIndex={-1}><Outlet /></main>
      <footer className="workspace-footer">Find the right businesses. Build better websites.</footer>
    </div>
  </div>;
}

function PageHeader({ title, description }: { title: string; description: string }) {
  return <div className="page-header"><p className="eyebrow">YOUR WORKSPACE</p><h1>{title}</h1><p>{description}</p></div>;
}

function EmptyState({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="empty-state">
    <div className="empty-icon" aria-hidden="true">
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M4 5h16v14H4zM4 10h16M9 10v9" />
      </svg>
    </div>
    <h2>{title}</h2><div className="empty-description">{children}</div>
  </section>;
}

function Dashboard() {
  return <>
    <PageHeader title="A place for your next opportunity." description="Keep local businesses, website opportunities, and conversations together." />
    <div className="section-heading"><h2>Lead workspace</h2><span className="tag">Foundation preview</span></div>
    <EmptyState title="Your workspace starts here">
      <p>Lead discovery and saved leads will be added in the next approved phases.</p>
      <p>For now, explore the workspace sections.</p>
      <Link className="button" to="/search">Explore Search <span aria-hidden="true">→</span></Link>
    </EmptyState>
    <div className="workspace-note"><span className="note-label">BUILT FOR FOCUS</span><p>Discover. Review. Reach out personally.</p><span className="muted">A simple workflow for your next client.</span></div>
  </>;
}

function PlaceholderPage({ title, description, emptyTitle, detail }: {
  title: string; description: string; emptyTitle: string; detail: string;
}) {
  return <><PageHeader title={title} description={description} /><EmptyState title={emptyTitle}><p>{detail}</p><span className="tag">Coming in a later phase</span></EmptyState></>;
}

function Settings() {
  return <>
    <PageHeader title="Settings" description="A home for your workspace preferences." />
    <section className="settings-panel" aria-labelledby="connection-heading">
      <div><h2 id="connection-heading">Supabase connection</h2><p>Authentication and storage setup</p></div>
      <span className="tag">{supabase ? 'Configured' : 'Not configured'}</span>
      <p className="settings-help">{supabase
        ? 'Public connection settings are present. A live connection has not been verified.'
        : 'Add the connection settings using the local setup guide in README.md.'}</p>
    </section>
    <p className="scope-note">Market, niche, source, and scoring preferences will follow in their approved phases.</p>
  </>;
}

function Login() {
  return <main className="login-page">
    <Link className="brand" to="/"><span className="brand-mark" aria-hidden="true">i</span>iGetJobs</Link>
    <h1>Your client workspace</h1><p>Sign-in will be connected in a later approved phase.</p>
    <Link className="button" to="/">Open foundation preview <span aria-hidden="true">→</span></Link>
  </main>;
}

export function App() {
  return <Routes>
    <Route path="/login" element={<Login />} />
    <Route element={<AppShell />}>
      <Route index element={<Dashboard />} />
      <Route path="search" element={<PlaceholderPage title="Search" description="Find local businesses with website opportunities." emptyTitle="Discovery is next" detail="City, niche, and source search will be added in Phase 1 after review." />} />
      <Route path="leads" element={<PlaceholderPage title="Leads" description="Review and organize businesses worth pursuing." emptyTitle="A home for your leads" detail="Saved lead data and management will arrive in later approved phases." />} />
      <Route path="leads/:leadId" element={<PlaceholderPage title="Lead detail" description="Business information and opportunity details." emptyTitle="Lead details are not available yet" detail="Contact data, audits, scores, and notes will be connected in later phases." />} />
      <Route path="outreach" element={<PlaceholderPage title="Outreach" description="Prepare personal outreach for human review." emptyTitle="Thoughtful outreach starts with a lead" detail="Editable drafts and approval will be added in Phase 4. Outreach will never auto-send." />} />
      <Route path="settings" element={<Settings />} />
      <Route path="*" element={<><PageHeader title="Page not found" description="This address does not belong to a workspace section." /><Link className="button" to="/">Return to Dashboard</Link></>} />
    </Route>
  </Routes>;
}
