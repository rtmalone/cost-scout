import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import type { UiStatus } from '../../src/ui/events.ts';
import { initialState, reduce, type RunState } from './lib/runState.ts';
import { readNdjson } from './lib/stream.ts';

const TICK_MS = 250;

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** One agent run at a time: starts it, streams its events into state, and stops it. */
export function useRun(): {
  state: RunState;
  status: UiStatus | null;
  start(question: string): void;
  stop(): void;
  nowMs: number;
} {
  const [state, dispatch] = useReducer(reduce, initialState);
  const [status, setStatus] = useState<UiStatus | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const abortRef = useRef<AbortController | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  const refreshStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/status');
      if (res.ok) setStatus((await res.json()) as UiStatus);
    } catch {
      // The server is gone; keep the last status we had.
    }
  }, []);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  useEffect(() => {
    if (state.phase !== 'running') return;
    setNowMs(Date.now());
    const id = setInterval(() => setNowMs(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, [state.phase]);

  // Leaving the page aborts the fetch, which tells the server to stop spending tokens.
  useEffect(() => () => abortRef.current?.abort(), []);

  const start = useCallback(
    (question: string) => {
      if (abortRef.current) return;
      const controller = new AbortController();
      abortRef.current = controller;
      dispatch({ type: 'client_started', question });
      void (async () => {
        try {
          const res = await fetch('/api/run', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ question }),
            signal: controller.signal,
          });
          if (!res.ok || !res.body) {
            const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
            const error = typeof body?.error === 'string' && body.error ? body.error : `HTTP ${res.status}`;
            dispatch({ type: 'client_error', error });
            return;
          }
          let ended = false;
          await readNdjson(res.body, (e) => {
            if (e.type === 'run_finished' || e.type === 'run_failed') ended = true;
            dispatch(e);
          });
          // The stream ended without saying how the run finished: the server went away.
          if (!ended) {
            dispatch({ type: 'client_error', error: 'The connection to the server closed mid-run.' });
          }
        } catch (err) {
          // Stopping is reported by stop() itself; anything else is a real failure.
          if (!controller.signal.aborted) dispatch({ type: 'client_error', error: message(err) });
        } finally {
          if (abortRef.current === controller) abortRef.current = null;
          void refreshStatus();
        }
      })();
    },
    [refreshStatus],
  );

  const stop = useCallback(() => {
    const controller = abortRef.current;
    if (!controller) return;
    abortRef.current = null;
    controller.abort();
    // Closing the request is how the server learns to stop, so its own run_finished
    // never reaches us. Finish the run here with what we know; token usage is unknown.
    const s = stateRef.current;
    dispatch({
      type: 'run_finished',
      stopReason: 'aborted',
      summary: '',
      turns: s.turns.length,
      toolCalls: s.turns.reduce((n, t) => n + t.calls.length, 0),
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });
  }, []);

  return { state, status, start, stop, nowMs };
}
