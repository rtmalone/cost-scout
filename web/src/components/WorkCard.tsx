import type { UiStatus } from '../../../src/ui/events.ts';
import { statusText, type RunState } from '../lib/runState.ts';
import { TimingChart } from './TimingChart.tsx';

function clock(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/** Milliseconds the run has taken: up to now while it runs, up to the last turn's end once it's over. */
function elapsed(state: RunState, nowMs: number): number {
  if (state.startedAtMs === 0) return 0;
  if (state.phase === 'running') return Math.max(0, nowMs - state.startedAtMs);
  return state.turns.reduce((max, t) => Math.max(max, t.startMs + (t.durationMs ?? 0)), 0);
}

export function WorkCard({ state, status, nowMs }: { state: RunState; status: UiStatus | null; nowMs: number }) {
  const running = state.phase === 'running';
  const elapsedMs = elapsed(state, nowMs);
  const queries = state.turns.reduce((n, t) => n + t.calls.filter((c) => c.kind === 'query').length, 0);

  return (
    <section className="card work">
      <div className="work-status">
        <span className={running ? 'now live' : 'now'}>{statusText(state, status)}</span>
        {state.phase !== 'idle' && (
          <span className="clock">
            {clock(elapsedMs)} · turn {state.turns.length} · {queries} {queries === 1 ? 'query' : 'queries'}
          </span>
        )}
      </div>
      {state.phase === 'idle' ? (
        <p className="empty">Each model turn shows up here as a bar on a timeline, with the queries it ran.</p>
      ) : (
        <TimingChart turns={state.turns} elapsedMs={elapsedMs} />
      )}
    </section>
  );
}
