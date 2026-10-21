/** What a run streams to the UI. Types only: the web app imports these with `import type`. */

import type { StopReason, ToolCallRecord, Usage } from '../agent/run.ts';
import type { Finding } from '../findings.ts';

export type RunEvent =
  | {
      type: 'run_started';
      question: string;
      model: string;
      startedAt: string;
      monthlySpendUsd: number;
    }
  | { type: 'turn_started'; turn: number; startedAt: string }
  | { type: 'turn_ended'; turn: number; durationMs: number; text: string }
  | { type: 'tool_call'; call: ToolCallRecord }
  | { type: 'finding'; toolCallId: string; finding: Finding }
  | {
      type: 'run_finished';
      stopReason: StopReason;
      stopDetail?: string;
      summary: string;
      turns: number;
      toolCalls: number;
      usage: Usage;
    }
  | { type: 'run_failed'; error: string };

export interface UiStatus {
  ready: boolean;
  problems: string[];
  model: string;
  busy: boolean;
}
