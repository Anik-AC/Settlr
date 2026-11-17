import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Users, Check as CheckIcon, Sparkles } from 'lucide-react';
import { useApi } from '../lib/useApi.js';
import { useAuth } from '../lib/auth.jsx';
import { Avatar, BalanceLabel, Empty, ErrorState, ListSkeleton, Segmented, TopBar, UserPicker } from '../components/ui.jsx';
import { TransferRow } from './GroupDetail.jsx';
import { formatCAD } from '../lib/format.js';

export default function People() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const { data, error, loading, reload } = useApi('/people');
  const [view, setView] = useState(() => localStorage.getItem('settlr-people-view') || 'direct');
  const [showAll, setShowAll] = useState(false);
  const changeView = (v) => {
    setView(v);
    localStorage.setItem('settlr-people-view', v);
  };

  return (
    <>
      <TopBar title={<span className="hide-desktop">People</span>} />
      <div className="page-head">
        <h1>People</h1>
        <p>Your balance with each friend, across every group.</p>
      </div>

      <div className="stack gap-12" style={{ marginBottom: 18 }}>
        <UserPicker onPick={(u) => navigate(`/people/${u.username}`)} placeholder="Find someone by username" />
        <Segmented
          value={view}
          onChange={changeView}
          label="Balance view"
          options={[
            { id: 'direct', label: 'Direct balances' },
            { id: 'simplified', label: 'Simplified', icon: Sparkles },
          ]}
        />
      </div>

      {error && <ErrorState error={error} onRetry={reload} />}
      {loading && !data && <ListSkeleton />}

      {data && view === 'direct' && (
        data.people.length ? (
          <div className="list card">
            {data.people.map((p) => (
              <Link key={p.user.id} to={`/people/${p.user.username}`} className="item">
                <Avatar user={p.user} />
                <span className="item-main">
                  <span className="item-title">{p.user.displayName}</span>
                  <span className="item-sub">
                    {p.groups.length
                      ? p.groups.map((g) => `${g.groupName || 'Non-group'} ${formatCAD(g.amount, { signed: true })}`).join(' · ')
                      : `@${p.user.username}`}
                  </span>
                </span>
                <BalanceLabel cents={p.balance} />
              </Link>
            ))}
          </div>
        ) : (
          <div className="card">
            <Empty icon={Users} title="No one yet">Search for a friend’s username above to start splitting.</Empty>
          </div>
        )
      )}

      {data && view === 'simplified' && (
        <div className="stack gap-12">
          <div className="callout info">
            <Sparkles />
            <span>
              Balances across all your groups and people, netted out so everyone settles with the fewest payments.
              This may suggest paying someone you don’t owe directly.
            </span>
          </div>
          {data.simplified.transfers.length ? (
            <div>
              <div className="section-head"><h2>Your payments</h2></div>
              {data.simplified.transfers.map((t, i) => (
                <TransferRow
                  key={i}
                  t={t}
                  me={user.id}
                  people={{ ...data.simplified.people, [user.id]: user }}
                  settleHref={(x) => `/settle?from=${x.from}&to=${x.to}&amount=${x.amount}`}
                />
              ))}
            </div>
          ) : (
            <div className="callout ok"><CheckIcon /> You have nothing to settle.</div>
          )}
          {data.simplified.everyone.length > data.simplified.transfers.length && (
            <div>
              <button className="link-btn" onClick={() => setShowAll((s) => !s)} style={{ margin: '8px 4px' }}>
                {showAll ? 'Hide' : 'Show'} everyone’s simplified payments
              </button>
              {showAll &&
                data.simplified.everyone
                  .filter((t) => t.from !== user.id && t.to !== user.id)
                  .map((t, i) => <TransferRow key={i} t={t} me={user.id} people={data.simplified.people} />)}
            </div>
          )}
        </div>
      )}
    </>
  );
}
