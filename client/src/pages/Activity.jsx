import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import ReviewList from '../components/ReviewList.jsx';
import { Search, Receipt } from 'lucide-react';
import { api } from '../lib/api.js';
import { Empty, ErrorState, ListSkeleton, Segmented, TopBar } from '../components/ui.jsx';
import { ExpenseList } from '../components/ExpenseRow.jsx';

const PAGE = 40;

export default function Activity() {
  const [params, setParams] = useSearchParams();
  const [type, setTypeState] = useState(() => (params.get('tab') === 'review' ? 'review' : 'all'));
  const [drafts, setDrafts] = useState(null);
  const setType = (t) => {
    setTypeState(t);
    setParams(t === 'review' ? { tab: 'review' } : {}, { replace: true });
  };
  useEffect(() => {
    api.get('/drafts').then((d) => setDrafts(d.drafts)).catch(() => setDrafts([]));
  }, []);
  const [q, setQ] = useState('');
  const [term, setTerm] = useState('');
  const [state, setState] = useState({ expenses: [], people: {}, hasMore: false, loading: true, error: null });

  useEffect(() => {
    const t = setTimeout(() => setTerm(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);

  const query = (offset) => {
    const p = new URLSearchParams({ limit: PAGE, offset });
    if (type !== 'all') p.set('type', type);
    if (term) p.set('q', term);
    return `/expenses?${p}`;
  };

  useEffect(() => {
    if (type === 'review') return undefined;
    let alive = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    api
      .get(query(0))
      .then((d) => alive && setState({ expenses: d.expenses, people: d.people, hasMore: d.hasMore, loading: false, error: null }))
      .catch((error) => alive && setState((s) => ({ ...s, loading: false, error })));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type, term]);

  const more = async () => {
    setState((s) => ({ ...s, loading: true }));
    try {
      const d = await api.get(query(state.expenses.length));
      setState((s) => ({ expenses: [...s.expenses, ...d.expenses], people: { ...s.people, ...d.people }, hasMore: d.hasMore, loading: false, error: null }));
    } catch (error) {
      setState((s) => ({ ...s, loading: false, error }));
    }
  };

  return (
    <>
      <TopBar title={<span className="hide-desktop">Activity</span>} />
      <div className="page-head">
        <h1>Activity</h1>
        <p>Every expense and payment you can see.</p>
      </div>
      <div className="stack gap-12" style={{ marginBottom: 8 }}>
        <div className="input-wrap">
          <Search className="prefix" size={17} style={{ left: 14 }} />
          <input className="input" style={{ paddingLeft: 40 }} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search descriptions and notes" aria-label="Search activity" type="search" />
        </div>
        <Segmented
          value={type}
          onChange={setType}
          label="Filter"
          options={[
            { id: 'all', label: 'All' },
            { id: 'expense', label: 'Expenses' },
            { id: 'payment', label: 'Payments' },
            { id: 'review', label: drafts?.length ? `To review (${drafts.length})` : 'To review' },
          ]}
        />
      </div>
      {type === 'review' ? (drafts ? <ReviewList drafts={drafts} /> : <ListSkeleton rows={3} />) : (
      <>
      {state.error && <ErrorState error={state.error} />}
      {state.loading && !state.expenses.length && <ListSkeleton rows={6} />}
      {!state.loading && !state.error && !state.expenses.length && (
        <Empty icon={Receipt} title={term ? 'No matches' : 'Nothing here yet'}>
          {term ? `Nothing matches “${term}”.` : 'Add an expense and it will show up here.'}
        </Empty>
      )}
      {state.expenses.length > 0 && <ExpenseList expenses={state.expenses} people={state.people} />}
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
