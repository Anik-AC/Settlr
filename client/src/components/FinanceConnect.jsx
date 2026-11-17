import { useEffect, useState } from 'react';
import { Copy, LineChart, Link2, Trash2, Check as CheckIcon } from 'lucide-react';
import { api } from '../lib/api.js';
import { ConfirmModal, useToast } from './ui.jsx';
import { formatDate } from '../lib/format.js';

/**
 * "Connected apps": a read-only token for a personal finance tracker, which pulls
 * this person's spending (their share of each expense) every day.
 */
export default function FinanceConnect() {
  const toast = useToast();
  const [keys, setKeys] = useState(null);
  const [fresh, setFresh] = useState(null);
  const [busy, setBusy] = useState(false);
  const [revoke, setRevoke] = useState(null);

  const load = () => api.get('/auth/api-keys').then((d) => setKeys(d.keys.filter((k) => k.scope === 'finance'))).catch(() => setKeys([]));
  useEffect(() => {
    load();
  }, []);

  const connect = async () => {
    setBusy(true);
    try {
      setFresh(await api.post('/auth/api-keys', { name: 'Finance tracker', scope: 'finance' }));
      load();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const copy = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      toast('Token copied');
    } catch {
      toast('Couldn’t copy — select and copy it by hand', 'error');
    }
  };

  const doRevoke = async () => {
    try {
      await api.del(`/auth/api-keys/${revoke.id}`);
      toast('Finance tracker disconnected');
      if (fresh?.key.id === revoke.id) setFresh(null);
      setRevoke(null);
      load();
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  return (
    <section className="section">
      <div className="section-head"><h2>Connected apps</h2></div>
      <div className="card card-pad stack gap-12">
        <div className="row-flex gap-12" style={{ alignItems: 'flex-start' }}>
          <span className="glyph tone-sky"><LineChart size={20} /></span>
          <div style={{ flex: 1 }}>
            <strong>Finance tracker</strong>
            <p className="muted" style={{ fontSize: 14, marginTop: 2 }}>
              Lets your finance tracker read what <em>you</em> spent: your share of each expense, its category and date, whoever paid. It can’t see other people’s shares or change anything.
            </p>
          </div>
        </div>

        {fresh ? (
          <div className="stack gap-12">
            <div className="callout ok" style={{ margin: 0 }}><CheckIcon /> Paste this token into your finance tracker’s “Connect to Settlr”. It won’t be shown again.</div>
            <div className="row-flex gap-8">
              <code className="mono" style={{ flex: 1, minWidth: 0, padding: '10px 12px', borderRadius: 12, background: 'var(--surface-2)', fontSize: 12.5, wordBreak: 'break-all' }}>{fresh.secret}</code>
              <button type="button" className="icon-btn filled" onClick={() => copy(fresh.secret)} aria-label="Copy token"><Copy size={18} /></button>
            </div>
            <button type="button" className="btn btn-secondary" onClick={() => setFresh(null)}>Done</button>
          </div>
        ) : (
          <button type="button" className="btn btn-primary" onClick={connect} disabled={busy}>
            {busy ? <span className="spinner" /> : <><Link2 /> Connect a finance tracker</>}
          </button>
        )}

        {keys?.map((k) => (
          <div key={k.id} className="share-row">
            <LineChart size={18} className="muted" />
            <div className="who">
              <strong>{k.name}</strong>
              <span className="mono" style={{ fontSize: 12 }}>
                {k.prefix}… · connected {formatDate(k.createdAt.slice(0, 10))} · {k.lastUsedAt ? `last synced ${formatDate(k.lastUsedAt.slice(0, 10))}` : 'not synced yet'}
              </span>
            </div>
            <button type="button" className="icon-btn" onClick={() => setRevoke(k)} aria-label={`Disconnect ${k.name}`}><Trash2 size={18} /></button>
          </div>
        ))}
      </div>
      <ConfirmModal
        open={!!revoke}
        danger
        title="Disconnect this finance tracker?"
        body="It will stop receiving your spending from Settlr. You can connect again any time."
        confirmLabel="Disconnect"
        onConfirm={doRevoke}
        onClose={() => setRevoke(null)}
      />
    </section>
  );
}
