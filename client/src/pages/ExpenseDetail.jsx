import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Pencil, Trash2, Users, CalendarDays, StickyNote, ArrowRight } from 'lucide-react';
import { useApi } from '../lib/useApi.js';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { Avatar, CategoryGlyph, ConfirmModal, ErrorState, Skeleton, TopBar, useToast } from '../components/ui.jsx';
import { formatCAD, formatDate, myNet, nameOf, cls } from '../lib/format.js';
import { categoryOf, paymentMethodLabel } from '../lib/categories.js';

const METHOD_LABEL = { equal: 'Split equally', exact: 'Split by exact amounts', percent: 'Split by percentage', shares: 'Split by shares', itemized: 'Split by item' };

function taxLabel(e) {
  if (e.taxMode === 'percent') return `Tax (${+Number(e.taxValue).toFixed(3)}%)`;
  if (e.taxMode === 'amount') return 'Tax';
  return null;
}

export default function ExpenseDetail() {
  const { id } = useParams();
  const { user } = useAuth();
  const me = user.id;
  const navigate = useNavigate();
  const toast = useToast();
  const { data, error, reload } = useApi(`/expenses/${id}`);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);

  if (error) return (<><TopBar back="/activity" /><ErrorState error={error} onRetry={reload} /></>);
  if (!data) return (<><TopBar back="/activity" /><Skeleton h={420} r={22} /></>);

  const e = data.expense;
  const people = data.people;
  const isPayment = e.type === 'payment';
  const net = myNet(e, me);
  const cat = categoryOf(isPayment ? 'payment' : e.category);
  const name = (uid) => (uid === me ? 'You' : people[uid]?.displayName || 'Someone');
  const owedBy = (uid) => e.splits.find((s) => s.userId === uid);

  const remove = async () => {
    setBusy(true);
    try {
      await api.del(`/expenses/${e.id}`);
      toast(isPayment ? 'Payment deleted' : 'Expense deleted');
      navigate(-1);
    } catch (err) {
      toast(err.message, 'error');
      setBusy(false);
    }
  };

  const items = e.splitMethod === 'itemized' ? e.splitMeta?.items || [] : [];

  return (
    <>
      <TopBar back="/activity" title={<span className="hide-desktop">{isPayment ? 'Payment' : 'Expense'}</span>}>
        <Link to={`/expenses/${e.id}/edit`} className="icon-btn" aria-label="Edit">
          <Pencil />
        </Link>
        <button className="icon-btn" aria-label="Delete" onClick={() => setConfirm(true)}>
          <Trash2 />
        </button>
      </TopBar>

      <article>
        <div className="receipt">
          <div className="row-flex gap-12">
            <CategoryGlyph category={isPayment ? 'payment' : e.category} size="lg" />
            <div style={{ minWidth: 0, flex: 1 }}>
              <span className="eyebrow">{isPayment ? paymentMethodLabel(e.method) : cat.label}</span>
              <h1 style={{ fontSize: 24, marginTop: 4 }}>{e.description}</h1>
            </div>
          </div>
          <div className="display num" style={{ fontSize: 48, fontWeight: 650, marginTop: 22, lineHeight: 1 }}>
            {formatCAD(e.total)}
          </div>
          <div className="row-flex gap-16 muted" style={{ fontSize: 13.5, marginTop: 12, flexWrap: 'wrap' }}>
            <span className="row-flex gap-4"><CalendarDays size={15} /> {formatDate(e.date, { weekday: 'short', month: 'short', day: 'numeric' })}</span>
            <span className="row-flex gap-4">
              <Users size={15} />
              {e.groupId ? <Link to={`/groups/${e.groupId}`} className="link-btn" style={{ fontWeight: 500 }}>{e.groupName}</Link> : 'Non-group'}
            </span>
          </div>
          {!isPayment && net !== 0 && (
            <div className={cls('pill', net > 0 ? 'pos' : 'neg')} style={{ marginTop: 14 }}>
              {net > 0 ? `You lent ${formatCAD(net)}` : `You borrowed ${formatCAD(net)}`}
            </div>
          )}

          <hr className="receipt-rule" />

          {isPayment ? (
            <div className="row-flex gap-12" style={{ justifyContent: 'center', padding: '8px 0' }}>
              <div className="stack" style={{ alignItems: 'center', gap: 6 }}>
                <Avatar user={people[e.payers[0].userId]} size="lg" />
                <strong>{name(e.payers[0].userId)}</strong>
                <span className="eyebrow">paid</span>
              </div>
              <ArrowRight size={22} className="faint" />
              <div className="stack" style={{ alignItems: 'center', gap: 6 }}>
                <Avatar user={people[e.splits[0].userId]} size="lg" />
                <strong>{name(e.splits[0].userId)}</strong>
                <span className="eyebrow">received</span>
              </div>
            </div>
          ) : (
            <>
              <span className="eyebrow">Paid by</span>
              <div style={{ marginTop: 6 }}>
                {e.payers.map((p) => (
                  <div key={p.userId} className="share-row">
                    <Avatar user={people[p.userId]} size="sm" />
                    <div className="who"><strong>{name(p.userId)}</strong></div>
                    <div className="amt">{formatCAD(p.amount)}</div>
                  </div>
                ))}
              </div>

              <hr className="receipt-rule" />
              <div className="row-flex" style={{ justifyContent: 'space-between' }}>
                <span className="eyebrow">{METHOD_LABEL[e.splitMethod] || 'Split'}</span>
                <span className="eyebrow">{e.splits.length} people</span>
              </div>
              <div style={{ marginTop: 6 }}>
                {e.splits.map((s) => {
                  const pct = e.splitMethod === 'percent' ? e.splitMeta?.values?.[s.userId] : null;
                  const shares = e.splitMethod === 'shares' ? e.splitMeta?.values?.[s.userId] : null;
                  return (
                    <div key={s.userId} className="share-row">
                      <Avatar user={people[s.userId]} size="sm" />
                      <div className="who">
                        <strong>{name(s.userId)} {s.userId === me ? 'owe' : 'owes'}</strong>
                        <span>
                          {[
                            pct != null && `${pct}%`,
                            shares != null && `${shares} ${Number(shares) === 1 ? 'share' : 'shares'}`,
                            s.tax || s.tip || s.discount
                              ? [formatCAD(s.base), s.tax && `+ ${formatCAD(s.tax)} tax`, s.tip && `+ ${formatCAD(s.tip)} tip`, s.discount && `− ${formatCAD(s.discount)} off`].filter(Boolean).join(' ')
                              : null,
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                        </span>
                      </div>
                      <div className="amt">{formatCAD(s.amount)}</div>
                    </div>
                  );
                })}
              </div>

              {items.length > 0 && (
                <>
                  <hr className="receipt-rule" />
                  <span className="eyebrow">Items</span>
                  <div style={{ marginTop: 6 }}>
                    {items.map((it, i) => (
                      <div key={i} className="receipt-line">
                        <span className="k">
                          {it.name || `Item ${i + 1}`}
                          <span className="muted" style={{ fontSize: 12.5, display: 'block' }}>
                            {it.userIds.length === e.splits.length && it.userIds.length > 2 ? 'Everyone' : it.userIds.map((u) => nameOf(people, u, me)).join(', ')}
                            {e.taxMode !== 'included' && !it.taxable ? ' · no tax' : ''}
                          </span>
                        </span>
                        <span className="v">{formatCAD(it.amount)}</span>
                      </div>
                    ))}
                  </div>
                </>
              )}

              <div style={{ marginTop: 10 }}>
                {(e.tax > 0 || e.tip > 0 || e.discount > 0) && (
                  <div className="receipt-line"><span className="k">Subtotal</span><span className="v">{formatCAD(e.subtotal)}</span></div>
                )}
                {e.tax > 0 && <div className="receipt-line"><span className="k">{taxLabel(e)}</span><span className="v">{formatCAD(e.tax)}</span></div>}
                {e.tip > 0 && <div className="receipt-line"><span className="k">Tip</span><span className="v">{formatCAD(e.tip)}</span></div>}
                {e.discount > 0 && (
                  <div className="receipt-line"><span className="k">Discount{e.discountSplit === 'equal' ? ' (split equally)' : ''}</span><span className="v pos">−{formatCAD(e.discount)}</span></div>
                )}
                {(e.tax > 0 || e.tip > 0) && e.extrasSplit === 'equal' && (
                  <div className="receipt-line"><span className="k muted">{[e.tax > 0 && 'tax', e.tip > 0 && 'tip'].filter(Boolean).join(' & ').replace(/^./, (c) => c.toUpperCase())} split equally</span><span className="v" /></div>
                )}
                {e.taxMode === 'included' && <div className="receipt-line"><span className="k muted">Tax included in amount</span><span className="v" /></div>}
                <div className="receipt-line total"><span className="k">Total</span><span className="v">{formatCAD(e.total)}</span></div>
              </div>
            </>
          )}

          {e.notes && (
            <>
              <hr className="receipt-rule" />
              <div className="row-flex gap-8" style={{ alignItems: 'flex-start' }}>
                <StickyNote size={16} className="muted" style={{ marginTop: 2, flexShrink: 0 }} />
                <p style={{ whiteSpace: 'pre-wrap', fontSize: 14.5 }}>{e.notes}</p>
              </div>
            </>
          )}
        </div>
        <div className="receipt-tear" aria-hidden="true" />
        <p className="faint" style={{ fontSize: 12.5, textAlign: 'center', marginTop: 14 }}>
          Added by {name(e.createdBy)} · {formatDate(e.createdAt.slice(0, 10))}
          {e.updatedBy && ` · edited by ${name(e.updatedBy)}`}
        </p>
      </article>

      <div className="quick-actions" style={{ marginTop: 20 }}>
        <Link to={`/expenses/${e.id}/edit`} className="btn btn-secondary"><Pencil /> Edit</Link>
        <button className="btn btn-danger" onClick={() => setConfirm(true)}><Trash2 /> Delete</button>
      </div>

      <ConfirmModal
        open={confirm}
        busy={busy}
        danger
        title={`Delete this ${isPayment ? 'payment' : 'expense'}?`}
        body="Balances for everyone involved will be recalculated. This can’t be undone."
        confirmLabel="Delete"
        onConfirm={remove}
        onClose={() => setConfirm(false)}
      />
    </>
  );
}
