import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Check as CheckIcon, AlertCircle, Search, X } from 'lucide-react';
import { api } from '../lib/api.js';
import { colorFor, initials, cls, formatCAD } from '../lib/format.js';
import { categoryOf } from '../lib/categories.js';

export function Avatar({ user, size = '', className }) {
  const name = user?.displayName || user?.username || '?';
  return (
    <span className={cls('avatar', size, `tone-${colorFor(user?.username || name)}`, className)} aria-hidden="true">
      {initials(name)}
    </span>
  );
}

export function AvatarStack({ users, max = 4, size = 'sm' }) {
  const shown = users.slice(0, max);
  return (
    <span className="avatar-stack">
      {shown.map((u) => (
        <Avatar key={u.id} user={u} size={size} />
      ))}
      {users.length > max && <span className={cls('avatar', size, 'tone-muted')}>+{users.length - max}</span>}
    </span>
  );
}

export function CategoryGlyph({ category, size = '' }) {
  const c = categoryOf(category);
  const Icon = c.icon;
  return (
    <span className={cls('glyph', size, `tone-${c.tone}`)} aria-hidden="true">
      <Icon />
    </span>
  );
}

/** Big display amount with de-emphasised cents. */
export function BigMoney({ cents }) {
  const s = formatCAD(Math.abs(cents));
  const [whole, frac] = s.split('.');
  return (
    <span className="num">
      {whole}
      <span className="cents">.{frac}</span>
    </span>
  );
}

/** "owes you $x" / "you owe $x" / "settled up" */
export function BalanceLabel({ cents, align = 'end' }) {
  if (!cents) {
    return (
      <span className="item-end" style={{ alignItems: align === 'end' ? 'flex-end' : 'flex-start' }}>
        <span className="label">settled up</span>
      </span>
    );
  }
  return (
    <span className="item-end" style={{ alignItems: align === 'end' ? 'flex-end' : 'flex-start' }}>
      <span className="label">{cents > 0 ? 'owes you' : 'you owe'}</span>
      <span className={cls('value', cents > 0 ? 'pos' : 'neg')}>{formatCAD(cents)}</span>
    </span>
  );
}

export function Switch({ checked, onChange, label }) {
  return (
    <button type="button" role="switch" aria-checked={!!checked} aria-label={label} className="switch" onClick={() => onChange(!checked)} />
  );
}

export function Check({ on }) {
  return (
    <span className={cls('check', on && 'on')} aria-hidden="true">
      <CheckIcon />
    </span>
  );
}

export function Segmented({ value, onChange, options, label, grid }) {
  return (
    <div className={cls('seg', grid && 'seg-grid')} role="radiogroup" aria-label={label}>
      {options.map((o) => {
        const Icon = o.icon;
        return (
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={value === o.id}
            className={value === o.id ? 'active' : ''}
            onClick={() => onChange(o.id)}
          >
            {Icon && <Icon />}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export function TopBar({ title, back, children }) {
  const navigate = useNavigate();
  return (
    <header className="topbar">
      {back && (
        <button
          className="icon-btn"
          aria-label="Back"
          onClick={() => (window.history.length > 1 ? navigate(-1) : navigate(typeof back === 'string' ? back : '/'))}
        >
          <ArrowLeft />
        </button>
      )}
      {title && <div className="topbar-title truncate">{title}</div>}
      <div className="spacer" />
      {children}
    </header>
  );
}

export function Empty({ icon: Icon, title, children, action }) {
  return (
    <div className="empty">
      {Icon && (
        <span className="glyph lg tone-muted">
          <Icon />
        </span>
      )}
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

export function Skeleton({ h = 64, w = '100%', r, style }) {
  return <div className="skeleton" style={{ height: h, width: w, borderRadius: r, ...style }} />;
}

export function ListSkeleton({ rows = 4 }) {
  return (
    <div className="stack gap-8">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} h={60} r={16} />
      ))}
    </div>
  );
}

export function ErrorState({ error, onRetry }) {
  return (
    <Empty icon={AlertCircle} title="Couldn’t load this" action={onRetry && <button className="btn btn-secondary btn-sm" onClick={() => onRetry()}>Try again</button>}>
      {error?.message}
    </Empty>
  );
}

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------

const ToastCtx = createContext(() => {});
export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const push = useCallback((message, type = 'ok') => {
    const id = Math.random().toString(36).slice(2);
    setToasts((t) => [...t, { id, message, type }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3200);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toast-wrap" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={cls('toast', t.type === 'error' && 'error')}>
            {t.type === 'error' ? <AlertCircle /> : <CheckIcon />}
            {t.message}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx);

// ---------------------------------------------------------------------------
// Modal (bottom sheet on mobile, centred dialog on desktop)
// ---------------------------------------------------------------------------

export function Modal({ open, onClose, title, children, labelledBy }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    ref.current?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby={labelledBy} aria-label={labelledBy ? undefined : title} tabIndex={-1} ref={ref}>
        <div className="modal-grip" />
        {children}
      </div>
    </div>
  );
}

/** Lightweight confirm dialog. */
export function ConfirmModal({ open, title, body, confirmLabel = 'Confirm', danger, busy, onConfirm, onClose }) {
  return (
    <Modal open={open} onClose={onClose} title={title}>
      <h2>{title}</h2>
      {body && <p className="muted" style={{ marginBottom: 20 }}>{body}</p>}
      <div className="stack gap-8">
        <button className={cls('btn btn-lg btn-block', danger ? 'btn-danger' : 'btn-primary')} disabled={busy} onClick={onConfirm}>
          {busy ? <span className="spinner" /> : confirmLabel}
        </button>
        <button className="btn btn-ghost btn-block" onClick={onClose}>
          Cancel
        </button>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Username picker
// ---------------------------------------------------------------------------

export function UserPicker({ onPick, exclude = [], placeholder = 'Search by username', autoFocus }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    const term = q.trim();
    if (!term) {
      setResults([]);
      return;
    }
    setLoading(true);
    const t = setTimeout(() => {
      api
        .get(`/users/search?q=${encodeURIComponent(term)}`)
        .then((d) => setResults(d.users))
        .catch(() => setResults([]))
        .finally(() => setLoading(false));
    }, 180);
    return () => clearTimeout(t);
  }, [q]);
  const shown = results.filter((u) => !exclude.includes(u.id));
  return (
    <div className="picker">
      <div className="input-wrap">
        <Search className="prefix" size={17} style={{ left: 14 }} />
        <input
          className="input has-prefix"
          style={{ paddingLeft: 40 }}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={placeholder}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          autoFocus={autoFocus}
          aria-label="Search people by username"
        />
        {q && (
          <button type="button" className="icon-btn" style={{ position: 'absolute', right: 4, width: 40, height: 40 }} onClick={() => setQ('')} aria-label="Clear search">
            <X size={18} />
          </button>
        )}
      </div>
      {q.trim() && (
        <div className="picker-results">
          {loading && !shown.length && <div className="item muted">Searching…</div>}
          {!loading && !shown.length && <div className="item muted">No one matches “{q.trim()}”.</div>}
          {shown.map((u) => (
            <button
              key={u.id}
              type="button"
              className="item"
              onClick={() => {
                onPick(u);
                setQ('');
              }}
            >
              <Avatar user={u} size="sm" />
              <span className="item-main">
                <span className="item-title">{u.displayName}</span>
                <span className="item-sub">@{u.username}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
