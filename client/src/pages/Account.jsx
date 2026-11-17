import { useEffect, useState } from 'react';
import { LogOut, Moon, Sun, Monitor, Smartphone, Copy } from 'lucide-react';
import { useAuth } from '../lib/auth.jsx';
import { api } from '../lib/api.js';
import { Avatar, Segmented, TopBar, useToast } from '../components/ui.jsx';
import { PasswordInput } from './Login.jsx';
import ApiKeys from '../components/ApiKeys.jsx';

function applyTheme(t) {
  try { localStorage.setItem('settlr-theme', t); } catch { /* private mode */ }
  const resolved = t === 'system' ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : t;
  document.documentElement.dataset.theme = resolved;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', resolved === 'light' ? '#f3f1ea' : '#0c0d0b');
}

export default function Account() {
  const { user, setUser, logout } = useAuth();
  const toast = useToast();
  const [name, setName] = useState(user.displayName);
  const [pw, setPw] = useState({ current: '', next: '' });
  const [theme, setTheme] = useState(() => { try { return localStorage.getItem('settlr-theme') || localStorage.getItem('tally-theme') || 'dark'; } catch { return 'dark'; } });
  const [busy, setBusy] = useState(false);
  const [inviteCode, setInviteCode] = useState(null);
  useEffect(() => {
    api.get('/auth/invite').then((d) => setInviteCode(d.inviteCode)).catch(() => {});
  }, []);
  const inviteUrl = `${window.location.origin}/register${inviteCode ? `?invite=${encodeURIComponent(inviteCode)}` : ''}`;

  const saveName = async (e) => {
    e.preventDefault();
    try {
      const d = await api.patch('/auth/me', { displayName: name });
      setUser(d.user);
      toast('Name updated');
    } catch (err) {
      toast(err.message, 'error');
    }
  };
  const savePw = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.patch('/auth/me', { currentPassword: pw.current, newPassword: pw.next });
      setPw({ current: '', next: '' });
      toast('Password changed');
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setBusy(false);
    }
  };
  const share = async () => {
    const url = inviteUrl;
    try {
      if (navigator.share) await navigator.share({ title: 'Settlr', text: 'Join me on Settlr to split bills', url });
      else {
        await navigator.clipboard.writeText(url);
        toast('Link copied');
      }
    } catch {
      /* cancelled */
    }
  };

  return (
    <>
      <TopBar back="/" title={<span className="hide-desktop">Account</span>} />
      <section className="hero" style={{ textAlign: 'center' }}>
        <Avatar user={user} size="xl" />
        <h1 style={{ fontSize: 26, marginTop: 14 }}>{user.displayName}</h1>
        <p className="muted">@{user.username}</p>
      </section>

      <section className="section">
        <div className="section-head"><h2>Invite friends</h2></div>
        <div className="card card-pad stack gap-12">
          <p className="muted" style={{ fontSize: 14 }}>
            Send this link to a friend. Once they’ve made an account, add them to a group by username.
            {inviteCode && <> The link includes the invite code, so keep it to people you trust.</>}
          </p>
          <div className="row-flex">
            <code className="mono truncate" style={{ flex: 1, padding: '12px 14px', borderRadius: 12, background: 'var(--surface-2)', fontSize: 13.5 }}>{inviteUrl.replace(/^https?:\/\//, '')}</code>
            <button className="btn btn-secondary" onClick={share} aria-label="Share link">
              {navigator.share ? <Smartphone /> : <Copy />} Share
            </button>
          </div>
        </div>
      </section>

      <ApiKeys />

      <section className="section">
        <div className="section-head"><h2>Appearance</h2></div>
        <div className="card card-pad">
          <Segmented
            value={theme}
            onChange={(t) => {
              setTheme(t);
              applyTheme(t);
            }}
            label="Theme"
            options={[
              { id: 'dark', label: 'Dark', icon: Moon },
              { id: 'light', label: 'Light', icon: Sun },
              { id: 'system', label: 'System', icon: Monitor },
            ]}
          />
        </div>
      </section>

      <section className="section">
        <div className="section-head"><h2>Profile</h2></div>
        <form className="card card-pad stack gap-12" onSubmit={saveName}>
          <div className="field">
            <label className="field-label" htmlFor="dn">Display name</label>
            <input id="dn" className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={40} />
          </div>
          <button className="btn btn-secondary" disabled={!name.trim() || name === user.displayName}>Save name</button>
        </form>
      </section>

      <section className="section">
        <div className="section-head"><h2>Password</h2></div>
        <form className="card card-pad stack gap-12" onSubmit={savePw}>
          <div className="field">
            <label className="field-label" htmlFor="cur">Current password</label>
            <PasswordInput id="cur" value={pw.current} onChange={(v) => setPw((p) => ({ ...p, current: v }))} autoComplete="current-password" placeholder="Current password" />
          </div>
          <div className="field">
            <label className="field-label" htmlFor="new">New password</label>
            <PasswordInput id="new" value={pw.next} onChange={(v) => setPw((p) => ({ ...p, next: v }))} autoComplete="new-password" placeholder="At least 8 characters" />
          </div>
          <button className="btn btn-secondary" disabled={busy || !pw.current || pw.next.length < 8}>Change password</button>
        </form>
      </section>

      <button className="btn btn-danger btn-block section" onClick={logout}>
        <LogOut /> Sign out
      </button>
      <p className="faint" style={{ textAlign: 'center', fontSize: 12, marginTop: 14 }}>Settlr · all amounts in CAD</p>
    </>
  );
}
