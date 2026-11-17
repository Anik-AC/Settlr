import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Search, History, Bot } from 'lucide-react';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { Avatar, Empty, ErrorState, ListSkeleton, Segmented, TopBar } from '../components/ui.jsx';
import ReviewList from '../components/ReviewList.jsx';
import { formatCAD, formatDate, nameOf, cls } from '../lib/format.js';
import { categoryOf } from '../lib/categories.js';

const PAGE = 50;

/** Activity timestamps are stored in UTC ("YYYY-MM-DD HH:MM:SS"). */
const toDate = (at) => new Date(`${String(at).replace(' ', 'T')}Z`);
const localDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function dayLabel(d) {
  const today = new Date();
  const yesterday = new Date(Date.now() - 86400000);
  if (localDay(d) === localDay(today)) return 'Today';
  if (localDay(d) === localDay(yesterday)) return 'Yesterday';
  return d.toLocaleDateString('en-CA', { weekday: 'long', month: 'short', day: 'numeric', ...(d.getFullYear() !== today.getFullYear() && { year: 'numeric' }) });
}

/** "Total $25.00 → $30.00", "Ana $10.00 → $12.00", … */
function describeChange(c, people, me, groupNames) {
  const who = (id) => nameOf(people, Number(id), me);
  switch (c.field) {
    case 'total': return `Total ${formatCAD(c.from)} → ${formatCAD(c.to)}`;
    case 'date': return `Bill date ${formatDate(c.from)} → ${formatDate(c.to)}`;
    case 'description': return `Name “${c.from}” → “${c.to}”`;
    case 'category': return `Category ${categoryOf(c.from).label} → ${categoryOf(c.to).label}`;
    case 'group': return `Moved ${c.from ? `from ${groupNames[c.from] || 'a group'}` : 'from non-group'} ${c.to ? `to ${groupNames[c.to] || 'a group'}` : 'to non-group'}`;
    case 'notes': return 'Notes edited';
    case 'payers':
    case 'shares': {
      const ids = [...new Set([...Object.keys(c.from || {}), ...Object.keys(c.to || {})])];
      const parts = ids
        .filter((id) => (c.from?.[id] || 0) !== (c.to?.[id] || 0))
        .map((id) => {
          const a = c.from?.[id];
          const b = c.to?.[id];
          if (!a) return `${who(id)} added (${formatCAD(b)})`;
          if (!b) return `${who(id)} removed (was ${formatCAD(a)})`;
          return `${who(id)} ${formatCAD(a)} → ${formatCAD(b)}`;
        });
      return `${c.field === 'payers' ? 'Paid by' : 'Shares'}: ${parts.join(', ')}`;
    }
    default: return null;
  }
}

function ActivityRow({ e, people, me, groupNames, unseen }) {
  const actor = nameOf(people, e.actorId, me);
  const isPayment = e.expenseType === 'payment';
  const verb = { created: isPayment ? 'recorded' : 'added', updated: 'edited', deleted: 'deleted' }[e.action];
  const at = toDate(e.at);
  const changes = e.action === 'updated' ? e.changes.map((c) => describeChange(c, people, me, groupNames)).filter(Boolean) : [];
  const body = (
    <>
      <Avatar user={people[e.actorId]} size="sm" />
      <span className="item-main">
        <span className={cls('activity-title', e.action === 'deleted' && 'deleted')}>
          <strong>{actor}</strong> {verb} {isPayment && e.action !== 'created' ? 'a payment: ' : ''}<strong>{e.description}</strong>
        </span>
        <span className="item-sub" style={{ whiteSpace: 'normal' }}>
          {formatCAD(e.total)} · {e.groupName || 'Non-group'} · bill dated {formatDate(e.date)}
          {e.source === 'assistant' && <> · <Bot size={12} style={{ verticalAlign: -1 }} /> via AI assistant</>}
          {e.source === 'admin' && ' · by admin'}
        </span>
        {changes.length > 0 && (
          <span className="activity-changes">
            {changes.map((t) => <span key={t}>{t}</span>)}
          </span>
        )}
      </span>
      <span className="item-end" style={{ alignSelf: 'flex-start' }}>
        <span className="label">{at.toLocaleTimeString('en-CA', { hour: 'numeric', minute: '2-digit' })}</span>
        {unseen && <span className="activity-dot" aria-label="New" />}
      </span>
    </>
  );
  return e.exists && e.action !== 'deleted'
    ? <Link to={`/expenses/${e.expenseId}`} className="item activity-item">{body}</Link>
    : <div className="item activity-item">{body}</div>;
}

