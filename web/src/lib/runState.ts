import type { StopReason, Usage } from '../../../src/agent/run.ts';
import type { Finding } from '../../../src/findings.ts';
import type { RunEvent, UiStatus } from '../../../src/ui/events.ts';
import { callLabel, type CallKind } from './labels.ts';

export interface CallView {
  id: string;
  kind: CallKind;
  label: string;
  result: string;
  sql?: string;
  durationMs: number;
}

export interface TurnView {
  turn: number;
  /** Milliseconds after the run started. */
  startMs: number;
  /** Unset while the model request is in flight. */
  durationMs?: number;
  text: string;
  calls: CallView[];
}

export interface RunState {
  phase: 'idle' | 'running' | 'finished';
  question: string;
  startedAtMs: number;
  monthlySpendUsd: number;
  turns: TurnView[];
  findings: Finding[];
  savingsUsd: number;
  end?: {
    stopReason: StopReason;
    stopDetail?: string;
    summary: string;
    turns: number;
    toolCalls: number;
    usage: Usage;
  };
  error?: string;
}

/** Events the page raises itself, around the server's stream. */
export type ClientEvent =
  | { type: 'client_started'; question: string }
  | { type: 'client_error'; error: string };

export const initialState: RunState = {
  phase: 'idle',
  question: '',
  startedAtMs: 0,
  monthlySpendUsd: 0,
  turns: [],
  findings: [],
  savingsUsd: 0,
};

/** Give turns that never got a reply (the run stopped mid-request) a duration up to now. */
function closeOpenTurns(state: RunState): TurnView[] {
  const now = Date.now();
  return state.turns.map((t) =>
    t.durationMs === undefined
      ? { ...t, durationMs: Math.max(0, now - (state.startedAtMs + t.startMs)) }
      : t,
  );
}

function mapTurn(turns: TurnView[], turn: number, f: (t: TurnView) => TurnView): TurnView[] {
  return turns.map((t) => (t.turn === turn ? f(t) : t));
}

/**
 * Pure: never mutates `state`. Assumes the server's order, so a turn's events
 * arrive after its turn_started; events for an unknown turn are dropped.
 */
export function reduce(state: RunState, e: RunEvent | ClientEvent): RunState {
  switch (e.type) {
    case 'client_started':
      return { ...initialState, phase: 'running', question: e.question };
    case 'client_error':
      return { ...state, phase: 'finished', turns: closeOpenTurns(state), error: e.error };
    case 'run_started':
      return {
        ...state,
        phase: 'running',
        startedAtMs: Date.parse(e.startedAt),
        monthlySpendUsd: e.monthlySpendUsd,
      };
    case 'turn_started':
      return {
        ...state,
        turns: [
          ...state.turns,
          { turn: e.turn, startMs: Date.parse(e.startedAt) - state.startedAtMs, text: '', calls: [] },
        ],
      };
    case 'turn_ended':
      return {
        ...state,
        turns: mapTurn(state.turns, e.turn, (t) => ({ ...t, durationMs: e.durationMs, text: e.text })),
      };
    case 'tool_call': {
      const { kind, label, result } = callLabel(e.call);
      const sql = (e.call.input as { sql?: unknown } | null)?.sql;
      const view: CallView = {
        id: e.call.id,
        kind,
        label,
        result,
        durationMs: e.call.durationMs,
        ...(typeof sql === 'string' && { sql }),
      };
      return {
        ...state,
        turns: mapTurn(state.turns, e.call.turn, (t) => ({ ...t, calls: [...t.calls, view] })),
      };
    }
    case 'finding':
      return {
        ...state,
        findings: [...state.findings, e.finding],
        savingsUsd: state.savingsUsd + e.finding.estimated_monthly_savings_usd,
      };
    case 'run_finished': {
      const turns = closeOpenTurns(state);
      const last = turns[turns.length - 1];
      if (last && last.calls.length === 0 && last.text === e.summary) {
        turns[turns.length - 1] = { ...last, text: '' };
      }
      return {
        ...state,
        phase: 'finished',
        turns,
        end: {
          stopReason: e.stopReason,
          ...(e.stopDetail && { stopDetail: e.stopDetail }),
          summary: e.summary,
          turns: e.turns,
          toolCalls: e.toolCalls,
          usage: e.usage,
        },
      };
    }
    case 'run_failed':
      return { ...state, phase: 'finished', turns: closeOpenTurns(state), error: e.error };
  }
}

function count(n: number): string {
  return `${n} ${n === 1 ? 'finding' : 'findings'}`;
}

/** The one plain-words line that says what the agent is doing, or how it ended. */
export function statusText(state: RunState, status: UiStatus | null): string {
  if (status && !status.ready && state.phase === 'idle') return status.problems[0] ?? 'Not ready';
  if (state.error !== undefined) return `Something went wrong: ${state.error}`;
  if (state.phase === 'idle') return 'Ready when you are';
  if (state.phase === 'running') {
    const last = state.turns[state.turns.length - 1];
    if (last && last.durationMs !== undefined) return 'Running queries';
    return state.turns.length <= 1 ? 'Reading the question' : 'Thinking about what to check next';
  }
  const end = state.end;
  if (!end) return 'Finished';
  const n = count(state.findings.length);
  if (end.stopReason === 'completed') return `Finished · ${n}`;
  if (end.stopReason === 'aborted') return `Stopped by you · ${n} so far`;
  return `Stopped early: ${end.stopDetail ?? end.stopReason} · ${n} so far`;
}
