import { useCallback, useEffect, useRef } from "react";

interface Options {
  getIntervalMs: () => number | null;
  enabled?: boolean;
}

export function useLiveRefresh(
  callback: () => Promise<void>,
  { getIntervalMs, enabled = true }: Options
): { refreshNow: () => Promise<void> } {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  const schedule = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    const ms = getIntervalMs();
    if (ms === null || !enabled) return;
    timerRef.current = setTimeout(() => {
      void callbackRef.current().finally(schedule);
    }, ms);
  }, [getIntervalMs, enabled]);

  useEffect(() => {
    if (!enabled) return;
    schedule();
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [schedule, enabled]);

  const refreshNow = useCallback(async () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    await callbackRef.current();
    schedule();
  }, [schedule]);

  return { refreshNow };
}
