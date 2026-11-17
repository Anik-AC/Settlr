import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  X, Users, Wallet, Percent, Receipt, Plus, Trash2, AlertCircle, Equal, DollarSign, PieChart, ListChecks, Divide, StickyNote, Sparkles,
  Camera, ImagePlus, ScanLine,
} from 'lucide-react';
import { api } from '../lib/api.js';
import { prepareReceiptImage, scanReceipt } from '../lib/receipt.js';
import { useAuth } from '../lib/auth.jsx';
import { computeSplit, validatePayers, allocate } from '@shared/split.js';
import { Avatar, Check, Segmented, Skeleton, UserPicker, useToast } from '../components/ui.jsx';
import { GroupGlyph } from './Home.jsx';
import { CATEGORIES, guessCategory } from '../lib/categories.js';
import { formatCAD, toCents, centsToInput, todayISO, firstName, cls } from '../lib/format.js';

const SPLIT_OPTIONS = [
  { id: 'equal', label: 'Equally', icon: Equal },
  { id: 'exact', label: 'Amounts', icon: DollarSign },
  { id: 'percent', label: 'Percent', icon: Percent },
  { id: 'shares', label: 'Shares', icon: PieChart },
  { id: 'itemized', label: 'Items', icon: ListChecks },
];
const TAX_OPTIONS = [
  { id: 'included', label: 'Included' },
  { id: 'percent', label: 'Add %' },
  { id: 'amount', label: 'Add $' },
];
const EXTRAS_OPTIONS = [
  { id: 'equal', label: 'Equally' },
  { id: 'proportional', label: 'By portion' },
];
const TIP_PRESETS = [15, 18, 20];
const MAX_PHOTOS = 6;
const TAX_PRESETS = [
  { v: '5', label: 'GST 5%' },
  { v: '13', label: 'HST 13%' },
  { v: '15', label: 'HST 15%' },
];

let itemKey = 0;
const newItem = (userIds = []) => ({ key: ++itemKey, name: '', amount: '', taxable: true, userIds });

/** Keep only digits and one decimal point, max 2 decimals. */
const moneyInput = (v) => {
  let s = String(v).replace(/[^0-9.]/g, '');
  const i = s.indexOf('.');
  if (i !== -1) s = s.slice(0, i + 1) + s.slice(i + 1).replace(/\./g, '').slice(0, 2);
  return s;
};
const numInput = (v, decimals = 3) => {
  let s = String(v).replace(/[^0-9.]/g, '');
  const i = s.indexOf('.');
  if (i !== -1) s = s.slice(0, i + 1) + s.slice(i + 1).replace(/\./g, '').slice(0, decimals);
  return s;
};

/** Width for the big amount field so the $ sign hugs the number. */
export const amountWidth = (v) => {
  const s = v || '0.00';
  const digits = s.replace(/[^0-9]/g, '').length;
  return `${digits + (s.includes('.') ? 0.45 : 0) + 0.15}ch`;
};

function evenPercents(ids) {
  // basis points so they add to exactly 100.00
  const parts = allocate(10000, ids.map(() => 1));
  return Object.fromEntries(ids.map((id, i) => [id, String(+(parts[i] / 100).toFixed(2))]));
}

