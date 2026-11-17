import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Plus, ArrowLeftRight, ArrowRight, Receipt, Sparkles, ScanLine, Trash2, UserMinus, LogOut, Check as CheckIcon, Pencil } from 'lucide-react';
import { useApi } from '../lib/useApi.js';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import {
  Avatar, AvatarStack, ConfirmModal, Empty, ErrorState, ListSkeleton, Segmented, Skeleton, Switch, TopBar, UserPicker, useToast,
} from '../components/ui.jsx';
import { ExpenseList } from '../components/ExpenseRow.jsx';
import { GroupGlyph } from './Home.jsx';
import { formatCAD, nameOf, cls } from '../lib/format.js';
import { GROUP_KINDS } from '../lib/categories.js';

export function TransferRow({ t, people, me, settleHref }) {
  const involved = t.from === me || t.to === me;
  return (
    <div className="transfer">
      <Avatar user={people[t.from]} size="sm" />
      <span className="arrow"><ArrowRight /></span>
      <Avatar user={people[t.to]} size="sm" />
      <span className="txt">
        <span className="truncate" style={{ display: 'block' }}>
          <strong>{nameOf(people, t.from, me)}</strong> {t.from === me ? 'pay' : 'pays'}{' '}
          <strong>{nameOf(people, t.to, me, { you: 'you' })}</strong>
        </span>
        <span className={cls('amt num', t.from === me && 'neg', t.to === me && 'pos')}>{formatCAD(t.amount)}</span>
      </span>
      {involved && settleHref && (
        <Link to={settleHref(t)} className="btn btn-secondary btn-sm">
          Settle
        </Link>
      )}
    </div>
  );
}

