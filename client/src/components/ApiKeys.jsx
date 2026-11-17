import { useEffect, useState } from 'react';
import { Bot, Copy, KeyRound, Trash2, Check as CheckIcon } from 'lucide-react';
import { api } from '../lib/api.js';
import { ConfirmModal, useToast } from './ui.jsx';
import { formatDate } from '../lib/format.js';

async function copy(text, toast, what = 'Copied') {
  try {
    await navigator.clipboard.writeText(text);
    toast(what);
  } catch {
    toast('Couldn’t copy — select and copy it by hand', 'error');
  }
}

function CopyField({ label, value, toast }) {
  return (
    <div className="field">
      <span className="field-label">{label}</span>
      <div className="row-flex gap-8">
        <code className="mono" style={{ flex: 1, minWidth: 0, padding: '10px 12px', borderRadius: 12, background: 'var(--surface-2)', fontSize: 12.5, wordBreak: 'break-all' }}>{value}</code>
        <button type="button" className="icon-btn filled" onClick={() => copy(value, toast)} aria-label={`Copy ${label}`}><Copy size={18} /></button>
      </div>
    </div>
  );
}

/**
 * Personal API keys for AI assistants (Claude via MCP) and scripts.
 * The secret is shown once, right after it's created.
 */
export default function ApiKeys() {
  const toast = useToast();
  const [keys, setKeys] = useState(null);
  const [name, setName] = useState('Claude');
  const [busy, setBusy] = useState(false);
  const [fresh, setFresh] = useState(null); // { key, secret }
  const [revoke, setRevoke] = useState(null);
  const mcpUrl = `${window.location.origin}/api/mcp`;

  const load = () => api.get('/auth/api-keys').then((d) => setKeys(d.keys.filter((k) => k.scope !== 'finance'))).catch(() => setKeys([]));
  useEffect(() => {
    load();
  }, []);

  const create = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      const d = await api.post('/auth/api-keys', { name });
      setFresh(d);
      load();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const doRevoke = async () => {
    try {
      await api.del(`/auth/api-keys/${revoke.id}`);
      toast('API key revoked');
      if (fresh?.key.id === revoke.id) setFresh(null);
      setRevoke(null);
      load();
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  return (
    <section className="section">
      <div className="section-head"><h2>AI assistant access</h2></div>
      <div className="card card-pad stack gap-12">
        <p className="muted" style={{ fontSize: 14 }}>
          Let your AI assistant (like Claude) add expenses and check balances for you. It acts as you, with the same access you have. Keep the key private and revoke it if it leaks.
        </p>

        {fresh ? (
          <div className="stack gap-12 api-key-fresh">
            <div className="callout ok" style={{ margin: 0 }}><CheckIcon /> Key created. Copy it now — it won’t be shown again.</div>
            <CopyField label="Your API key" value={fresh.secret} toast={toast} />
            <CopyField label="Server URL" value={mcpUrl} toast={toast} />
            <details className="api-help" open>
              <summary><Bot size={16} /> Connect Claude (app or claude.ai)</summary>
              <ol>
                <li>Open <strong>Settings → Connectors</strong> (Customize → Connectors) and choose <strong>Add custom connector</strong>.</li>
                <li>Name it <strong>Settlr</strong> and paste the server URL above.</li>
                <li>Under <strong>Request headers</strong>, add <code>Authorization</code> with the value <code>Bearer &lt;your API key&gt;</code>. Choose “No sign in”.</li>
                <li>Enable Settlr in a chat and ask, e.g. “Add $24.50 for pizza to our trip group, split equally, I paid.”</li>
              </ol>
            </details>
            <details className="api-help">
              <summary><Bot size={16} /> Claude Code</summary>
              <CopyField label="Run in a terminal" value={`claude mcp add --transport http settlr ${mcpUrl} --header "Authorization: Bearer ${fresh.secret}"`} toast={toast} />
            </details>
            <button type="button" className="btn btn-secondary" onClick={() => setFresh(null)}>Done</button>
          </div>
        ) : (
          <form className="row-flex gap-8" onSubmit={create}>
            <input className="input" style={{ flex: 1 }} value={name} onChange={(e) => setName(e.target.value)} maxLength={40} placeholder="Name, e.g. Claude on my phone" aria-label="API key name" />
            <button className="btn btn-primary" disabled={busy}>{busy ? <span className="spinner" /> : <><KeyRound /> Create key</>}</button>
          </form>
        )}

        {keys?.length > 0 && (
          <div className="stack">
            {keys.map((k) => (
              <div key={k.id} className="share-row">
                <KeyRound size={18} className="muted" />
                <div className="who">
                  <strong>{k.name}</strong>
                  <span className="mono" style={{ fontSize: 12 }}>
                    {k.prefix}… · created {formatDate(k.createdAt.slice(0, 10))} · {k.lastUsedAt ? `last used ${formatDate(k.lastUsedAt.slice(0, 10))}` : 'never used'}
                  </span>
                </div>
                <button type="button" className="icon-btn" onClick={() => setRevoke(k)} aria-label={`Revoke ${k.name}`}><Trash2 size={18} /></button>
              </div>
            ))}
          </div>
        )}
      </div>
      <ConfirmModal
        open={!!revoke}
        danger
        title={`Revoke “${revoke?.name}”?`}
        body="Anything using this key (like a Claude connector) stops working immediately."
        confirmLabel="Revoke"
        onConfirm={doRevoke}
        onClose={() => setRevoke(null)}
      />
    </section>
  );
}
