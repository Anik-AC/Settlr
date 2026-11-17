import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { X, ArrowDown, ArrowUpDown, AlertCircle, Check as CheckIcon, CalendarDays, Banknote, Smartphone, CircleEllipsis, ChevronRight } from 'lucide-react';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { Avatar, Modal, Skeleton, UserPicker, useToast } from '../components/ui.jsx';
import { amountWidth } from './ExpenseForm.jsx';
import { formatCAD, toCents, centsToInput, todayISO, firstName, cls } from '../lib/format.js';

const METHODS = [
  { id: 'etransfer', label: 'e-Transfer', icon: Smartphone },
  { id: 'cash', label: 'Cash', icon: Banknote },
  { id: 'other', label: 'Other', icon: CircleEllipsis },
];

const moneyInput = (v) => {
  let s = String(v).replace(/[^0-9.]/g, '');
  const i = s.indexOf('.');
  if (i !== -1) s = s.slice(0, i + 1) + s.slice(i + 1).replace(/\./g, '').slice(0, 2);
  return s;
};

export default function SettleUp() {
  const [params] = useSearchParams();
  const editId = params.get('edit');
  const { user } = useAuth();
  const me = user.id;
  const navigate = useNavigate();
  const location = useLocation();
  const toast = useToast();

  const [boot, setBoot] = useState({ loading: true, error: null, groups: [], people: {}, balances: [], simplified: [] });
  const [summaries, setSummaries] = useState({});
  const [fromId, setFromId] = useState(null);
  const [toId, setToId] = useState(null);
  const [groupId, setGroupId] = useState(null);
  const [amount, setAmount] = useState('');
  const [amountTouched, setAmountTouched] = useState(false);
  const [method, setMethod] = useState('etransfer');
  const [date, setDate] = useState(todayISO());
  const [notes, setNotes] = useState('');
  const [picking, setPicking] = useState(null); // 'from' | 'to'
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const loadSummary = async (gid) => {
    if (!gid || summaries[gid]) return summaries[gid];
    const d = await api.get(`/groups/${gid}`);
    setSummaries((s) => ({ ...s, [gid]: d.summary }));
    setBoot((b) => ({ ...b, people: { ...b.people, ...d.people } }));
    return d.summary;
  };

  // ---- Boot --------------------------------------------------------------
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [g, p] = await Promise.all([api.get('/groups'), api.get('/people')]);
        const people = { ...g.people, ...p.simplified.people, [me]: user };
        p.people.forEach((x) => (people[x.user.id] = x.user));
        const state = { loading: false, error: null, groups: g.groups, people, balances: p.people, simplified: p.simplified.transfers };

        if (editId) {
          const d = await api.get(`/expenses/${editId}`);
          const e = d.expense;
          Object.assign(state.people, d.people);
          setFromId(e.payers[0].userId);
          setToId(e.splits[0].userId);
          setGroupId(e.groupId);
          setAmount(centsToInput(e.total));
          setAmountTouched(true);
          setMethod(e.method || 'cash');
          setDate(e.date);
          setNotes(e.notes || '');
        } else {
          const gid = Number(params.get('groupId')) || null;
          const from = Number(params.get('from')) || null;
          const to = Number(params.get('to')) || null;
          const amt = Number(params.get('amount')) || 0;
          const withName = params.get('with');
          if (gid) setGroupId(gid);
          if (from && to) {
            setFromId(from);
            setToId(to);
            if (amt) {
              setAmount(centsToInput(amt));
              setAmountTouched(true);
            }
          } else if (withName) {
            let rec = p.people.find((x) => x.user.username.toLowerCase() === withName.toLowerCase());
            if (!rec) {
              const r = await api.get(`/users/search?q=${encodeURIComponent(withName)}`);
              const u = r.users.find((x) => x.username.toLowerCase() === withName.toLowerCase());
              if (u) rec = { user: u, balance: 0, groups: [] };
            }
            if (rec) {
              people[rec.user.id] = rec.user;
              choosePerson(rec);
            }
          } else if (gid) {
            const d = await api.get(`/groups/${gid}`);
            Object.assign(people, d.people);
            setSummaries((s) => ({ ...s, [gid]: d.summary }));
            const mine = d.summary.settlements.filter((t) => t.from === me || t.to === me);
            if (mine.length === 1) {
              setFromId(mine[0].from);
              setToId(mine[0].to);
            }
          }
        }
        if (alive) setBoot(state);
      } catch (err) {
        if (alive) setBoot((b) => ({ ...b, loading: false, error: err }));
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editId]);

  /** Pick a counterparty from the balances list. */
  function choosePerson(rec) {
    const other = rec.user.id;
    if (rec.balance > 0) {
      setFromId(other);
      setToId(me);
    } else {
      setFromId(me);
      setToId(other);
    }
    const gs = rec.groups || [];
    setGroupId(gs.length === 1 ? gs[0].groupId : null);
    setAmountTouched(false);
  }

  // Groups both parties belong to.
  const sharedGroups = useMemo(
    () => boot.groups.filter((g) => fromId && toId && g.memberIds.includes(fromId) && g.memberIds.includes(toId)),
    [boot.groups, fromId, toId]
  );
  useEffect(() => {
    if (groupId) loadSummary(groupId).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupId]);

  // Suggested amount for the selected pair + context.
  const suggestion = useMemo(() => {
    if (!fromId || !toId) return null;
    if (groupId) {
      const s = summaries[groupId];
      if (!s) return null;
      const t = s.settlements.find((x) => x.from === fromId && x.to === toId);
      return { amount: t?.amount || 0, scope: boot.groups.find((g) => g.id === groupId)?.name };
    }
    if (fromId !== me && toId !== me) return null;
    const other = fromId === me ? toId : fromId;
    const rec = boot.balances.find((b) => b.user.id === other);
    const bal = rec?.balance || 0; // + => other owes me
    const owed = fromId === other ? Math.max(bal, 0) : Math.max(-bal, 0);
    const simp = boot.simplified.find((t) => t.from === fromId && t.to === toId);
    return { amount: owed || simp?.amount || 0, scope: owed ? 'overall' : simp ? 'simplified' : null };
  }, [fromId, toId, groupId, summaries, boot.balances, boot.simplified, boot.groups, me]);

  useEffect(() => {
    if (!amountTouched && suggestion) setAmount(suggestion.amount ? centsToInput(suggestion.amount) : '');
  }, [suggestion, amountTouched]);

  const candidates = useMemo(() => {
    if (groupId) return boot.groups.find((g) => g.id === groupId)?.memberIds || [];
    const ids = new Set([me, ...boot.balances.map((b) => b.user.id)]);
    if (fromId) ids.add(fromId);
    if (toId) ids.add(toId);
    return [...ids];
  }, [groupId, boot.groups, boot.balances, me, fromId, toId]);

  const close = () => (location.key !== 'default' ? navigate(-1) : navigate('/'));
  const nm = (id) => (id === me ? 'You' : firstName(boot.people[id]?.displayName || 'Someone'));

  const save = async () => {
    setError('');
    const cents = toCents(amount);
    if (!fromId || !toId) return setError('Choose who paid and who received.');
    if (fromId === toId) return setError('Choose two different people.');
    if (cents <= 0) return setError('Enter an amount greater than zero.');
    setSaving(true);
    const body = { type: 'payment', fromId, toId, amount: cents, method, date, notes, groupId };
    try {
      if (editId) await api.put(`/expenses/${editId}`, body);
      else await api.post('/expenses', body);
      toast(editId ? 'Payment updated' : `Recorded ${formatCAD(cents)} payment`);
      if (editId) navigate(`/expenses/${editId}`, { replace: true });
      else close();
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  };

  // ---- Render ------------------------------------------------------------
  const title = editId ? 'Edit payment' : 'Settle up';
  if (boot.loading) {
    return (
      <div className="sheet-page">
        <div className="sheet-bar"><span /><span className="title">{title}</span><span /></div>
        <Skeleton h={260} r={22} style={{ marginTop: 20 }} />
      </div>
    );
  }
  if (boot.error) {
    return (
      <div className="sheet-page">
        <div className="sheet-bar"><button className="icon-btn" onClick={close} aria-label="Close"><X /></button><span className="title">{title}</span><span /></div>
        <div className="callout" style={{ marginTop: 20 }}><AlertCircle /> {boot.error.message}</div>
      </div>
    );
  }

  // Step 1 — choose who to settle with.
  if (!fromId || !toId) {
    const groupCtx = groupId ? summaries[groupId] : null;
    const list = groupCtx
      ? groupCtx.settlements.map((t) => ({ key: `${t.from}-${t.to}`, t }))
      : boot.balances.filter((b) => b.balance !== 0).map((b) => ({ key: b.user.id, rec: b }));
    return (
      <div className="sheet-page">
        <div className="sheet-bar">
          <button className="icon-btn" onClick={close} aria-label="Close"><X /></button>
          <span className="title">{title}</span>
          <span />
        </div>
        <div className="page-head">
          <h1 style={{ fontSize: 30 }}>Who are you settling with?</h1>
          <p>{groupCtx ? `Suggested payments in ${boot.groups.find((g) => g.id === groupId)?.name}.` : 'People you have an open balance with.'}</p>
        </div>
        {list.length ? (
          <div className="list card">
            {list.map(({ key, t, rec }) =>
              t ? (
                <button key={key} className="item" onClick={() => { setFromId(t.from); setToId(t.to); setAmountTouched(false); }}>
                  <Avatar user={boot.people[t.from]} size="sm" />
                  <span className="item-main">
                    <span className="item-title">{nm(t.from)} → {nm(t.to)}</span>
                    <span className="item-sub">{formatCAD(t.amount)}</span>
                  </span>
                  <ChevronRight className="faint" size={18} />
                </button>
              ) : (
                <button key={key} className="item" onClick={() => choosePerson(rec)}>
                  <Avatar user={rec.user} />
                  <span className="item-main">
                    <span className="item-title">{rec.user.displayName}</span>
                    <span className={cls('item-sub', rec.balance > 0 ? 'pos' : 'neg')}>
                      {rec.balance > 0 ? `owes you ${formatCAD(rec.balance)}` : `you owe ${formatCAD(rec.balance)}`}
                    </span>
                  </span>
                  <ChevronRight className="faint" size={18} />
                </button>
              )
            )}
          </div>
        ) : (
          <div className="callout ok"><CheckIcon /> You’re all settled up{groupCtx ? ' in this group' : ''}.</div>
        )}
        <div className="section">
          <div className="section-head"><h2>Someone else</h2></div>
          <UserPicker onPick={(u) => { setBoot((b) => ({ ...b, people: { ...b.people, [u.id]: u } })); setGroupId(null); choosePerson({ user: u, balance: 0, groups: [] }); }} placeholder="Search by username" />
        </div>
      </div>
    );
  }

  // Step 2 — payment details.
  return (
    <div className="sheet-page">
      <div className="sheet-bar">
        <button className="icon-btn" onClick={close} aria-label="Close"><X /></button>
        <span className="title">{title}</span>
        <button className="btn btn-primary btn-sm end" onClick={save} disabled={saving}>{saving ? <span className="spinner" /> : 'Save'}</button>
      </div>

      <section className="hero" style={{ marginTop: 12, textAlign: 'center' }}>
        <div className="stack" style={{ alignItems: 'center', gap: 6 }}>
          <button type="button" className="stack" style={{ alignItems: 'center', gap: 8 }} onClick={() => setPicking('from')} aria-label="Change who paid">
            <Avatar user={boot.people[fromId]} size="lg" />
            <strong>{nm(fromId)} <span className="muted" style={{ fontWeight: 450 }}>{fromId === me ? 'pay' : 'paid'}</span></strong>
          </button>
          <div className="row-flex gap-8" style={{ margin: '4px 0' }}>
            <span className="faint"><ArrowDown size={20} /></span>
            <button
              type="button"
              className="icon-btn filled"
              style={{ width: 36, height: 36 }}
              onClick={() => { setFromId(toId); setToId(fromId); setAmountTouched(false); }}
              aria-label="Swap payer and recipient"
            >
              <ArrowUpDown size={17} />
            </button>
          </div>
          <button type="button" className="stack" style={{ alignItems: 'center', gap: 8 }} onClick={() => setPicking('to')} aria-label="Change who received">
            <Avatar user={boot.people[toId]} size="lg" />
            <strong>{nm(toId)}</strong>
          </button>
        </div>
        <label className="amount-input" style={{ marginTop: 10 }}>
          <span className="cur">$</span>
          <input inputMode="decimal" placeholder="0.00" value={amount} style={{ width: amountWidth(amount) }} onChange={(e) => { setAmount(moneyInput(e.target.value)); setAmountTouched(true); }} aria-label="Amount" />
        </label>
        {suggestion && (
          <p className="muted" style={{ fontSize: 13 }}>
            {suggestion.amount
              ? <>Balance{suggestion.scope && suggestion.scope !== 'overall' ? ` (${suggestion.scope})` : ''}: {formatCAD(suggestion.amount)}{toCents(amount) !== suggestion.amount && <> · <button type="button" className="link-btn" style={{ fontSize: 13 }} onClick={() => { setAmount(centsToInput(suggestion.amount)); setAmountTouched(true); }}>Use full amount</button></>}</>
              : `${nm(fromId)} ${fromId === me ? "don't" : "doesn't"} owe ${toId === me ? 'you' : nm(toId)} anything${suggestion.scope ? ` in ${suggestion.scope}` : ''}.`}
          </p>
        )}
      </section>

      <div className="form-block" style={{ marginTop: 12 }}>
        <div className="field">
          <span className="field-label">Method</span>
          <div className="chips" role="radiogroup" aria-label="Payment method">
            {METHODS.map((m) => {
              const Icon = m.icon;
              return (
                <button key={m.id} type="button" role="radio" aria-checked={method === m.id} className={cls('chip', method === m.id && 'active')} onClick={() => setMethod(m.id)}>
                  <Icon /> {m.label}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <div className="form-block">
        <div className="field">
          <span className="field-label">Apply to</span>
          <div className="chips" role="radiogroup" aria-label="Group">
            {sharedGroups.map((g) => (
              <button key={g.id} type="button" role="radio" aria-checked={groupId === g.id} className={cls('chip', groupId === g.id && 'active')} onClick={() => { setGroupId(g.id); setAmountTouched(false); }}>
                {g.name}
              </button>
            ))}
            <button type="button" role="radio" aria-checked={groupId === null} className={cls('chip', groupId === null && 'active')} onClick={() => { setGroupId(null); setAmountTouched(false); }}>
              No group
            </button>
          </div>
          <span className="field-hint">Recording it in a group settles balances inside that group.</span>
        </div>
      </div>

      <div className="form-block stack gap-12">
        <label className="field">
          <span className="field-label row-flex gap-4"><CalendarDays size={15} /> Date</span>
          <input type="date" className="input" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
        <label className="field">
          <span className="field-label">Note</span>
          <input className="input" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. October rent" maxLength={200} />
        </label>
      </div>

      <div className="sheet-foot">
        <div className="sheet-foot-inner" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
          {error && <div className="callout" role="alert"><AlertCircle /> {error}</div>}
          <button className="btn btn-primary btn-lg btn-block" onClick={save} disabled={saving}>
            {saving ? <span className="spinner" /> : <>Record {toCents(amount) ? formatCAD(toCents(amount)) : 'payment'}</>}
          </button>
        </div>
      </div>

      <Modal open={!!picking} onClose={() => setPicking(null)} title="Choose person">
        <h2>{picking === 'from' ? 'Who paid?' : 'Who received it?'}</h2>
        <div className="list" style={{ marginTop: 10 }}>
          {candidates.map((id) => (
            <button
              key={id}
              className="item"
              onClick={() => {
                if (picking === 'from') {
                  if (id === toId) setToId(fromId);
                  setFromId(id);
                } else {
                  if (id === fromId) setFromId(toId);
                  setToId(id);
                }
                setAmountTouched(false);
                setPicking(null);
              }}
            >
              <Avatar user={boot.people[id]} size="sm" />
              <span className="item-main"><span className="item-title">{id === me ? 'You' : boot.people[id]?.displayName}</span></span>
              {(picking === 'from' ? fromId : toId) === id && <CheckIcon size={18} />}
            </button>
          ))}
        </div>
      </Modal>
    </div>
  );
}
