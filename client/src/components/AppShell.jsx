import { useEffect, useState } from 'react';
import { NavLink, Outlet, Link, useLocation } from 'react-router-dom';
import { api } from '../lib/api.js';
import { House, Users, UserRound, Activity, Plus, Settings, ArrowLeftRight } from 'lucide-react';
import { useAuth } from '../lib/auth.jsx';
import { Avatar } from './ui.jsx';

export function BrandMark({ size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 512 512" aria-hidden="true">
      <g fill="none" stroke="var(--lime)" strokeWidth="44" strokeLinecap="round">
        <path d="M150 140v232" />
        <path d="M226 140v232" />
        <path d="M302 140v232" />
        <path d="M378 140v232" stroke="var(--coral)" />
        <path d="M110 336L418 176" stroke="var(--text)" />
      </g>
    </svg>
  );
}

export function Brand() {
  return (
    <span className="brand">
      <span className="brand-mark">
        <BrandMark />
      </span>
      Settlr
    </span>
  );
}

const NAV = [
  { to: '/', label: 'Home', icon: House, end: true },
  { to: '/groups', label: 'Groups', icon: Users },
  { to: '/people', label: 'People', icon: UserRound },
  { to: '/activity', label: 'Activity', icon: Activity },
];

/** Bills to review + others' activity since you last looked (refreshed on navigation). */
function useActivityBadge() {
  const { pathname } = useLocation();
  const [count, setCount] = useState(0);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const bump = () => setTick((t) => t + 1);
    window.addEventListener('settlr:badges', bump);
    return () => window.removeEventListener('settlr:badges', bump);
  }, []);
  useEffect(() => {
    let alive = true;
    api.get('/badges').then((d) => alive && setCount(d.review + d.activity)).catch(() => {});
    return () => {
      alive = false;
    };
  }, [pathname, tick]);
  return count;
}

export default function AppShell() {
  const { user } = useAuth();
  const pending = useActivityBadge();
  const badge = (to) => (to === '/activity' && pending > 0 ? <span className="nav-badge" aria-label={`${pending} new in Activity`}>{pending}</span> : null);
  return (
    <div className="shell">
      <aside className="sidebar" aria-label="Main navigation">
        <Link to="/" className="brand" aria-label="Settlr home">
          <Brand />
        </Link>
        <Link to="/expenses/new" className="btn btn-primary btn-block side-cta">
          <Plus /> Add expense
        </Link>
        {NAV.map(({ to, label, icon: Icon, end }) => (
          <NavLink key={to} to={to} end={end} className={({ isActive }) => 'side-link' + (isActive ? ' active' : '')}>
            <Icon /> {label}
            {badge(to)}
          </NavLink>
        ))}
        <NavLink to="/settle" className={({ isActive }) => 'side-link' + (isActive ? ' active' : '')}>
          <ArrowLeftRight /> Settle up
        </NavLink>
        <div className="side-foot">
          <NavLink to="/account" className={({ isActive }) => 'side-link' + (isActive ? ' active' : '')}>
            <Avatar user={user} size="xs" />
            <span className="truncate" style={{ flex: 1 }}>{user.displayName}</span>
            <Settings />
          </NavLink>
        </div>
      </aside>

      <main className="main" id="main">
        <Outlet />
      </main>

      <nav className="bottom-nav" aria-label="Main navigation">
        {NAV.slice(0, 2).map(({ to, label, icon: Icon, end }) => (
          <NavLink key={to} to={to} end={end} className={({ isActive }) => 'nav-item' + (isActive ? ' active' : '')}>
            <Icon />
            <span>{label}</span>
          </NavLink>
        ))}
        <Link to="/expenses/new" className="nav-fab" aria-label="Add expense">
          <Plus />
        </Link>
        {NAV.slice(2).map(({ to, label, icon: Icon }) => (
          <NavLink key={to} to={to} className={({ isActive }) => 'nav-item' + (isActive ? ' active' : '')}>
            <span style={{ position: 'relative', display: 'inline-flex' }}>
              <Icon />
              {badge(to)}
            </span>
            <span>{label}</span>
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
