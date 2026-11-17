import { useState } from 'react';
import { AlertCircle } from 'lucide-react';
import { useAuth } from '../lib/auth.jsx';
import { api } from '../lib/api.js';
import { firstName } from '../lib/format.js';
import { AuthLayout, PasswordInput } from './Login.jsx';

/**
 * First sign-in with a temporary password (accounts created by an admin):
 * the person must choose their own password before using the app.
 */
export default function SetPassword() {
  const { user, setUser, logout } = useAuth();
  const [pw, setPw] = useState({ next: '', confirm: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const mismatch = pw.confirm.length > 0 && pw.next !== pw.confirm;

  const submit = async (e) => {
    e.preventDefault();
    if (pw.next !== pw.confirm) return setError('The two passwords don’t match.');
    setBusy(true);
    setError('');
    try {
      const d = await api.patch('/auth/me', { newPassword: pw.next });
      setUser(d.user);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <AuthLayout
      title={<>Welcome, <em>{firstName(user.displayName).replace(/-/g, '‑')}.</em></>}
      subtitle="You signed in with a temporary password. Choose your own to get started."
    >
      <form className="auth-form" onSubmit={submit}>
        <div className="field">
          <label className="field-label" htmlFor="new">New password</label>
          <PasswordInput id="new" value={pw.next} onChange={(v) => setPw((p) => ({ ...p, next: v }))} autoComplete="new-password" placeholder="At least 8 characters" />
        </div>
        <div className="field">
          <label className="field-label" htmlFor="confirm">Confirm new password</label>
          <PasswordInput id="confirm" value={pw.confirm} onChange={(v) => setPw((p) => ({ ...p, confirm: v }))} autoComplete="new-password" placeholder="Type it again" />
          {mismatch && <span className="field-hint neg">The passwords don’t match yet.</span>}
        </div>
        {error && (
          <div className="callout" role="alert">
            <AlertCircle /> {error}
          </div>
        )}
        <button className="btn btn-primary btn-lg btn-block" disabled={busy || pw.next.length < 8 || pw.next !== pw.confirm}>
          {busy ? <span className="spinner" /> : 'Save password'}
        </button>
        <p className="muted" style={{ textAlign: 'center', fontSize: 14 }}>
          Signed in as @{user.username} · <button type="button" className="link-btn" onClick={logout}>Sign out</button>
        </p>
      </form>
    </AuthLayout>
  );
}