export default function ExpenseForm() {
  const { id: editId } = useParams();
  const [params] = useSearchParams();
  const { user } = useAuth();
  const me = user.id;
  const navigate = useNavigate();
  const location = useLocation();
  const toast = useToast();

  const [boot, setBoot] = useState({ loading: true, error: null, groups: [], people: {} });
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('general');
  const categoryTouched = useRef(false);
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(todayISO());
  const [notes, setNotes] = useState('');
  const [showNotes, setShowNotes] = useState(false);
  const [groupId, setGroupId] = useState(null);
  const [friends, setFriends] = useState([]); // user objects (non-group)
  const [payerMode, setPayerMode] = useState('single');
  const [payerId, setPayerId] = useState(me);
  const [payerAmounts, setPayerAmounts] = useState({});
  const [method, setMethod] = useState('equal');
  const [selected, setSelected] = useState([]);
  const [values, setValues] = useState({ exact: {}, percent: {}, shares: {} });
  const [items, setItems] = useState([]);
  const [taxMode, setTaxMode] = useState('included');
  const [taxValue, setTaxValue] = useState('13');
  const [tip, setTip] = useState('');
  const [extrasSplit, setExtrasSplit] = useState('proportional');
  // Bill scanning: a bill can span several photos / screenshots, read together in one go.
  const [photos, setPhotos] = useState([]); // [{ id, dataUrl, preview }]
  const [scan, setScan] = useState({ status: 'idle', error: '', warnings: [], count: 0 });
  const scanSeq = useRef(0);
  const photosRef = useRef(photos);
  photosRef.current = photos;
  const cameraInput = useRef(null);
  const uploadInput = useRef(null);
  const [saving, setSaving] = useState(false);
  const [serverError, setServerError] = useState('');
  const [attempted, setAttempted] = useState(false);
  const skipPoolReset = useRef(false);

  // ---- Load groups (+ the expense when editing) -------------------------
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const g = await api.get('/groups');
        let people = { ...g.people, [me]: user };
        if (!alive) return;

        if (editId) {
          const d = await api.get(`/expenses/${editId}`);
          const e = d.expense;
          if (e.type === 'payment') {
            navigate(`/settle?edit=${e.id}`, { replace: true });
            return;
          }
          people = { ...people, ...d.people };
          skipPoolReset.current = true;
          setDescription(e.description);
          setCategory(e.category);
          categoryTouched.current = true;
          setDate(e.date);
          setNotes(e.notes || '');
          setShowNotes(!!e.notes);
          setGroupId(e.groupId);
          const involved = new Set([...e.payers.map((p) => p.userId), ...e.splits.map((s) => s.userId), ...(e.splitMeta?.participants || [])]);
          if (!e.groupId) setFriends([...involved].filter((x) => x !== me).map((x) => people[x]).filter(Boolean));
          setTaxMode(e.taxMode);
          setTaxValue(e.taxMode === 'amount' ? centsToInput(Math.round(e.taxValue)) : e.taxMode === 'percent' ? String(e.taxValue) : '13');
          setTip(centsToInput(e.tip || 0));
          setExtrasSplit(e.extrasSplit || 'proportional');
          setMethod(e.splitMethod);
          if (e.splitMethod === 'itemized') {
            setItems((e.splitMeta?.items || []).map((it) => ({ ...newItem(it.userIds), name: it.name, amount: centsToInput(it.amount), taxable: it.taxable !== false })));
          } else {
            setAmount(centsToInput(e.subtotal));
            const parts = e.splitMeta?.participants || e.splits.map((s) => s.userId);
            setSelected(parts);
            const v = e.splitMeta?.values || {};
            const conv = Object.fromEntries(Object.entries(v).map(([k, val]) => [k, e.splitMethod === 'exact' ? centsToInput(val) : String(val)]));
            setValues((vs) => ({ ...vs, [e.splitMethod]: conv }));
          }
          if (e.payers.length === 1) {
            setPayerMode('single');
            setPayerId(e.payers[0].userId);
          } else {
            setPayerMode('multiple');
            setPayerAmounts(Object.fromEntries(e.payers.map((p) => [p.userId, centsToInput(p.amount)])));
          }
        } else {
          const qGroup = Number(params.get('groupId')) || null;
          const withName = params.get('with');
          if (withName) {
            const r = await api.get(`/users/search?q=${encodeURIComponent(withName)}`);
            const u = r.users.find((x) => x.username.toLowerCase() === withName.toLowerCase());
            if (u) {
              people[u.id] = u;
              setFriends([u]);
            }
            setGroupId(null);
          } else if (qGroup && g.groups.some((x) => x.id === qGroup)) {
            setGroupId(qGroup);
          } else if (g.groups.length) {
            setGroupId(g.groups[0].id);
          }
        }
        if (alive) setBoot({ loading: false, error: null, groups: g.groups, people });
      } catch (error) {
        if (alive) setBoot((b) => ({ ...b, loading: false, error }));
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editId]);

  const people = useMemo(() => {
    const m = { ...boot.people, [me]: user };
    friends.forEach((f) => (m[f.id] = f));
    return m;
  }, [boot.people, friends, me, user]);

  const group = boot.groups.find((g) => g.id === groupId) || null;
  const pool = useMemo(() => {
    if (group) return [me, ...group.memberIds.filter((x) => x !== me)];
    return [me, ...friends.map((f) => f.id)];
  }, [group, friends, me]);
  const poolKey = pool.join(',');

  // Reset participants when the pool changes (switching group / adding people).
  useEffect(() => {
    if (boot.loading) return;
    if (skipPoolReset.current) {
      skipPoolReset.current = false;
      return;
    }
    setSelected((sel) => {
      const kept = sel.filter((x) => pool.includes(x));
      const added = pool.filter((x) => !sel.includes(x) && !kept.includes(x));
      return sel.length ? [...kept, ...added] : pool;
    });
    if (!pool.includes(payerId)) setPayerId(me);
    setItems((its) => its.map((it) => ({ ...it, userIds: it.userIds.filter((x) => pool.includes(x)) })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [poolKey, boot.loading]);

  // ---- Live calculation --------------------------------------------------
  const splitInput = useMemo(() => {
    const ordered = (ids) => pool.filter((x) => ids.includes(x));
    const split = { method };
    if (method === 'equal') split.participants = ordered(selected);
    else if (method === 'itemized') {
      split.items = items.map((it) => ({ name: it.name, amount: toCents(it.amount), taxable: it.taxable, userIds: ordered(it.userIds) }));
    } else {
      split.participants = pool;
      const src = values[method] || {};
      split.values = Object.fromEntries(pool.map((id) => [id, method === 'exact' ? toCents(src[id]) : Number(src[id]) || 0]));
    }
    return {
      amount: toCents(amount),
      tax: { mode: taxMode, value: taxMode === 'amount' ? toCents(taxValue) : Number(taxValue) || 0 },
      tip: toCents(tip),
      extrasSplit,
      split,
    };
  }, [method, selected, items, values, pool, amount, taxMode, taxValue, tip, extrasSplit]);

  const result = useMemo(() => computeSplit(splitInput), [splitInput]);
  const total = result.total;

  const payers = useMemo(() => {
    if (payerMode === 'single') return [{ userId: payerId, amount: total }];
    return pool.map((id) => ({ userId: id, amount: toCents(payerAmounts[id]) })).filter((p) => p.amount > 0);
  }, [payerMode, payerId, payerAmounts, pool, total]);
  const payerSum = payers.reduce((a, p) => a + p.amount, 0);

  const errors = useMemo(() => {
    const errs = [];
    if (!description.trim()) errs.push('Add a description.');
    errs.push(...result.errors);
    if (!result.errors.length) errs.push(...validatePayers(payers, total));
    if (!groupId && !friends.length) errs.push('Choose a group or add someone to split with.');
    return errs;
  }, [description, result.errors, payers, total, groupId, friends.length]);

  const shareOf = (id) => result.shares.find((s) => s.userId === id);

  // ---- Handlers ----------------------------------------------------------
  const onDescription = (v) => {
    setDescription(v);
    if (!categoryTouched.current) {
      const g = guessCategory(v);
      if (g) setCategory(g);
    }
  };

  const changeMethod = (m) => {
    setMethod(m);
    if (m === 'percent' && !Object.values(values.percent).some((v) => Number(v))) {
      setValues((vs) => ({ ...vs, percent: evenPercents(pool) }));
    }
    if (m === 'shares' && !Object.values(values.shares).some((v) => Number(v))) {
      setValues((vs) => ({ ...vs, shares: Object.fromEntries(pool.map((id) => [id, '1'])) }));
    }
    if (m === 'itemized' && !items.length) {
      setItems([newItem(pool), newItem(pool)]);
    }
  };

  const setValue = (m, id, v) => setValues((vs) => ({ ...vs, [m]: { ...vs[m], [id]: v } }));

  const toggleSelected = (id) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  // ---- Bill scanning -------------------------------------------------------
  useEffect(() => () => photosRef.current.forEach((ph) => URL.revokeObjectURL(ph.preview)), []);

  const applyReceipt = (r) => {
    setMethod('itemized');
    // Re-reading after adding a page keeps who-had-what for items that are still there.
    const key = (name) => String(name).toLowerCase().replace(/[^a-z0-9]/g, '');
    setItems((prev) => {
      const kept = new Map(prev.filter((it) => it.name).map((it) => [key(it.name), it]));
      return r.items.map((it) => {
        const old = kept.get(key(it.name));
        return { ...newItem(old ? old.userIds : pool), name: it.name, amount: centsToInput(it.amount), taxable: old ? old.taxable : true };
      });
    });
    if (r.tax > 0) {
      setTaxMode('amount');
      setTaxValue(centsToInput(r.tax));
    } else {
      setTaxMode('included');
    }
    setTip(centsToInput(r.tip));
    setExtrasSplit('equal'); // scanned bills: tax + tip split evenly between everyone on the bill
    if (r.merchant && !description.trim()) onDescription(r.merchant);
    if (!categoryTouched.current && r.tip > 0 && !guessCategory(r.merchant || '')) setCategory('dining');
    if (r.date && r.date <= todayISO()) setDate(r.date);
    setPayerMode('single');
  };

  /** Read every photo of the bill together, so overlapping shots aren't double-counted. */
  const readPhotos = async (list) => {
    const seq = ++scanSeq.current;
    if (!list.length) {
      setScan({ status: 'idle', error: '', warnings: [], count: 0 });
      return;
    }
    setScan((s) => ({ ...s, status: 'reading', error: '', warnings: [] }));
    try {
      const r = await scanReceipt(list.map((ph) => ph.dataUrl));
      if (seq !== scanSeq.current) return; // a newer read replaced this one
      if (!r.items.length) throw new Error(r.warnings?.[0] || 'No items could be read from this bill.');
      applyReceipt(r);
      setScan({ status: 'done', error: '', warnings: r.warnings || [], count: r.items.length });
      toast(`Read ${r.items.length} item${r.items.length === 1 ? '' : 's'} — now pick who had what`);
    } catch (err) {
      if (seq !== scanSeq.current) return;
      setScan((s) => ({ ...s, status: 'error', error: err.message || 'Couldn’t read that bill.' }));
    }
  };

  const onPickImages = async (e) => {
    const files = [...(e.target.files || [])];
    e.target.value = ''; // let the same photo be picked again
    if (!files.length) return;
    const room = MAX_PHOTOS - photos.length;
    if (room <= 0) {
      setScan((s) => ({ ...s, status: 'error', error: `A bill can have up to ${MAX_PHOTOS} photos. Remove one first.` }));
      return;
    }
    setScan((s) => ({ ...s, status: 'reading', error: '', warnings: [] }));
    try {
      const prepared = await Promise.all(files.slice(0, room).map(prepareReceiptImage));
      const next = [...photos, ...prepared.map((ph) => ({ id: ++itemKey, dataUrl: ph.dataUrl, preview: ph.previewUrl }))];
      setPhotos(next);
      await readPhotos(next);
      if (files.length > room) toast(`Only the first ${room} photo${room === 1 ? '' : 's'} were added (max ${MAX_PHOTOS}).`);
    } catch (err) {
      setScan((s) => ({ ...s, status: 'error', error: err.message || 'Couldn’t open that photo.' }));
    }
  };

  const removePhoto = (id) => {
    const gone = photos.find((ph) => ph.id === id);
    if (gone) URL.revokeObjectURL(gone.preview);
    const next = photos.filter((ph) => ph.id !== id);
    setPhotos(next);
    readPhotos(next);
  };

  const tipPercent = (pct) => setTip(centsToInput(Math.round((result.subtotal * pct) / 100)));

  const updateItem = (key, patch) => setItems((its) => its.map((it) => (it.key === key ? { ...it, ...patch } : it)));

  const save = async () => {
    setAttempted(true);
    setServerError('');
    if (errors.length) return;
    setSaving(true);
    const body = {
      type: 'expense',
      groupId,
      description: description.trim(),
      category,
      date,
      notes,
      ...splitInput,
      payers,
    };
    try {
      const d = editId ? await api.put(`/expenses/${editId}`, body) : await api.post('/expenses', body);
      toast(editId ? 'Expense updated' : `Added ${d.expense.description}`);
      if (editId) navigate(`/expenses/${editId}`, { replace: true });
      else if (location.key !== 'default') navigate(-1);
      else navigate(groupId ? `/groups/${groupId}` : `/expenses/${d.expense.id}`, { replace: true });
    } catch (err) {
      setServerError(err.message);
      setSaving(false);
    }
  };

  const close = () => (location.key !== 'default' ? navigate(-1) : navigate('/'));

  // ---- Render ------------------------------------------------------------
  if (boot.loading) {
    return (
      <div className="sheet-page">
        <div className="sheet-bar"><span /><span className="title">{editId ? 'Edit expense' : 'Add expense'}</span><span /></div>
        <div className="stack gap-12" style={{ marginTop: 20 }}>
          <Skeleton h={120} r={22} />
          <Skeleton h={200} r={22} />
          <Skeleton h={200} r={22} />
        </div>
      </div>
    );
  }
  if (boot.error) {
    return (
      <div className="sheet-page">
        <div className="sheet-bar"><button className="icon-btn" onClick={close} aria-label="Close"><X /></button><span className="title">Expense</span><span /></div>
        <div className="callout" style={{ marginTop: 20 }}><AlertCircle /> {boot.error.message}</div>
      </div>
    );
  }

  const nm = (id) => (id === me ? 'You' : firstName(people[id]?.displayName || 'Someone'));
  const showErrors = attempted || (amount && description);
  const firstError = errors[0];

  return (
    <div className="sheet-page">
      <div className="sheet-bar">
        <button className="icon-btn" onClick={close} aria-label="Close"><X /></button>
        <span className="title">{editId ? 'Edit expense' : 'Add expense'}</span>
        <button className="btn btn-primary btn-sm end" onClick={save} disabled={saving}>
          {saving ? <span className="spinner" /> : 'Save'}
        </button>
      </div>

      {/* ---------- Scan a bill ---------- */}
      {!editId && (
        <div className={cls('scan-card', scan.status === 'reading' && 'busy')}>
          <input ref={cameraInput} type="file" accept="image/*" capture="environment" hidden onChange={onPickImages} />
          <input ref={uploadInput} type="file" accept="image/*" multiple hidden onChange={onPickImages} />
          <div className="scan-body">
            {scan.status === 'reading' ? (
              <>
                <strong className="row-flex gap-8"><span className="spinner" /> Reading {photos.length > 1 ? `${photos.length} photos` : 'your bill'}…</strong>
                <span className="muted">Usually a few seconds; up to a minute if the totals need a second look.</span>
              </>
            ) : scan.status === 'done' ? (
              <>
                <strong>{scan.count} item{scan.count === 1 ? '' : 's'} from {photos.length} photo{photos.length === 1 ? '' : 's'}</strong>
                <span className="muted">Tap people on each item below. Tax & tip are split equally. Bill didn’t fit? Add another page.</span>
              </>
            ) : (
              <>
                <strong className="row-flex gap-8"><ScanLine size={18} /> Scan a bill</strong>
                <span className="muted">Snap the receipt, or pick screenshots (e.g. a DoorDash order). Long bill? Add several photos.</span>
              </>
            )}
          </div>
          {photos.length > 0 && (
            <div className="scan-photos" aria-label="Bill photos">
              {photos.map((ph, i) => (
                <div key={ph.id} className="scan-photo">
                  <img src={ph.preview} alt={`Bill photo ${i + 1}`} />
                  {scan.status !== 'reading' && (
                    <button type="button" className="scan-photo-x" onClick={() => removePhoto(ph.id)} aria-label={`Remove photo ${i + 1}`}><X /></button>
                  )}
                </div>
              ))}
            </div>
          )}
          {scan.status !== 'reading' && photos.length < MAX_PHOTOS && (
            <div className="scan-actions">
              <button type="button" className={cls('btn btn-sm', photos.length ? 'btn-secondary' : 'btn-primary')} onClick={() => cameraInput.current?.click()}>
                <Camera /> {photos.length ? 'Add page' : 'Camera'}
              </button>
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => uploadInput.current?.click()}>
                <ImagePlus /> {photos.length ? 'Add photos' : 'Upload'}
              </button>
            </div>
          )}
          {scan.status === 'error' && <div className="callout" role="alert"><AlertCircle /> {scan.error}</div>}
          {scan.status === 'done' && scan.warnings.map((w) => (
            <div key={w} className="callout info"><AlertCircle /> {w}</div>
          ))}
        </div>
      )}

      {/* ---------- Amount + description ---------- */}
      <section style={{ padding: '14px 4px 22px' }}>
        <label className="amount-input">
          <span className="cur">$</span>
          <input
            inputMode="decimal"
            placeholder="0.00"
            value={method === 'itemized' ? centsToInput(result.subtotal) || '' : amount}
            onChange={(e) => setAmount(moneyInput(e.target.value))}
            disabled={method === 'itemized'}
            aria-label={method === 'itemized' ? 'Subtotal (sum of items)' : 'Amount before tax'}
            autoFocus={!editId && !params.get('scan')}
            style={{ width: amountWidth(method === 'itemized' ? centsToInput(result.subtotal) : amount) }}
          />
        </label>
        <p className="muted" style={{ textAlign: 'center', fontSize: 13, marginBottom: 14 }}>
          {method === 'itemized' ? 'Subtotal from items' : taxMode === 'included' ? 'CAD · tax included' : 'CAD · before tax'}
          {result.tax + result.tip > 0 && <> · <strong style={{ color: 'var(--text)' }}>{formatCAD(total)}</strong> with {[result.tax > 0 && 'tax', result.tip > 0 && 'tip'].filter(Boolean).join(' & ')}</>}
        </p>
        <input className="desc-input" placeholder="What was it for?" value={description} onChange={(e) => onDescription(e.target.value)} aria-label="Description" maxLength={140} />
        <div className="chips" style={{ marginTop: 14 }} role="radiogroup" aria-label="Category">
          {CATEGORIES.map((c) => {
            const Icon = c.icon;
            return (
              <button
                key={c.id}
                type="button"
                role="radio"
                aria-checked={category === c.id}
                className={cls('chip', category === c.id && 'active')}
                onClick={() => {
                  categoryTouched.current = true;
                  setCategory(c.id);
                }}
              >
                <Icon /> {c.label}
              </button>
            );
          })}
        </div>
      </section>

      {/* ---------- With ---------- */}
      <div className="form-block">
        <div className="form-block-head">
          <h3><Users /> Split with</h3>
          <label className="row-flex gap-8 muted" style={{ fontSize: 13 }}>
            <input type="date" className="input sm" style={{ width: 150, height: 36 }} value={date} max="2100-12-31" onChange={(e) => setDate(e.target.value)} aria-label="Date" />
          </label>
        </div>
        <div className="chips" role="radiogroup" aria-label="Group">
          {boot.groups.map((g) => (
            <button key={g.id} type="button" role="radio" aria-checked={groupId === g.id} className={cls('chip', groupId === g.id && 'active')} onClick={() => setGroupId(g.id)}>
              {g.name}
            </button>
          ))}
          <button type="button" role="radio" aria-checked={groupId === null} className={cls('chip', groupId === null && 'active')} onClick={() => setGroupId(null)}>
            Choose people
          </button>
        </div>
        {groupId === null && (
          <div className="stack gap-8" style={{ marginTop: 12 }}>
            {friends.length > 0 && (
              <div className="chips wrap">
                {friends.map((f) => (
                  <button key={f.id} type="button" className="chip person active" onClick={() => setFriends((fs) => fs.filter((x) => x.id !== f.id))} aria-label={`Remove ${f.displayName}`}>
                    <Avatar user={f} size="xs" /> {firstName(f.displayName)} <X />
                  </button>
                ))}
              </div>
            )}
            <UserPicker exclude={[me, ...friends.map((f) => f.id)]} onPick={(u) => setFriends((fs) => [...fs, u])} placeholder="Add people by username" />
          </div>
        )}
        {group && (
          <p className="field-hint" style={{ marginTop: 10 }}>
            {group.memberIds.length} members · untick people below to leave them out.
          </p>
        )}
      </div>

      {/* ---------- Paid by ---------- */}
      <div className="form-block">
        <div className="form-block-head">
          <h3><Wallet /> Paid by</h3>
          <div style={{ width: 200 }}>
            <Segmented value={payerMode} onChange={setPayerMode} label="Payer mode" options={[{ id: 'single', label: 'One' }, { id: 'multiple', label: 'Multiple' }]} />
          </div>
        </div>
        {payerMode === 'single' ? (
          <div className="chips wrap" role="radiogroup" aria-label="Who paid">
            {pool.map((id) => (
              <button key={id} type="button" role="radio" aria-checked={payerId === id} className={cls('chip person', payerId === id && 'active')} onClick={() => setPayerId(id)}>
                <Avatar user={people[id]} size="xs" /> {nm(id)}
              </button>
            ))}
          </div>
        ) : (
          <>
            {pool.map((id) => (
              <div key={id} className="person-line">
                <Avatar user={people[id]} size="sm" />
                <span className="name">{nm(id)}</span>
                <div className="input-wrap">
                  <span className="prefix">$</span>
                  <input className="input sm num has-prefix" inputMode="decimal" placeholder="0.00" value={payerAmounts[id] || ''} onChange={(e) => setPayerAmounts((p) => ({ ...p, [id]: moneyInput(e.target.value) }))} aria-label={`${nm(id)} paid`} />
                </div>
              </div>
            ))}
            <div className="remaining">
              <span className="muted">Paid {formatCAD(payerSum)} of {formatCAD(total)}</span>
              {payerSum === total && total > 0 ? (
                <span className="pos" style={{ fontWeight: 600 }}>Balanced</span>
              ) : (
                <span className="neg" style={{ fontWeight: 600 }}>
                  {payerSum < total ? `${formatCAD(total - payerSum)} left` : `${formatCAD(payerSum - total)} over`}
                </span>
              )}
            </div>
          </>
        )}
      </div>

      {/* ---------- Tax ---------- */}
      <div className="form-block">
        <div className="form-block-head">
          <h3><Receipt /> Tax & tip</h3>
          {result.tax + result.tip > 0 && <span className="muted num" style={{ fontSize: 13 }}>+{formatCAD(result.tax + result.tip)}</span>}
        </div>
        <Segmented value={taxMode} onChange={setTaxMode} label="Tax" options={TAX_OPTIONS} />
        {taxMode === 'percent' && (
          <div className="stack gap-8" style={{ marginTop: 12 }}>
            <div className="chips">
              {TAX_PRESETS.map((p) => (
                <button key={p.v} type="button" className={cls('chip', taxValue === p.v && 'active')} onClick={() => setTaxValue(p.v)}>
                  {p.label}
                </button>
              ))}
            </div>
            <div className="input-wrap">
              <input className="input has-suffix" inputMode="decimal" value={taxValue} onChange={(e) => setTaxValue(numInput(e.target.value))} aria-label="Tax rate" placeholder="13" />
              <span className="suffix">%</span>
            </div>
          </div>
        )}
        {taxMode === 'amount' && (
          <div className="input-wrap" style={{ marginTop: 12 }}>
            <span className="prefix">$</span>
            <input className="input has-prefix" inputMode="decimal" value={taxValue} onChange={(e) => setTaxValue(moneyInput(e.target.value))} aria-label="Tax amount" placeholder="0.00" />
          </div>
        )}
        <div className="tip-row">
          <span className="field-label" style={{ margin: 0 }}>Tip</span>
          <div className="chips">
            {TIP_PRESETS.map((p) => (
              <button key={p} type="button" className="chip" onClick={() => tipPercent(p)} disabled={!result.subtotal}>{p}%</button>
            ))}
          </div>
          <div className="input-wrap">
            <span className="prefix">$</span>
            <input className="input sm num has-prefix" inputMode="decimal" value={tip} onChange={(e) => setTip(moneyInput(e.target.value))} aria-label="Tip amount" placeholder="0.00" />
          </div>
        </div>
        {(result.tax > 0 || result.tip > 0) && (
          <div className="row-flex gap-8" style={{ marginTop: 12, justifyContent: 'space-between' }}>
            <span className="field-label" style={{ margin: 0 }}>Split {[result.tax > 0 && 'tax', result.tip > 0 && 'tip'].filter(Boolean).join(' & ')}</span>
            <div style={{ width: 210 }}>
              <Segmented value={extrasSplit} onChange={setExtrasSplit} label="How to split tax and tip" options={EXTRAS_OPTIONS} />
            </div>
          </div>
        )}
        <p className="field-hint" style={{ marginTop: 10 }}>
          {taxMode === 'included' && !result.tip
            ? 'The amount above already includes tax.'
            : extrasSplit === 'equal'
              ? `Split equally between everyone on the bill${method === 'itemized' && taxMode !== 'included' ? ' (tax only between people with taxable items)' : ''}.`
              : method === 'itemized'
                ? 'Tax and tip follow what each person had (tax only on taxable items).'
                : 'Tax and tip are shared in proportion to each person’s portion.'}
        </p>
      </div>

      {/* ---------- Split ---------- */}
      <div className="form-block">
        <div className="form-block-head">
          <h3><Divide /> Split</h3>
          {method === 'equal' && (
            <button type="button" className="link-btn" onClick={() => setSelected(selected.length === pool.length ? [] : pool)}>
              {selected.length === pool.length ? 'Clear' : 'Everyone'}
            </button>
          )}
          {method === 'percent' && (
            <button type="button" className="link-btn" onClick={() => setValues((vs) => ({ ...vs, percent: evenPercents(pool) }))}>Even split</button>
          )}
        </div>
        <Segmented value={method} onChange={changeMethod} label="Split method" options={SPLIT_OPTIONS} grid />
        <div style={{ marginTop: 10 }}>
          {method === 'equal' &&
            pool.map((id) => {
              const on = selected.includes(id);
              const s = shareOf(id);
              return (
                <button key={id} type="button" className="person-line" onClick={() => toggleSelected(id)} aria-pressed={on}>
                  <Check on={on} />
                  <Avatar user={people[id]} size="sm" />
                  <span className="name">{nm(id)}</span>
                  <span className={cls('num', !on && 'faint')} style={{ fontWeight: 600 }}>{on && s ? formatCAD(s.amount) : '—'}</span>
                </button>
              );
            })}

          {(method === 'exact' || method === 'percent' || method === 'shares') &&
            pool.map((id) => {
              const s = shareOf(id);
              const v = values[method][id] || '';
              return (
                <div key={id} className="person-line">
                  <Avatar user={people[id]} size="sm" />
                  <span className="name">
                    {nm(id)}
                    <small className="num">{s && s.amount ? `owes ${formatCAD(s.amount)}${s.tax + s.tip ? ` incl. ${formatCAD(s.tax + s.tip)} ${[s.tax && 'tax', s.tip && 'tip'].filter(Boolean).join(' & ')}` : ''}` : 'not included'}</small>
                  </span>
                  <div className="input-wrap">
                    {method === 'exact' && <span className="prefix">$</span>}
                    <input
                      className={cls('input sm num', method === 'exact' && 'has-prefix', method !== 'exact' && 'has-suffix')}
                      inputMode="decimal"
                      placeholder="0"
                      value={v}
                      onChange={(e) => setValue(method, id, method === 'exact' ? moneyInput(e.target.value) : numInput(e.target.value, method === 'percent' ? 2 : 2))}
                      aria-label={`${nm(id)} ${method}`}
                    />
                    {method === 'percent' && <span className="suffix">%</span>}
                    {method === 'shares' && <span className="suffix" style={{ fontSize: 12 }}>×</span>}
                  </div>
                </div>
              );
            })}

          {method === 'exact' && (() => {
            const assigned = pool.reduce((a, id) => a + toCents(values.exact[id]), 0);
            const sub = toCents(amount);
            return (
              <div className="remaining">
                <span className="muted">{formatCAD(assigned)} of {formatCAD(sub)} assigned{taxMode !== 'included' ? ' (before tax)' : ''}</span>
                {assigned === sub && sub > 0 ? <span className="pos" style={{ fontWeight: 600 }}>Balanced</span> : <span className="neg" style={{ fontWeight: 600 }}>{assigned < sub ? `${formatCAD(sub - assigned)} left` : `${formatCAD(assigned - sub)} over`}</span>}
              </div>
            );
          })()}
          {method === 'percent' && (() => {
            const sum = pool.reduce((a, id) => a + (Number(values.percent[id]) || 0), 0);
            const ok = Math.abs(sum - 100) < 0.001;
            return (
              <div className="remaining">
                <span className="muted">{+sum.toFixed(2)}% of 100%</span>
                {ok ? <span className="pos" style={{ fontWeight: 600 }}>Balanced</span> : <span className="neg" style={{ fontWeight: 600 }}>{sum < 100 ? `${+(100 - sum).toFixed(2)}% left` : `${+(sum - 100).toFixed(2)}% over`}</span>}
              </div>
            );
          })()}

          {method === 'itemized' && (
            <div style={{ marginTop: 6 }}>
              {items.map((it, idx) => (
                <div key={it.key} className="item-card">
                  <div className="item-card-top">
                    <input className="input sm" placeholder={`Item ${idx + 1}`} value={it.name} onChange={(e) => updateItem(it.key, { name: e.target.value })} aria-label={`Item ${idx + 1} name`} />
                    <div className="input-wrap">
                      <span className="prefix">$</span>
                      <input className="input sm num has-prefix" inputMode="decimal" placeholder="0.00" value={it.amount} onChange={(e) => updateItem(it.key, { amount: moneyInput(e.target.value) })} aria-label={`Item ${idx + 1} price`} />
                    </div>
                    <button type="button" className="icon-btn" style={{ width: 38, height: 38 }} onClick={() => setItems((its) => its.filter((x) => x.key !== it.key))} aria-label={`Remove item ${idx + 1}`}>
                      <Trash2 size={18} />
                    </button>
                  </div>
                  <div className="chips wrap">
                    {pool.length > 2 && (
                      <button
                        type="button"
                        className={cls('chip', it.userIds.length === pool.length && 'active')}
                        aria-pressed={it.userIds.length === pool.length}
                        onClick={() => updateItem(it.key, { userIds: pool })}
                      >
                        <Users /> Everyone
                      </button>
                    )}
                    {pool.map((id) => {
                      const on = it.userIds.includes(id);
                      return (
                        <button
                          key={id}
                          type="button"
                          className={cls('chip person', on && 'active')}
                          aria-pressed={on}
                          onClick={() => updateItem(it.key, { userIds: on ? it.userIds.filter((x) => x !== id) : [...it.userIds, id] })}
                        >
                          <Avatar user={people[id]} size="xs" /> {nm(id)}
                        </button>
                      );
                    })}
                  </div>
                  {it.userIds.length > 1 && toCents(it.amount) > 0 && (
                    <p className="field-hint" style={{ marginTop: 8 }}>
                      Split {it.userIds.length} ways · {formatCAD(allocate(toCents(it.amount), it.userIds.map(() => 1))[0])} each
                    </p>
                  )}
                  {it.userIds.length === 0 && <p className="field-hint neg" style={{ marginTop: 8 }}>Tap who had this.</p>}
                  {taxMode !== 'included' && (
                    <button type="button" className="mini-toggle" onClick={() => updateItem(it.key, { taxable: !it.taxable })} aria-pressed={it.taxable}>
                      <Check on={it.taxable} /> Taxable
                    </button>
                  )}
                </div>
              ))}
              <button type="button" className="btn btn-secondary btn-block" style={{ marginTop: 10 }} onClick={() => setItems((its) => [...its, newItem(pool)])}>
                <Plus /> Add item
              </button>
            </div>
          )}
        </div>
      </div>

      {/* ---------- Breakdown ---------- */}
      {result.shares.length > 0 && total > 0 && (
        <div className="form-block">
          <div className="form-block-head">
            <h3><Sparkles /> Breakdown</h3>
            <span className="muted num" style={{ fontSize: 13 }}>{formatCAD(total)}</span>
          </div>
          {result.shares.filter((s) => s.amount > 0).map((s) => {
            const paid = payers.find((p) => p.userId === s.userId)?.amount || 0;
            const net = paid - s.amount;
            return (
              <div key={s.userId} className="share-row">
                <Avatar user={people[s.userId]} size="sm" />
                <div className="who">
                  <strong>{nm(s.userId)}</strong>
                  <span className="num">
                    {s.tax || s.tip
                      ? [formatCAD(s.base), s.tax && `+ ${formatCAD(s.tax)} tax`, s.tip && `+ ${formatCAD(s.tip)} tip`].filter(Boolean).join(' ')
                      : `share ${formatCAD(s.amount)}`}
                    {paid ? ` · paid ${formatCAD(paid)}` : ''}
                  </span>
                </div>
                <div className={cls('amt', net > 0 && 'pos', net < 0 && 'neg')}>
                  {net === 0 ? 'even' : net > 0 ? `gets ${formatCAD(net)}` : `owes ${formatCAD(net)}`}
                </div>
              </div>
            );
          })}
          {payers.filter((p) => !result.shares.some((s) => s.userId === p.userId && s.amount > 0)).map((p) => (
            <div key={p.userId} className="share-row">
              <Avatar user={people[p.userId]} size="sm" />
              <div className="who"><strong>{nm(p.userId)}</strong><span className="num">paid {formatCAD(p.amount)} · not in split</span></div>
              <div className="amt pos">gets {formatCAD(p.amount)}</div>
            </div>
          ))}
        </div>
      )}

      {/* ---------- Notes ---------- */}
      <div className="form-block">
        {showNotes ? (
          <div className="field">
            <label className="field-label" htmlFor="notes">Notes</label>
            <textarea id="notes" className="textarea" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Receipt details, who bought what…" maxLength={1000} />
          </div>
        ) : (
          <button type="button" className="link-btn" onClick={() => setShowNotes(true)}>
            <StickyNote /> Add a note
          </button>
        )}
      </div>

      {/* ---------- Footer ---------- */}
      <div className="sheet-foot">
        <div className="sheet-foot-inner stack" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
          {(serverError || (showErrors && firstError)) && (
            <div className="callout" role="alert">
              <AlertCircle /> {serverError || firstError}
            </div>
          )}
          <button className="btn btn-primary btn-lg btn-block" onClick={save} disabled={saving}>
            {saving ? <span className="spinner" /> : <>Save {total > 0 ? formatCAD(total) : 'expense'}</>}
          </button>
        </div>
      </div>
    </div>
  );
}
