import { useState } from 'react';
import type { FormEvent } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { supabase } from './lib/supabase';
import { useAuth } from './auth';

export function Login() {
  const auth = useAuth();
  const location = useLocation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const from: unknown = (location.state as { from?: unknown } | null)?.from;
  if (auth.user) return <Navigate replace to={typeof from === 'string' && from.startsWith('/') && !from.startsWith('//') ? from : '/'} />;
  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase || busy) return;
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError(null);
    try {
      const result = await supabase.auth.signInWithPassword({ email: String(form.get('email')).trim(), password: String(form.get('password')) });
      if (result.error) setError('Sign-in failed. Check your email and password, and confirm your account email.');
    } catch { setError('Sign-in is temporarily unavailable. Please try again.'); }
    finally { setBusy(false); }
  }
  return <main className="login-page">
    <div className="brand"><span className="brand-mark" aria-hidden="true">i</span>iGetJobs</div>
    <div><h1>Your client workspace</h1><p>Sign in to discover and save local businesses.</p></div>
    <form className="auth-form" onSubmit={event => void signIn(event)}>
      <label htmlFor="email">Email<input id="email" name="email" type="email" autoComplete="username" required disabled={busy} /></label>
      <label htmlFor="password">Password<input id="password" name="password" type="password" autoComplete="current-password" required disabled={busy} /></label>
      {(error || auth.error) && <p className="form-error" role="alert">{error || auth.error}</p>}
      {!supabase && <p role="alert">Configure the local Supabase connection before signing in.</p>}
      <button className="button" type="submit" disabled={!supabase || busy || auth.loading}>{busy ? 'Signing in…' : auth.loading ? 'Checking session…' : 'Sign in'}</button>
      <p className="auth-help">Use a confirmed email/password account from your Supabase project.</p>
    </form>
  </main>;
}
