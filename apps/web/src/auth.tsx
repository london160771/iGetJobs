import { createContext, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { supabase } from './lib/supabase';
import { AuthSession, type AuthState } from './lib/auth-session';

const AuthContext = createContext<AuthState>({ user: null, loading: true, error: null });

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ user: null, loading: Boolean(supabase), error: supabase ? null : 'Supabase is not configured.' });
  useEffect(() => {
    const client = supabase;
    if (!client) return;
    let active = true;
    let eventReceived = false;
    const sessionState = new AuthSession({ user: null, loading: true, error: null }, setState, async session => {
      const result = await client.auth.getUser(session.access_token);
      return { user: result.error ? null : result.data.user, unavailable: Boolean(result.error &&
        (result.error.name === 'AuthRetryableFetchError' || (result.error.status ?? 0) >= 500)) };
    });
    const { data: { subscription } } = client.auth.onAuthStateChange((_event, session) => {
      // Keep SDK calls outside its auth event lock, and ignore stale responses.
      eventReceived = true;
      queueMicrotask(() => { if (active) void sessionState.verify(session); });
    });
    void client.auth.getSession().then(({ data, error }) => {
      if (active && !eventReceived) {
        if (error) setState({ user: null, loading: false, error: 'Please sign in again.' });
        else void sessionState.verify(data.session);
      }
    }).catch(() => {
      if (active && !eventReceived) setState({ user: null, loading: false, error: 'Authentication is temporarily unavailable.' });
    });
    return () => { active = false; sessionState.dispose(); subscription.unsubscribe(); };
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
  return <Outlet key={auth.user.id} />;
}
