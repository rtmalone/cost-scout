/**
 * The agent loop. This is the part to build (and talk about) yourself.
 *
 * Pattern (same shape as Cortex's packages/server/src/services/claude.ts):
 *
 *   1. messages = [{ role: 'user', content: question }]
 *   2. Loop up to opts.maxTurns:
 *        response = client.messages.create({ model, max_tokens, system: SYSTEM_PROMPT, tools: TOOLS, messages })
 *        push { role: 'assistant', content: response.content }
 *        if response.stop_reason !== 'tool_use': break
 *        run every tool_use block through handleToolCall(name, input, ctx), in parallel
 *        push { role: 'user', content: [{ type: 'tool_result', tool_use_id, content, is_error }, ...] }
 *   3. Return ctx.findings, the final text, and usage/turn counts for the eval report.
 *
 * Decisions worth making on purpose (good interview material):
 *   - The system prompt: how to investigate (schema first, aggregate in SQL,
 *     check utilization before calling something idle), what counts as
 *     evidence, and how to price savings (EffectiveCost, 30-day month).
 *   - What stops the loop: turn cap, token budget, or the model saying it's done.
 *   - Prompt caching on the system prompt and tool definitions.
 *   - Logging every tool call (sql + purpose + row count) so a run can be audited.
 */

import type { Finding } from '../findings.ts';
import type { ReadOnlyDb } from '../tools/db.ts';

export interface AgentOptions {
  db: ReadOnlyDb;
  model: string;
  maxTurns?: number;
  /** Called for each tool call, for progress output and audit logs. */
  onToolCall?: (event: { name: string; input: unknown; isError: boolean }) => void;
}

export interface AgentResult {
  findings: Finding[];
  summary: string;
  turns: number;
  usage: { inputTokens: number; outputTokens: number };
}

// TODO(tyler): write the system prompt.
export const SYSTEM_PROMPT = ``;

export async function runAgent(question: string, opts: AgentOptions): Promise<AgentResult> {
  // TODO(tyler): implement the loop described above.
  void question;
  void opts;
  throw new Error('runAgent is not implemented yet. See the outline at the top of src/agent/run.ts.');
}
