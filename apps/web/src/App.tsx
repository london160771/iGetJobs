import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import type { HealthResponse } from '@igetjobs/shared';
import { supabase } from './lib/supabase';
import { ProtectedRoutes } from './auth';
import { Login } from './Login';
import { PageHeader } from './components';
const Search = lazy(async () => ({ default: (await import('./Search')).Search }));
const Leads = lazy(async () => ({ default: (await import('./Leads')).Leads }));
const LeadDetail = lazy(async () => ({ default: (await import('./LeadDetail')).LeadDetail }));
const Dashboard = lazy(async () => ({ default: (await import('./Dashboard')).Dashboard }));
const Outreach = lazy(async () => ({ default: (await import('./Outreach')).Outreach }));

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
        const response = await fetch('/api/health', { signal: AbortSignal.any([controller.signal,AbortSignal.timeout(90000)]) });
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
  const mobileQuery = '(max-width: 760px), (max-width: 960px) and (max-height: 500px)';
  const [mobile, setMobile] = useState(() => window.matchMedia(mobileQuery).matches);
  const [drawerLocation, setDrawerLocation] = useState<string | null>(null);
  const drawerOpen = mobile && drawerLocation === location.key;
  const sidebarRef = useRef<HTMLElement>(null);
  const menuRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const media = window.matchMedia(mobileQuery);
    const resize = () => { setMobile(media.matches); setDrawerLocation(null); };
    const close = () => setDrawerLocation(null);
    media.addEventListener('change', resize);
    window.addEventListener('popstate', close);
    return () => { media.removeEventListener('change', resize); window.removeEventListener('popstate', close); };
  }, []);
  useLayoutEffect(() => {
    if (!drawerOpen) return;
    const sidebar = sidebarRef.current!;
    const close = closeRef.current!;
    const menu = menuRef.current;
    const main = mainRef.current;
    sidebar.scrollTop = 0;
    // Focus after the off-canvas visibility change has reached the browser frame.
    const frame = requestAnimationFrame(() => close.focus({ preventScroll: true }));
    function keepFocus(event: FocusEvent) {
      if (!sidebar.contains(event.target as Node)) close.focus({ preventScroll: true });
    }
    function keyboard(event: KeyboardEvent) {
      if (event.key === 'Escape') { event.preventDefault(); setDrawerLocation(null); }
      if (event.key !== 'Tab') return;
      const items = [...sidebar.querySelectorAll<HTMLElement>('a[href],button:not([disabled])')];
      const first = items[0]!, last = items.at(-1)!;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
    document.addEventListener('focusin', keepFocus);
    document.addEventListener('keydown', keyboard);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('focusin', keepFocus);
      document.removeEventListener('keydown', keyboard);
      // Wait until React removes workspace inertness before restoring focus.
      queueMicrotask(() => {
        if (!menu?.isConnected) return;
        (menu.getClientRects().length ? menu : main)?.focus({ preventScroll: true });
      });
    };
  }, [drawerOpen]);
  const [signOutError, setSignOutError] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  async function signOut() {
    setSigningOut(true);
    setSignOutError(false);
    try { const result = await supabase?.auth.signOut({ scope: 'local' }); setSignOutError(Boolean(result?.error)); }
    catch { setSignOutError(true); }
    finally { setSigningOut(false); }
  }
  return <div className={`app-shell${drawerOpen ? ' drawer-is-open' : ''}`}>
    <a className="skip-link" href="#main" inert={drawerOpen}>Skip to content</a>
    {drawerOpen && <div className="drawer-backdrop" aria-hidden="true" onClick={() => setDrawerLocation(null)} />}
    <aside id="workspace-navigation" ref={sidebarRef} className={`sidebar${drawerOpen ? ' drawer-open' : ''}`}
      role={mobile ? 'dialog' : undefined} aria-label={mobile ? 'Workspace navigation' : undefined}
      aria-modal={drawerOpen || undefined} aria-hidden={mobile && !drawerOpen || undefined} inert={mobile && !drawerOpen}>
      <div className="sidebar-heading"><Link className="brand" to="/" aria-label="iGetJobs dashboard" onClick={() => setDrawerLocation(null)}>
        <span className="brand-mark" aria-hidden="true">i</span>
        <span>iGetJobs<span className="brand-subtitle">CLIENT WORKSPACE</span></span>
      </Link><button ref={closeRef} className="drawer-close" aria-label="Close navigation" onClick={() => setDrawerLocation(null)}><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg></button></div>
      <span className="nav-label">WORKSPACE</span>
      <nav aria-label="Main navigation">
        {navigation.map(item => <NavLink key={item.path} to={item.path} end={item.path === '/'}
          className={({ isActive }) => isActive ? 'nav-link active' : 'nav-link'} onClick={() => setDrawerLocation(null)}>
          <span className="nav-number" aria-hidden="true">{item.number}</span>{item.label}
        </NavLink>)}
      </nav>
      <div className="sidebar-footer"><span className="phase-dot" aria-hidden="true" />Client workspace</div>
    </aside>
    <div className="workspace" inert={drawerOpen}>
      <header className="topbar">
        <div className="topbar-location"><button ref={menuRef} className="menu-button" aria-label="Open navigation" aria-controls="workspace-navigation" aria-expanded={drawerOpen} onClick={() => setDrawerLocation(location.key)}><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16" /></svg></button><span><span className="muted breadcrumb-workspace">Workspace</span><span className="breadcrumb-divider">/</span>{current?.label || (location.pathname.startsWith('/leads/') ? 'Lead detail' : 'Page not found')}</span></div>
        <div className="topbar-actions"><ApiStatus /><button className="text-button" disabled={signingOut} onClick={() => void signOut()}>{signingOut ? 'Signing out…' : 'Sign out'}</button></div>
      </header>
      <div className="workspace-content" role="region" aria-label="Workspace content" tabIndex={0}>
        <main ref={mainRef} id="main" tabIndex={-1}>{signOutError && <p className="form-error" role="alert">Sign-out failed. Please try again.</p>}<Suspense fallback={<p role="status">Loading workspace…</p>}><Outlet /></Suspense></main>
        <footer className="workspace-footer">Find the right businesses. Build better websites.</footer>
      </div>
    </div>
  </div>;
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
    <p className="scope-note">Markets, niches, discovery sources, and audit scoring weights are configured through the local setup guide. Each audit records the weights and thresholds it used.</p>
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
      <Route path="leads/:leadId" element={<LeadDetail />} />
      <Route path="outreach" element={<Outreach />} />
      <Route path="settings" element={<Settings />} />
      <Route path="*" element={<><PageHeader title="Page not found" description="This address does not belong to a workspace section." /><Link className="button" to="/">Return to Dashboard</Link></>} />
    </Route>
    </Route>
  </Routes>;
}
