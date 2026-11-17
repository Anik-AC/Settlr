import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api.js';

/** Fetch `path` on mount / when it changes. Pass null to skip. */
export function useApi(path) {
  const [state, setState] = useState({ data: null, error: null, loading: !!path });
  const seq = useRef(0);

  const load = useCallback(
    async (silent = false) => {
      if (!path) return;
      const id = ++seq.current;
      if (!silent) setState((s) => ({ ...s, loading: true, error: null }));
      try {
        const data = await api.get(path);
        if (id === seq.current) setState({ data, error: null, loading: false });
      } catch (error) {
        if (id === seq.current) setState((s) => ({ ...s, error, loading: false }));
      }
    },
    [path]
  );

  useEffect(() => {
    load();
  }, [load]);

  // Refresh when the tab regains focus (a friend may have added something).
  useEffect(() => {
    const onFocus = () => document.visibilityState === 'visible' && load(true);
    document.addEventListener('visibilitychange', onFocus);
    return () => document.removeEventListener('visibilitychange', onFocus);
  }, [load]);

  return { ...state, reload: load };
}