export default function GroupDetail() {
  const { id } = useParams();
  const { user } = useAuth();
  const me = user.id;
  const navigate = useNavigate();
  const toast = useToast();
  const [tab, setTab] = useState('expenses');
  const g = useApi(`/groups/${id}`);
  const ex = useApi(`/expenses?groupId=${id}&limit=200`);

  if (g.error) return (<><TopBar back="/groups" /><ErrorState error={g.error} onRetry={g.reload} /></>);
  if (!g.data) {
    return (
      <>
        <TopBar back="/groups" />
        <div className="stack gap-12">
          <Skeleton h={180} r={28} />
          <ListSkeleton rows={4} />
        </div>
      </>
    );
  }

  const { group, summary, people } = g.data;
  const members = group.memberIds.map((mid) => people[mid]).filter(Boolean);
  const myNet = summary.myNet;
  const reloadAll = () => {
    g.reload(true);
    ex.reload(true);
  };

  const toggleSimplify = async (v) => {
    try {
      await api.patch(`/groups/${group.id}`, { simplify: v });
      toast(v ? 'Debts simplified' : 'Showing direct debts');
      g.reload(true);
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  return (
    <>
      <TopBar back="/groups" title={<span className="hide-desktop">{group.name}</span>}>
        <Link to={`/settle?groupId=${group.id}`} className="icon-btn" aria-label="Settle up">
          <ArrowLeftRight />
        </Link>
      </TopBar>

      <section className="hero" style={{ '--hero-tone': myNet < 0 ? 'var(--coral)' : 'var(--lime)' }}>
        <div className="row-flex gap-12">
          <GroupGlyph kind={group.kind} size="lg" />
          <div style={{ minWidth: 0 }}>
            <h1 style={{ fontSize: 26 }} className="truncate">{group.name}</h1>
            <div className="row-flex gap-8 muted" style={{ fontSize: 13, marginTop: 4 }}>
              <AvatarStack users={members} size="xs" max={5} />
              {members.length} members
            </div>
          </div>
        </div>
        <div style={{ marginTop: 22 }}>
          <span className="eyebrow">{!myNet ? 'You’re settled up' : myNet > 0 ? 'You are owed' : 'You owe'}</span>
          <div className={cls('display num', myNet > 0 && 'pos', myNet < 0 && 'neg')} style={{ fontSize: 40, fontWeight: 650, marginTop: 4, lineHeight: 1 }}>
            {formatCAD(myNet)}
          </div>
        </div>
        <div className="quick-actions" style={{ marginTop: 18 }}>
          <Link to={`/expenses/new?groupId=${group.id}`} className="btn btn-primary">
            <Plus /> Add expense
          </Link>
          <Link to={`/settle?groupId=${group.id}`} className="btn btn-secondary">
            <ArrowLeftRight /> Settle up
          </Link>
          <Link to={`/expenses/new?scan=1&groupId=${group.id}`} className="btn btn-secondary" style={{ gridColumn: '1 / -1' }}>
            <ScanLine /> Scan a bill
          </Link>
        </div>
      </section>

      <div className="tabs" role="tablist">
        {[
          ['expenses', 'Expenses'],
          ['balances', 'Balances'],
          ['settings', 'Members & settings'],
        ].map(([k, label]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>
            {label}
          </button>
        ))}
      </div>

      {tab === 'expenses' && (
        <>
          <div className="stat-grid" style={{ marginBottom: 6 }}>
            <div className="stat">
              <span className="eyebrow">Group spend</span>
              <strong className="num">{formatCAD(summary.totalSpent)}</strong>
            </div>
            <div className="stat">
              <span className="eyebrow">Your share</span>
              <strong className="num">{formatCAD(summary.mySpend)}</strong>
            </div>
          </div>
          {ex.loading && !ex.data && <ListSkeleton />}
          {ex.data && !ex.data.expenses.length && (
            <Empty icon={Receipt} title="No expenses yet" action={<Link to={`/expenses/new?groupId=${group.id}`} className="btn btn-primary btn-sm"><Plus /> Add the first one</Link>}>
              Dinners, rent, groceries — add them here and Settlr keeps score.
            </Empty>
          )}
          {ex.data && ex.data.expenses.length > 0 && <ExpenseList expenses={ex.data.expenses} people={{ ...ex.data.people, ...people }} showGroup={false} />}
        </>
      )}

      {tab === 'balances' && <Balances group={group} summary={summary} people={people} me={me} onToggle={toggleSimplify} />}

      {tab === 'settings' && (
        <GroupSettings
          group={group}
          summary={summary}
          people={people}
          me={me}
          onChange={reloadAll}
          onDeleted={() => navigate('/groups', { replace: true })}
        />
      )}
    </>
  );
}

function Balances({ group, summary, people, me, onToggle }) {
  const max = Math.max(1, ...summary.members.map((m) => Math.abs(m.net)));
  const settleHref = (t) => `/settle?groupId=${group.id}&from=${t.from}&to=${t.to}&amount=${t.amount}`;
  return (
    <div className="stack gap-16">
      <div className="card card-pad">
        <div className="row-flex gap-12">
          <span className="glyph sm tone-lime"><Sparkles /></span>
          <div style={{ flex: 1 }}>
            <strong>Simplify debts</strong>
            <p className="muted" style={{ fontSize: 13 }}>
              Combine balances so everyone settles with the fewest payments.
            </p>
          </div>
          <Switch checked={group.simplify} onChange={onToggle} label="Simplify debts" />
        </div>
      </div>

      <div>
        <div className="section-head">
          <h2>{group.simplify ? 'Suggested payments' : 'Who owes whom'}</h2>
          <span className="muted" style={{ fontSize: 13 }}>
            {summary.settlements.length} {summary.settlements.length === 1 ? 'payment' : 'payments'}
          </span>
        </div>
        {summary.settlements.length ? (
          summary.settlements.map((t, i) => <TransferRow key={i} t={t} people={people} me={me} settleHref={settleHref} />)
        ) : (
          <div className="callout ok"><CheckIcon /> Everyone in {group.name} is settled up.</div>
        )}
      </div>

      <div>
        <div className="section-head"><h2>Member balances</h2></div>
        <div className="card card-pad net-bars">
          {summary.members.map((m) => (
            <div key={m.userId}>
              <div className="row-flex" style={{ marginBottom: 8 }}>
                <Avatar user={people[m.userId]} size="sm" />
                <span style={{ flex: 1, fontWeight: 550 }} className="truncate">
                  {m.userId === me ? 'You' : people[m.userId]?.displayName}
                  {!m.active && <span className="muted"> (left)</span>}
                </span>
                <span className={cls('num', m.net > 0 && 'pos', m.net < 0 && 'neg')} style={{ fontWeight: 650 }}>
                  {m.net === 0 ? 'settled' : `${m.net > 0 ? 'gets back' : 'owes'} ${formatCAD(m.net)}`}
                </span>
              </div>
              <div className="net-bar" aria-hidden="true">
                <div className="l"><span style={{ width: `${m.net < 0 ? (-m.net / max) * 100 : 0}%` }} /></div>
                <div className="r"><span style={{ width: `${m.net > 0 ? (m.net / max) * 100 : 0}%` }} /></div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function GroupSettings({ group, summary, people, me, onChange, onDeleted }) {
  const toast = useToast();
  const [name, setName] = useState(group.name);
  const [kind, setKind] = useState(group.kind);
  const [confirm, setConfirm] = useState(null);
  const [busy, setBusy] = useState(false);
  const netOf = (uid) => summary.members.find((m) => m.userId === uid)?.net || 0;

  const save = async () => {
    try {
      await api.patch(`/groups/${group.id}`, { name, kind });
      toast('Group updated');
      onChange();
    } catch (err) {
      toast(err.message, 'error');
    }
  };
  const addMember = async (u) => {
    try {
      await api.post(`/groups/${group.id}/members`, { username: u.username });
      toast(`Added ${u.displayName}`);
      onChange();
    } catch (err) {
      toast(err.message, 'error');
    }
  };
  const runConfirm = async () => {
    setBusy(true);
    try {
      if (confirm.type === 'remove') {
        await api.del(`/groups/${group.id}/members/${confirm.userId}`);
        if (confirm.userId === me) return onDeleted();
        toast('Member removed');
        onChange();
      } else if (confirm.type === 'delete') {
        await api.del(`/groups/${group.id}`);
        toast('Group deleted');
        return onDeleted();
      }
      setConfirm(null);
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack gap-16">
      <div className="card card-pad stack gap-12">
        <div className="section-head" style={{ margin: 0 }}><h2>Members</h2></div>
        <div className="list">
          {group.memberIds.map((uid) => {
            const u = people[uid];
            const net = netOf(uid);
            return (
              <div key={uid} className="item" style={{ padding: '8px 0' }}>
                <Avatar user={u} />
                <span className="item-main">
                  <span className="item-title">{uid === me ? `${u.displayName} (you)` : u.displayName}</span>
                  <span className="item-sub">@{u.username}</span>
                </span>
                <button
                  className="icon-btn"
                  aria-label={uid === me ? 'Leave group' : `Remove ${u.displayName}`}
                  title={net ? 'Settle their balance first' : undefined}
                  disabled={!!net}
                  style={{ opacity: net ? 0.3 : 1 }}
                  onClick={() => setConfirm({ type: 'remove', userId: uid, name: u.displayName })}
                >
                  {uid === me ? <LogOut /> : <UserMinus />}
                </button>
              </div>
            );
          })}
        </div>
        <UserPicker exclude={group.memberIds} onPick={addMember} placeholder="Add a member by username" />
        <p className="field-hint">People can only be removed once their balance in this group is settled.</p>
      </div>

      <div className="card card-pad stack gap-12">
        <div className="section-head" style={{ margin: 0 }}><h2>Details</h2></div>
        <div className="field">
          <label className="field-label" htmlFor="gname">Group name</label>
          <input id="gname" className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <Segmented value={kind} onChange={setKind} options={GROUP_KINDS} label="Group type" />
        <button className="btn btn-secondary" onClick={save} disabled={!name.trim() || (name === group.name && kind === group.kind)}>
          <Pencil /> Save changes
        </button>
      </div>

      <button className="btn btn-danger btn-block" onClick={() => setConfirm({ type: 'delete' })}>
        <Trash2 /> Delete group
      </button>

      <ConfirmModal
        open={!!confirm}
        busy={busy}
        danger
        title={confirm?.type === 'delete' ? `Delete ${group.name}?` : confirm?.userId === me ? `Leave ${group.name}?` : `Remove ${confirm?.name}?`}
        body={
          confirm?.type === 'delete'
            ? 'All of this group’s expenses will be permanently deleted. This only works once everyone is settled up.'
            : 'Past expenses stay in the history.'
        }
        confirmLabel={confirm?.type === 'delete' ? 'Delete group' : confirm?.userId === me ? 'Leave group' : 'Remove'}
        onConfirm={runConfirm}
        onClose={() => setConfirm(null)}
      />
    </div>
  );
}
