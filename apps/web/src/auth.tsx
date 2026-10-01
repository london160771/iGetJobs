import { createContext, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { Session, User } from '@supabase/supabase-js';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { supabase } from './lib/supabase';

interface AuthState { user: User | null; loading: boolean; error: string | null }
const AuthContext = createContext<AuthState>({ user: null, loading: true, error: null });

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ user: null, loading: Boolean(supabase), error: supabase ? null : 'Supabase is not configured.' });
  useEffect(() => {
    const client = supabase;
    if (!client) return;
    let active = true;
    let revision = 0;
    async function verify(session: Session | null) {
      const current = ++revision;
      setState({ user: null, loading: true, error: null });
      try {
        const result = session ? await client!.auth.getUser(session.access_token) : null;
        if (active && current === revision) {
          setState({ user: result?.error ? null : result?.data.user || null, loading: false,
            error: result?.error ? 'Your session could not be verified. Please sign in again.' : null });
        }
      } catch {
        if (active && current === revision) setState({ user: null, loading: false, error: 'Authentication is temporarily unavailable.' });
      }
    }
    const { data: { subscription } } = client.auth.onAuthStateChange((_event, session) => {
      // Keep SDK calls outside its auth event lock, and ignore stale responses.
      queueMicrotask(() => { if (active) void verify(session); });
    });
    void client.auth.getSession().then(({ data, error }) => {
      if (active && revision === 0) {
        if (error) setState({ user: null, loading: false, error: 'Please sign in again.' });
        else void verify(data.session);
      }
    }).catch(() => {
      if (active && revision === 0) setState({ user: null, loading: false, error: 'Authentication is temporarily unavailable.' });
    });
    return () => { active = false; subscription.unsubscribe(); };
  }, []);
  return <AuthContext.Provider value={state}>{children}</AuthContext.Provider>;
}

// Separate exports are shared by the route guard and sign-in UI.
// eslint-disable-next-line react-refresh/only-export-components
export function useAuth() { return useContext(AuthContext); }

export function ProtectedRoutes() {
  const auth = useAuth();
  const location = useLocation();
  if (auth.loading) return <main className="login-page" role="status"><p>Verifying your session…</p></main>;
  if (!auth.user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return <Outlet />;
}
