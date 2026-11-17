import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Plus, Users, X, AlertCircle } from 'lucide-react';
import { useApi } from '../lib/useApi.js';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { Avatar, AvatarStack, Empty, ErrorState, ListSkeleton, Modal, Segmented, TopBar, UserPicker, useToast } from '../components/ui.jsx';
import { GroupGlyph, GroupNet } from './Home.jsx';
import { formatCAD } from '../lib/format.js';
import { GROUP_KINDS } from '../lib/categories.js';

export function NewGroupModal({ open, onClose }) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const [name, setName] = useState('');
  const [kind, setKind] = useState('home');
  const [members, setMembers] = useState([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setName('');
      setKind('home');
      setMembers([]);
      setError('');
    }
  }, [open]);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const d = await api.post('/groups', { name, kind, members: members.map((m) => m.username) });
      toast(`Created ${d.group.name}`);
      onClose();
      navigate(`/groups/${d.group.id}`);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} labelledBy="new-group-title">
      <form onSubmit={submit} className="stack gap-16">
        <div>
          <h2 id="new-group-title">New group</h2>
          <p className="muted">For your flat, a trip, or anything you share regularly.</p>
        </div>
        <div className="field">
          <label className="field-label" htmlFor="group-name">Name</label>
          <input id="group-name" className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Apartment, Muskoka trip" autoFocus required />
        </div>
        <div className="field">
          <span className="field-label">Type</span>
          <Segmented value={kind} onChange={setKind} options={GROUP_KINDS} label="Group type" />
        </div>
        <div className="field">
          <span className="field-label">Members</span>
          <div className="chips wrap">
            <span className="chip person active">
              <Avatar user={user} size="xs" /> You
            </span>
            {members.map((m) => (
              <button type="button" key={m.id} className="chip person" onClick={() => setMembers((ms) => ms.filter((x) => x.id !== m.id))} aria-label={`Remove ${m.displayName}`}>
                <Avatar user={m} size="xs" /> {m.displayName} <X />
              </button>
            ))}
          </div>
          <UserPicker exclude={members.map((m) => m.id)} onPick={(u) => setMembers((ms) => [...ms, u])} placeholder="Add friends by username" />
        </div>
        {error && (
          <div className="callout" role="alert">
            <AlertCircle /> {error}
          </div>
        )}
        <button className="btn btn-primary btn-lg btn-block" disabled={busy || !name.trim()}>
          {busy ? <span className="spinner" /> : 'Create group'}
        </button>
      </form>
    </Modal>
  );
}

export default function Groups() {
  const { data, error, loading, reload } = useApi('/groups');
  const [params, setParams] = useSearchParams();
  const creating = params.get('new') === '1';
  const setCreating = (v) => setParams(v ? { new: '1' } : {}, { replace: true });

  return (
    <>
      <TopBar title={<span className="hide-desktop">Groups</span>}>
        <button className="btn btn-secondary btn-sm" onClick={() => setCreating(true)}>
          <Plus /> New group
        </button>
      </TopBar>
      <div className="page-head">
        <h1>Groups</h1>
        <p>Shared spaces for your flat, trips and more.</p>
      </div>

      {error && <ErrorState error={error} onRetry={reload} />}
      {loading && !data && <ListSkeleton rows={3} />}
      {data && !data.groups.length && (
        <div className="card">
          <Empty icon={Users} title="No groups yet" action={<button className="btn btn-primary" onClick={() => setCreating(true)}><Plus /> Create a group</button>}>
            Make one for your apartment, a trip or a dinner crew, and add friends by username.
          </Empty>
        </div>
      )}
      {data && data.groups.length > 0 && (
        <div className="list card">
          {data.groups.map((g) => (
            <Link key={g.id} to={`/groups/${g.id}`} className="item" style={{ minHeight: 76 }}>
              <GroupGlyph kind={g.kind} size="lg" />
              <span className="item-main">
                <span className="item-title" style={{ fontSize: 16 }}>{g.name}</span>
                <span className="item-sub row-flex gap-8">
                  <AvatarStack users={g.memberIds.map((id) => data.people[id]).filter(Boolean)} size="xs" />
                  {formatCAD(g.totalSpent)} spent
                </span>
              </span>
              <GroupNet cents={g.myNet} />
            </Link>
          ))}
        </div>
      )}
      <NewGroupModal open={creating} onClose={() => setCreating(false)} />
    </>
  );
}
