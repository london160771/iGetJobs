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
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const from: unknown = (location.state as { from?: unknown } | null)?.from;
  if (auth.user) return <Navigate replace to={typeof from === 'string' && from.startsWith('/') && !from.startsWith('//') ? from : '/'} />;
  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase || busy) return;
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const credentials = { email: String(form.get('email')).trim(), password: String(form.get('password')) };
      const result = creating ? await supabase.auth.signUp(credentials) : await supabase.auth.signInWithPassword(credentials);
      if (result.error) setError(creating ? 'Account creation failed. Check your details or try again later.' : 'Sign-in failed. Check your email and password, and confirm your account email.');
      else if (creating && !result.data.session) setNotice('Check your email to confirm your account, then sign in. If you already have an account, use Sign in.');
    } catch { setError('Authentication is temporarily unavailable. Please try again.'); }
    finally { setBusy(false); }
  }
  return <main className="login-page">
    <div className="brand"><span className="brand-mark" aria-hidden="true">i</span>iGetJobs</div>
    <div><h1>Your client workspace</h1><p>Sign in to discover and save local businesses.</p></div>
    <form className="auth-form" onSubmit={event => void signIn(event)} aria-busy={busy}>
      <label htmlFor="email">Email<input id="email" name="email" type="email" autoComplete="username" required disabled={busy} /></label>
      <label htmlFor="password">Password<input id="password" name="password" type="password" autoComplete={creating ? 'new-password' : 'current-password'} minLength={creating ? 8 : undefined} required disabled={busy} /></label>
      {(error || auth.error) && <p className="form-error" role="alert">{error || auth.error}</p>}
      {!supabase && <p role="alert">Configure the local Supabase connection before signing in.</p>}
      {notice && <p role="status">{notice}</p>}
      <button className="button" type="submit" disabled={!supabase || busy || auth.loading}>{busy ? creating ? 'Creating account…' : 'Signing in…' : auth.loading ? 'Checking session…' : creating ? 'Create account' : 'Sign in'}</button>
      <button className="text-button" type="button" disabled={!supabase || busy || auth.loading} onClick={() => { setCreating(value => !value); setError(null); setNotice(null); }}>{creating ? 'Use Sign in instead' : 'Create an account'}</button>
      <p className="auth-help">{creating ? 'Use at least 8 characters for your password. Email confirmation may be required.' : 'Use your confirmed email/password account.'}</p>
    </form>
  </main>;
}
