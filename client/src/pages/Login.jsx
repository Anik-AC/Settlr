import { useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { AlertCircle, Eye, EyeOff } from 'lucide-react';
import { useAuth } from '../lib/auth.jsx';
import { Brand } from '../components/AppShell.jsx';

export function AuthLayout({ title, subtitle, children }) {
  return (
    <div className="auth">
      <div className="auth-hero">
        <Brand />
        <div style={{ marginTop: 'auto', paddingTop: 48 }}>
          <div className="brand-art" aria-hidden="true">
            <span /><span /><span /><span /><span />
          </div>
          <h1>{title}</h1>
          <p>{subtitle}</p>
        </div>
      </div>
      <div>{children}</div>
    </div>
  );
}

export function PasswordInput({ value, onChange, autoComplete, id, placeholder = 'Password' }) {
  const [show, setShow] = useState(false);
  return (
    <div className="input-wrap">
      <input
        id={id}
        className="input has-suffix"
        style={{ paddingRight: 50 }}
        type={show ? 'text' : 'password'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete={autoComplete}
        placeholder={placeholder}
        required
      />
      <button type="button" className="icon-btn" style={{ position: 'absolute', right: 4 }} onClick={() => setShow((s) => !s)} aria-label={show ? 'Hide password' : 'Show password'}>
        {show ? <EyeOff /> : <Eye />}
      </button>
    </div>
  );
}

export default function Login() {
  const { user, login } = useAuth();
  const navigate = useNavigate();
  const loc = useLocation();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  if (user) return <Navigate to={loc.state?.from || '/'} replace />;

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await login(username.trim(), password);
      navigate(loc.state?.from || '/', { replace: true });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout title={<>Split the bill. <em>Not the friendship.</em></>} subtitle="Dinners, trips, rent and groceries — settled fairly between friends.">
      <form className="auth-form" onSubmit={submit}>
        <div className="field">
          <label className="field-label" htmlFor="username">Username</label>
          <div className="input-wrap">
            <span className="prefix">@</span>
            <input
              id="username"
              className="input has-prefix"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoCapitalize="none"
              autoCorrect="off"
              autoComplete="username"
              spellCheck={false}
              placeholder="yourname"
              required
            />
          </div>
        </div>
        <div className="field">
          <label className="field-label" htmlFor="password">Password</label>
          <PasswordInput id="password" value={password} onChange={setPassword} autoComplete="current-password" />
        </div>
        {error && (
          <div className="callout" role="alert">
            <AlertCircle /> {error}
          </div>
        )}
        <button className="btn btn-primary btn-lg btn-block" disabled={busy || !username || !password}>
          {busy ? <span className="spinner" /> : 'Sign in'}
        </button>
        <p className="muted" style={{ textAlign: 'center', fontSize: 14 }}>
          New here? <Link to="/register" className="link-btn">Create an account</Link>
        </p>
      </form>
    </AuthLayout>
  );
}
