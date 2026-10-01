import { lazy, Suspense, useEffect, useState } from 'react';
import { Link, NavLink, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import type { HealthResponse } from '@igetjobs/shared';
import { supabase } from './lib/supabase';
import { ProtectedRoutes } from './auth';
import { Login } from './Login';
import { PageHeader, EmptyState } from './components';
const Search = lazy(async () => ({ default: (await import('./Search')).Search }));
const Leads = lazy(async () => ({ default: (await import('./Leads')).Leads }));

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
  const [signOutError, setSignOutError] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  async function signOut() {
    setSigningOut(true);
    setSignOutError(false);
    try { const result = await supabase?.auth.signOut({ scope: 'local' }); setSignOutError(Boolean(result?.error)); }
    catch { setSignOutError(true); }
    finally { setSigningOut(false); }
  }
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
      <div className="sidebar-footer"><span className="phase-dot" aria-hidden="true" />Client workspace</div>
    </aside>
    <div className="workspace">
      <header className="topbar">
        <span><span className="muted">Workspace</span><span className="breadcrumb-divider">/</span>{current?.label || (location.pathname.startsWith('/leads/') ? 'Lead detail' : 'Page not found')}</span>
        <div className="topbar-actions"><ApiStatus /><button className="text-button" disabled={signingOut} onClick={() => void signOut()}>{signingOut ? 'Signing out…' : 'Sign out'}</button></div>
      </header>
      <div className="workspace-content">
        <main id="main" tabIndex={-1}>{signOutError && <p className="form-error" role="alert">Sign-out failed. Please try again.</p>}<Suspense fallback={<p role="status">Loading workspace…</p>}><Outlet /></Suspense></main>
        <footer className="workspace-footer">Find the right businesses. Build better websites.</footer>
      </div>
    </div>
  </div>;
}

function Dashboard() {
  return <>
    <PageHeader title="A place for your next opportunity." description="Keep local businesses, website opportunities, and conversations together." />
    <div className="section-heading"><h2>Lead workspace</h2><span className="tag">Discovery ready</span></div>
    <EmptyState title="Your workspace starts here">
      <p>Search local businesses or import your own CSV, review matches, and save selected leads.</p>
      <p>Every result stays unscored until a measurable audit is performed.</p>
      <Link className="button" to="/search">Find leads <span aria-hidden="true">→</span></Link>
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
        ? 'Public connection settings are present. Sign-in was verified for this session; database checks are documented in the setup guide.'
        : 'Add the connection settings using the local setup guide in README.md.'}</p>
    </section>
    <p className="scope-note">Markets, niches, and discovery sources are configured through the local setup guide. Scoring preferences will follow with website auditing.</p>
  </>;
}

export function App() {
  return <Routes>
    <Route path="/login" element={<Login />} />
    <Route element={<ProtectedRoutes />}>
    <Route element={<AppShell />}>
      <Route index element={<Dashboard />} />
      <Route path="search" element={<Search />} />
      <Route path="leads" element={<Leads />} />
      <Route path="leads/:leadId" element={<PlaceholderPage title="Lead detail" description="Business information and opportunity details." emptyTitle="Lead details are not available yet" detail="Contact data, audits, scores, and notes will be connected in later phases." />} />
      <Route path="outreach" element={<PlaceholderPage title="Outreach" description="Prepare personal outreach for human review." emptyTitle="Thoughtful outreach starts with a lead" detail="Editable drafts and approval will be added in Phase 4. Outreach will never auto-send." />} />
      <Route path="settings" element={<Settings />} />
      <Route path="*" element={<><PageHeader title="Page not found" description="This address does not belong to a workspace section." /><Link className="button" to="/">Return to Dashboard</Link></>} />
    </Route>
    </Route>
  </Routes>;
}
