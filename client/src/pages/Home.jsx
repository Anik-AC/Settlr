import { Link } from 'react-router-dom';
import { Plus, ArrowLeftRight, ChevronRight, Users, Receipt, ScanLine, Bot } from 'lucide-react';
import { useAuth } from '../lib/auth.jsx';
import { useApi } from '../lib/useApi.js';
import { Avatar, AvatarStack, BalanceLabel, BigMoney, CategoryGlyph, Empty, ErrorState, Skeleton, ListSkeleton } from '../components/ui.jsx';
import { ExpenseRow } from '../components/ExpenseRow.jsx';
import { Brand } from '../components/AppShell.jsx';
import { formatCAD, firstName, monthLabel, relativeDate, cls } from '../lib/format.js';
import { categoryOf, groupKindOf } from '../lib/categories.js';

function greeting() {
  const h = new Date().getHours();
  if (h < 5) return 'Up late';
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

export function GroupGlyph({ kind, size = '' }) {
  const Icon = groupKindOf(kind).icon;
  const tone = { home: 'lime', trip: 'sky', couple: 'rose', other: 'iris' }[kind] || 'iris';
  return (
    <span className={cls('glyph', size, `tone-${tone}`)} aria-hidden="true">
      <Icon />
    </span>
  );
}

export function GroupNet({ cents }) {
  if (!cents) return <span className="item-end"><span className="label">settled up</span></span>;
  return (
    <span className="item-end">
      <span className="label">{cents > 0 ? 'you are owed' : 'you owe'}</span>
      <span className={cls('value', cents > 0 ? 'pos' : 'neg')}>{formatCAD(cents)}</span>
    </span>
  );
}

export default function Home() {
  const { user } = useAuth();
  const { data, error, loading, reload } = useApi('/dashboard');

  return (
    <>
      <header className="topbar hide-desktop">
        <Brand />
        <div className="spacer" />
        <Link to="/account" aria-label="Account">
          <Avatar user={user} size="sm" />
        </Link>
      </header>

      <div className="page-head" style={{ paddingTop: 4 }}>
        <span className="eyebrow">{new Date().toLocaleDateString('en-CA', { weekday: 'long', month: 'long', day: 'numeric' })}</span>
        <h1 style={{ marginTop: 6 }}>
          {greeting()}, {firstName(user.displayName)}
        </h1>
      </div>

      {error && <ErrorState error={error} onRetry={reload} />}
      {loading && !data && (
        <div className="stack gap-12">
          <Skeleton h={230} r={28} />
          <ListSkeleton rows={3} />
        </div>
      )}
      {data && <Dashboard data={data} />}
    </>
  );
}

function Dashboard({ data }) {
  const { totals, balances, groups, month } = data;
  const net = totals.net;
  const nonZero = balances.filter((b) => b.balance !== 0);
  const settled = !totals.owed && !totals.owe;
  const catEntries = Object.entries(month.byCategory).sort((a, b) => b[1] - a[1]);
  const maxCat = Math.max(1, ...catEntries.map(([, v]) => v));

  return (
    <>
      <section className="hero" style={{ '--hero-tone': net < 0 ? 'var(--coral)' : 'var(--lime)' }} aria-label="Your overall balance">
        <span className="eyebrow">{settled ? 'All settled' : net >= 0 ? 'Overall, you are owed' : 'Overall, you owe'}</span>
        <div className={cls('hero-amount', !settled && (net >= 0 ? 'pos' : 'neg'))}>
          <BigMoney cents={net} />
        </div>
        <p className="hero-sub">
          {settled
            ? 'Nobody owes anybody. Enjoy it while it lasts.'
            : `Across ${nonZero.length} ${nonZero.length === 1 ? 'person' : 'people'}${groups.length ? ` and ${groups.length} ${groups.length === 1 ? 'group' : 'groups'}` : ''}.`}
        </p>
        <div className="split-bar" aria-hidden="true">
          {settled ? (
            <span className="none" />
          ) : (
            <>
              {totals.owed > 0 && <span className="owed" style={{ flexGrow: totals.owed }} />}
              {totals.owe > 0 && <span className="owe" style={{ flexGrow: totals.owe }} />}
            </>
          )}
        </div>
        <div className="legend">
          <div className="legend-item">
            <span className="eyebrow"><span className="dot" style={{ background: 'var(--pos)' }} />You are owed</span>
            <strong className="num">{formatCAD(totals.owed)}</strong>
          </div>
          <div className="legend-item">
            <span className="eyebrow"><span className="dot" style={{ background: 'var(--neg)' }} />You owe</span>
            <strong className="num">{formatCAD(totals.owe)}</strong>
          </div>
        </div>
      </section>

      {data.pendingReview > 0 && (
        <Link to="/activity?tab=review" className="review-banner">
          <Bot size={20} />
          <span style={{ flex: 1 }}>
            <strong>{data.pendingReview} bill{data.pendingReview === 1 ? '' : 's'} to review</strong>
            <span className="muted" style={{ display: 'block', fontSize: 13 }}>Your AI assistant read {data.pendingReview === 1 ? 'it' : 'them'}. Tap to choose who had what.</span>
          </span>
          <ChevronRight size={18} />
        </Link>
      )}

      <div className="quick-actions">
        <Link to="/expenses/new" className="btn btn-primary btn-lg">
          <Plus /> Add expense
        </Link>
        <Link to="/settle" className="btn btn-secondary btn-lg">
          <ArrowLeftRight /> Settle up
        </Link>
        <Link to="/expenses/new?scan=1" className="btn btn-secondary btn-lg" style={{ gridColumn: '1 / -1' }}>
          <ScanLine /> Scan a bill
        </Link>
      </div>

      <section className="section">
        <div className="section-head">
          <h2>Balances</h2>
          <Link to="/people" className="link-btn">All people <ChevronRight /></Link>
        </div>
        {balances.length ? (
          <div className="list card">
            {balances.slice(0, 5).map((b) => (
              <Link key={b.user.id} to={`/people/${b.user.username}`} className="item">
                <Avatar user={b.user} />
                <span className="item-main">
                  <span className="item-title">{b.user.displayName}</span>
                  <span className="item-sub">
                    {b.groups.length
                      ? b.groups.map((g) => g.groupName || 'Non-group').join(' · ')
                      : `@${b.user.username}`}
                  </span>
                </span>
                <BalanceLabel cents={b.balance} />
              </Link>
            ))}
          </div>
        ) : (
          <div className="card">
            <Empty icon={Users} title="No one here yet">Create a group or add an expense with a friend’s username.</Empty>
          </div>
        )}
      </section>

      <section className="section">
        <div className="section-head">
          <h2>Groups</h2>
          <Link to="/groups" className="link-btn">All groups <ChevronRight /></Link>
        </div>
        {groups.length ? (
          <div className="list card">
            {groups.map((g) => (
              <Link key={g.id} to={`/groups/${g.id}`} className="item">
                <GroupGlyph kind={g.kind} />
                <span className="item-main">
                  <span className="item-title">{g.name}</span>
                  <span className="item-sub row-flex gap-8">
                    <AvatarStack users={g.memberIds.map((id) => data.groupPeople[id]).filter(Boolean)} size="xs" />
                    {g.memberIds.length} members
                  </span>
                </span>
                <GroupNet cents={g.myNet} />
              </Link>
            ))}
          </div>
        ) : (
          <div className="card">
            <Empty icon={Users} title="No groups yet" action={<Link to="/groups?new=1" className="btn btn-secondary btn-sm">Create a group</Link>} />
          </div>
        )}
      </section>

      {month.share > 0 && (
        <section className="section">
          <div className="section-head">
            <h2>{monthLabel(month.key).split(' ')[0]} so far</h2>
            <span className="muted num">your share {formatCAD(month.share)}</span>
          </div>
          <div className="card card-pad cat-bars">
            {catEntries.map(([cat, v]) => {
              const c = categoryOf(cat);
              return (
                <div key={cat} className="cat-bar">
                  <CategoryGlyph category={cat} size="sm" />
                  <div>
                    <div className="meta">
                      <span>{c.label}</span>
                      <span className="num">{formatCAD(v)}</span>
                    </div>
                    <div className="bar-track">
                      <div className={cls('bar-fill', `tone-${c.tone}`)} style={{ width: `${(v / maxCat) * 100}%` }} />
                    </div>
                  </div>
                  <span className="muted num" style={{ fontSize: 12, width: 34, textAlign: 'right' }}>
                    {Math.round((v / month.share) * 100)}%
                  </span>
                </div>
              );
            })}
          </div>
        </section>
      )}

      <section className="section">
        <div className="section-head">
          <h2>Recent activity</h2>
          <Link to="/activity" className="link-btn">See all <ChevronRight /></Link>
        </div>
        {data.expenses.length ? (
          <div className="list card">
            {data.expenses.map((e) => (
              <ExpenseRow key={e.id} expense={e} people={data.people} />
            ))}
          </div>
        ) : (
          <div className="card">
            <Empty icon={Receipt} title="Nothing yet">Your shared expenses will show up here.</Empty>
          </div>
        )}
      </section>
    </>
  );
}
