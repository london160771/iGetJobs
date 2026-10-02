import type { Session, User } from '@supabase/supabase-js';

export interface AuthState { user: User | null; loading: boolean; error: string | null }
export interface Verification { user: User | null; unavailable: boolean }

// Only a previously verified identity can retain mounted workspace state.
// A different identity, logout, or invalid credentials clear it immediately.
export class AuthSession {
  private revision = 0;
  private disposed = false;
  constructor(private state: AuthState, private publish: (state: AuthState) => void,
    private verifyUser: (session: Session) => Promise<Verification>) {}
  private update(state: AuthState) { this.state = state; this.publish(state); }
  async verify(session: Session | null) {
    const current = ++this.revision;
    if (!session) { this.update({ user: null, loading: false, error: null }); return; }
    const retained = this.state.user?.id === session.user.id ? this.state.user : null;
    this.update({ user: retained, loading: !retained, error: null });
    let result: Verification;
    try { result = await this.verifyUser(session); }
    catch { result = { user: null, unavailable: true }; }
    if (this.disposed || current !== this.revision) return;
    if (result.unavailable) {
      // Temporary transport failure must not discard same-user unsaved work.
      // Every API request still independently verifies its bearer token.
      this.update({ user: retained, loading: false, error: 'Authentication is temporarily unavailable. Please retry.' });
    } else {
      const user = result.user?.id === session.user.id ? result.user : null;
      this.update({ user, loading: false, error: user ? null : 'Your session could not be verified. Please sign in again.' });
    }
  }
  dispose() { this.disposed = true; this.revision++; }
}
