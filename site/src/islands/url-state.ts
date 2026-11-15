// Filter and sort state mirrored into the query string, so a filtered view
// can be shared. Read after hydration (the build has no URL), written with
// replaceState so filtering doesn't flood the history.
import { useEffect, useState } from "react";

export function useUrlState<T extends Record<string, string>>(defaults: T) {
  const [state, setState] = useState<T>(defaults);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const next = { ...defaults };
    for (const key of Object.keys(defaults)) {
      const v = params.get(key);
      if (v !== null) (next as Record<string, string>)[key] = v;
    }
    setState(next);
    setReady(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!ready) return;
    const params = new URLSearchParams(location.search);
    for (const [key, value] of Object.entries(state)) {
      if (value && value !== defaults[key]) params.set(key, value);
      else params.delete(key);
    }
    const qs = params.toString();
    history.replaceState(null, "", `${location.pathname}${qs ? `?${qs}` : ""}${location.hash}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, ready]);

  const set = (patch: Partial<T>) => setState((s) => ({ ...s, ...patch }));
  return [state, set] as const;
}
