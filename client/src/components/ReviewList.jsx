import { Link } from 'react-router-dom';
import { Bot, ChevronRight, AlertCircle } from 'lucide-react';
import { Empty } from './ui.jsx';
import { formatCAD, relativeDate } from '../lib/format.js';

/** Bills an AI assistant read, waiting for the user to assign items and save. */
export default function ReviewList({ drafts }) {
  if (!drafts.length) {
    return (
      <Empty icon={Bot} title="Nothing to review">
        Share a bill photo with your AI assistant and ask it to add the bill to Settlr. It shows up here for you to check.
      </Empty>
    );
  }
  return (
    <div className="list card">
      {drafts.map((d) => (
        <Link key={d.id} to={`/expenses/new?draft=${d.id}`} className="item">
          <span className="glyph tone-lime" style={{ '--tone-mix': '22%' }}><Bot size={20} /></span>
          <span className="item-main" style={{ minWidth: 0, flex: 1 }}>
            <span className="item-title truncate" style={{ display: 'block', fontWeight: 600 }}>{d.description}</span>
            <span className="item-sub">
              {relativeDate(d.date)} · {d.items.length} item{d.items.length === 1 ? '' : 's'}
              {d.groupName ? ` · ${d.groupName}` : ''}
              {d.warnings.length > 0 && <> · <AlertCircle size={12} style={{ verticalAlign: -1 }} /> check totals</>}
            </span>
          </span>
          <span className="item-end num" style={{ fontWeight: 600 }}>{formatCAD(d.total)}</span>
          <ChevronRight size={18} className="faint" />
        </Link>
      ))}
    </div>
  );
}
