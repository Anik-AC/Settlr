import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { RefreshCw } from 'lucide-react';

/* global __APP_VERSION__ */
const VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'local';
const CHECK_EVERY_MS = 5 * 60 * 1000;

/** Reload at most once per newer version, so a stale cache can never cause a reload loop. */
function reloadOnce(commit) {
  try {
    if (sessionStorage.getItem('settlr-reloaded-for') === commit) return false;
    sessionStorage.setItem('settlr-reloaded-for', commit);
  } catch {
    /* storage blocked: still fine to reload once per page load */
  }
  window.location.reload();
  return true;
}

/** Pages where reloading could throw away something the person is typing. */
const isForm = (path) => /^\/expenses\/(new|\d+\/edit)/.test(path) || path.startsWith('/settle');

/**
 * Keeps phones on the latest deploy. A tab or home-screen app can stay open for
 * days and keep running old code; when a newer version is live, reload on normal
 * pages, and on forms show a "tap to refresh" bar instead of losing input.
 */
export default function UpdateWatcher() {
  const { pathname } = useLocation();
  const [outdated, setOutdated] = useState(null); // newer commit, when one is live
  const pathRef = useRef(pathname);
  pathRef.current = pathname;

  useEffect(() => {
    if (VERSION === 'local') return undefined; // dev builds: nothing to compare
    let stopped = false;
    const check = async () => {
      try {
        const res = await fetch('/api/health', { cache: 'no-store' });
        const { commit } = await res.json();
        if (stopped || !commit || commit === 'local' || commit === VERSION) return;
        if (isForm(pathRef.current) || !reloadOnce(commit)) setOutdated(commit);
      } catch {
        /* offline: try again later */
      }
    };
    const onVisible = () => document.visibilityState === 'visible' && check();
    check();
    const timer = setInterval(check, CHECK_EVERY_MS);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      stopped = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  // Leaving a form while outdated: safe to reload now.
  useEffect(() => {
    if (outdated && !isForm(pathname)) reloadOnce(outdated);
  }, [outdated, pathname]);

  if (!outdated) return null;
  return (
    <button type="button" className="update-bar" onClick={() => window.location.reload()}>
      <RefreshCw size={16} /> New version of Settlr — tap to refresh
    </button>
  );
}
