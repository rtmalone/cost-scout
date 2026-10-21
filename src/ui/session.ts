import { DEFAULT_QUESTION, runAgent, type MessagesClient } from '../agent/run.ts';
import type { Finding } from '../findings.ts';
import type { ReadOnlyDb } from '../tools/db.ts';
import type { RunEvent } from './events.ts';
import { monthlySpend } from './spend.ts';

export interface SessionOptions {
  db: ReadOnlyDb;
  model: string;
  signal: AbortSignal;
  client?: MessagesClient;
  maxTurns?: number;
}

/**
 * Runs the agent and reports it as events: run_started first, then exactly one of run_finished
 * or run_failed last. Never throws; anything that goes wrong ends the stream with run_failed.
 */
export async function runSession(
  question: string,
  opts: SessionOptions,
  emit: (e: RunEvent) => void,
): Promise<void> {
  // A throwing consumer (e.g. a closed stream) must not unwind through the agent loop.
  let consumerFailed = false;
  const send = (e: RunEvent) => {
    if (consumerFailed) return;
    try {
      emit(e);
    } catch {
      consumerFailed = true;
      abort.abort();
    }
  };
  const abort = new AbortController();
  const onAbort = () => abort.abort();
  if (opts.signal.aborted) abort.abort();
  else opts.signal.addEventListener('abort', onAbort, { once: true });

  try {
    const q = question.trim() === '' ? DEFAULT_QUESTION : question;
    send({
      type: 'run_started',
      question: q,
      model: opts.model,
      startedAt: new Date().toISOString(),
      monthlySpendUsd: await monthlySpend(opts.db),
    });

    const result = await runAgent(q, {
      db: opts.db,
      model: opts.model,
      signal: abort.signal,
      ...(opts.client && { client: opts.client }),
      ...(opts.maxTurns !== undefined && { maxTurns: opts.maxTurns }),
      onTurnStart: (t) => send({ type: 'turn_started', turn: t.turn, startedAt: t.startedAt }),
      onTurnEnd: (t) => send({ type: 'turn_ended', turn: t.turn, durationMs: t.durationMs, text: t.text }),
      onToolCall: (call) => {
        send({ type: 'tool_call', call });
        if (call.name === 'report_finding' && !call.isError) {
          send({ type: 'finding', toolCallId: call.id, finding: call.input as Finding });
        }
      },
    });

    send({
      type: 'run_finished',
      stopReason: result.stopReason,
      ...(result.stopDetail && { stopDetail: result.stopDetail }),
      summary: result.summary,
      turns: result.turns,
      toolCalls: result.toolCalls.length,
      usage: result.usage,
    });
  } catch (e) {
    send({ type: 'run_failed', error: e instanceof Error ? e.message : String(e) });
  } finally {
    opts.signal.removeEventListener('abort', onAbort);
  }
}
