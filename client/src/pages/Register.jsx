import { useEffect, useState } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { AlertCircle } from 'lucide-react';
import { useAuth } from '../lib/auth.jsx';
import { api } from '../lib/api.js';
import { AuthLayout, PasswordInput } from './Login.jsx';

export default function Register() {
  const { user, register } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const inviteFromLink = params.get('invite') || '';
  const [form, setForm] = useState({ displayName: '', username: '', password: '', inviteCode: inviteFromLink });
  const [inviteRequired, setInviteRequired] = useState(false);
  const [inviteRejected, setInviteRejected] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get('/auth/config').then((c) => setInviteRequired(!!c.inviteRequired)).catch(() => {});
  }, []);

  if (user) return <Navigate to="/" replace />;

  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: typeof v === 'string' ? v : v.target.value }));
  const usernameOk = /^[a-z0-9_.]{3,20}$/i.test(form.username);
  const showInvite = inviteRequired && (!inviteFromLink || inviteRejected);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await register({ ...form, username: form.username.trim(), inviteCode: form.inviteCode.trim() });
      navigate('/', { replace: true });
    } catch (err) {
      setError(err.message);
      if (err.status === 403) setInviteRejected(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout title={<>Join the <em>crew.</em></>} subtitle="Pick a username your friends can find you by.">
      <form className="auth-form" onSubmit={submit}>
        <div className="field">
          <label className="field-label" htmlFor="name">Your name</label>
          <input id="name" className="input" value={form.displayName} onChange={set('displayName')} autoComplete="name" placeholder="Taylor Smith" required />
        </div>
        <div className="field">
          <label className="field-label" htmlFor="username">Username</label>
          <div className="input-wrap">
            <span className="prefix">@</span>
            <input
              id="username"
              className="input has-prefix"
              value={form.username}
              onChange={(e) => set('username')(e.target.value.replace(/\s/g, '').toLowerCase())}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              autoComplete="username"
              placeholder="taylor"
              required
            />
          </div>
          <span className="field-hint">3–20 characters: letters, numbers, dots or underscores.</span>
        </div>
        <div className="field">
          <label className="field-label" htmlFor="password">Password</label>
          <PasswordInput id="password" value={form.password} onChange={set('password')} autoComplete="new-password" placeholder="At least 8 characters" />
        </div>
        {showInvite && (
          <div className="field">
            <label className="field-label" htmlFor="invite">Invite code</label>
            <input id="invite" className="input" value={form.inviteCode} onChange={set('inviteCode')} autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder="From the friend who invited you" required />
            <span className="field-hint">Settlr is invite-only. Ask a friend who uses it for the code or their invite link.</span>
          </div>
        )}
        {error && (
          <div className="callout" role="alert">
            <AlertCircle /> {error}
          </div>
        )}
        <button
          className="btn btn-primary btn-lg btn-block"
          disabled={busy || !form.displayName.trim() || !usernameOk || form.password.length < 8 || (inviteRequired && !form.inviteCode.trim())}
        >
          {busy ? <span className="spinner" /> : 'Create account'}
        </button>
        <p className="muted" style={{ textAlign: 'center', fontSize: 14 }}>
          Already have an account? <Link to="/login" className="link-btn">Sign in</Link>
        </p>
      </form>
    </AuthLayout>
  );
}