export default function Activity() {
  const { user } = useAuth();
  const me = user.id;
  const [params, setParams] = useSearchParams();
  const initial = ['everyone', 'mine', 'review'].includes(params.get('tab')) ? params.get('tab') : 'everyone';
  const [tab, setTabState] = useState(initial);
  const [q, setQ] = useState('');
  const [term, setTerm] = useState('');
  const [drafts, setDrafts] = useState(null);
  const [state, setState] = useState({ entries: [], people: {}, groupNames: {}, hasMore: false, loading: true, error: null, seenId: 0 });

  const setTab = (t) => {
    setTabState(t);
    setParams(t === 'everyone' ? {} : { tab: t }, { replace: true });
  };

  useEffect(() => {
    api.get('/drafts').then((d) => setDrafts(d.drafts)).catch(() => setDrafts([]));
  }, []);
  useEffect(() => {
    const t = setTimeout(() => setTerm(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);

  const query = (before) => {
    const p = new URLSearchParams({ limit: PAGE, scope: tab === 'mine' ? 'mine' : 'everyone' });
    if (term) p.set('q', term);
    if (before) p.set('before', before);
    return `/activity?${p}`;
  };

  useEffect(() => {
    if (tab === 'review') return undefined;
    let alive = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    api
      .get(query())
      .then((d) => {
        if (!alive) return;
        setState({ entries: d.entries, people: d.people, groupNames: d.groupNames, hasMore: d.hasMore, loading: false, error: null, seenId: d.seenId });
        // Looking at everyone's activity clears the "new activity" badge.
        const top = d.entries[0]?.id;
        if (tab === 'everyone' && !term && top && top > d.seenId) {
          api.post('/activity/seen', { upTo: top }).then(() => window.dispatchEvent(new Event('settlr:badges'))).catch(() => {});
        }
      })
      .catch((error) => alive && setState((s) => ({ ...s, loading: false, error })));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, term]);

  const more = async () => {
    setState((s) => ({ ...s, loading: true }));
    try {
      const d = await api.get(query(state.entries.at(-1)?.id));
      setState((s) => ({ ...s, entries: [...s.entries, ...d.entries], people: { ...s.people, ...d.people }, groupNames: { ...s.groupNames, ...d.groupNames }, hasMore: d.hasMore, loading: false }));
    } catch (error) {
      setState((s) => ({ ...s, loading: false, error }));
    }
  };

  // Group entries by the day the action happened.
  const days = [];
  for (const e of state.entries) {
    const d = toDate(e.at);
    const key = localDay(d);
    if (!days.length || days.at(-1).key !== key) days.push({ key, label: dayLabel(d), items: [] });
    days.at(-1).items.push(e);
  }

  return (
    <>
      <TopBar title={<span className="hide-desktop">Activity</span>} />
      <div className="page-head">
        <h1>Activity</h1>
        <p>Who added, edited or deleted what, and when.</p>
      </div>
      <div className="stack gap-12" style={{ marginBottom: 8 }}>
        <Segmented
          value={tab}
          onChange={setTab}
          label="Show"
          options={[
            { id: 'everyone', label: 'Everyone' },
            { id: 'mine', label: 'Yours' },
            { id: 'review', label: drafts?.length ? `To review (${drafts.length})` : 'To review' },
          ]}
        />
        {tab !== 'review' && (
          <div className="input-wrap">
            <Search className="prefix" size={17} style={{ left: 14 }} />
            <input className="input" style={{ paddingLeft: 40 }} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name" aria-label="Search activity" type="search" />
          </div>
        )}
      </div>

      {tab === 'review' ? (
        drafts ? <ReviewList drafts={drafts} /> : <ListSkeleton rows={3} />
      ) : (
        <>
          {state.error && <ErrorState error={state.error} />}
          {state.loading && !state.entries.length && <ListSkeleton rows={6} />}
          {!state.loading && !state.error && !state.entries.length && (
            <Empty icon={History} title={term ? 'No matches' : 'No activity yet'}>
              {term ? `Nothing matches “${term}”.` : tab === 'mine' ? 'Things you add, edit or delete show up here.' : 'When anyone adds, edits or deletes an expense, it shows up here.'}
            </Empty>
          )}
          {days.map((day) => (
            <section key={day.key} className="activity-day">
              <h2 className="eyebrow activity-day-label">{day.label}</h2>
              <div className="list card">
                {day.items.map((e) => (
                  <ActivityRow key={e.id} e={e} people={state.people} me={me} groupNames={state.groupNames} unseen={tab === 'everyone' && e.actorId !== me && e.id > state.seenId} />
                ))}
              </div>
            </section>
          ))}
          {state.hasMore && (
            <button className="btn btn-secondary btn-block" style={{ marginTop: 16 }} onClick={more} disabled={state.loading}>
              {state.loading ? <span className="spinner" /> : 'Load more'}
            </button>
          )}
        </>
      )}
    </>
  );
}
