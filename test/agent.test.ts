import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import Anthropic from '@anthropic-ai/sdk';
import { runAgent, type AgentOptions, type MessagesClient, type TurnEnd } from '../src/agent/run.ts';
import { generate } from '../src/data/generate.ts';
import { ReadOnlyDb } from '../src/tools/db.ts';

// The real client must fit the seam the tests fake.
const _realClientFits: MessagesClient = new Anthropic({ apiKey: 'unused' });
void _realClientFits;

let dir: string;
let db: ReadOnlyDb;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cost-scout-agent-test-'));
  const { dbPath } = await generate({ dataDir: dir, groundTruthPath: join(dir, 'ground-truth.json') });
  db = await ReadOnlyDb.open(dbPath);
});

after(() => {
  db?.close();
  rmSync(dir, { recursive: true, force: true });
});

// --- A scripted stand-in for the Anthropic client ---------------------------

type Step = Anthropic.Message | ((body: Anthropic.MessageCreateParamsNonStreaming) => Anthropic.Message);

/**
 * The message rules the API enforces on every request. The fake client checks them, so a loop
 * that drops or reorders a tool_result fails here the way it would fail against the real API.
 */
function checkMessageRules(messages: Anthropic.MessageParam[]) {
  const blocks = (m: Anthropic.MessageParam | undefined) => (m && Array.isArray(m.content) ? m.content : []);
  messages.forEach((m, i) => {
    const expected = i % 2 === 0 ? 'user' : 'assistant';
    if (m.role !== expected) throw new Error(`messages[${i}] should be ${expected}, got ${m.role}`);

    if (m.role === 'user') {
      const content = blocks(m);
      const firstOther = content.findIndex((b) => b.type !== 'tool_result');
      const results = content.filter((b) => b.type === 'tool_result');
      if (firstOther !== -1 && content.slice(firstOther).some((b) => b.type === 'tool_result')) {
        throw new Error(`messages[${i}]: tool_result blocks must come first`);
      }
      const asked = blocks(messages[i - 1]).filter((b) => b.type === 'tool_use').map((b) => b.id);
      const answered = results.map((b) => b.tool_use_id);
      const orphans = answered.filter((id) => !asked.includes(id));
      if (orphans.length) throw new Error(`messages[${i}]: tool_result without a tool_use: ${orphans.join(', ')}`);
      for (const id of asked) {
        const n = answered.filter((a) => a === id).length;
        if (n !== 1) throw new Error(`messages[${i}]: tool_use ${id} has ${n} tool_results, expected 1`);
      }
    } else if (blocks(m).some((b) => b.type === 'tool_use') && i === messages.length - 1) {
      throw new Error(`messages[${i}]: tool_use with no tool_result after it`);
    }
  });
}

/** Replays scripted responses in order, checks each request, and records a snapshot of it. */
function fakeClient(steps: Step[]) {
  const requests: Anthropic.MessageCreateParamsNonStreaming[] = [];
  const client: MessagesClient = {
    messages: {
      async create(body) {
        checkMessageRules(body.messages);
        requests.push(structuredClone(body));
        const step = steps[requests.length - 1];
        if (!step) throw new Error(`fake client: no response scripted for request ${requests.length}`);
        return typeof step === 'function' ? step(body) : step;
      },
    },
  };
  return { client, requests };
}

let nextId = 0;

function message(
  content: Anthropic.ContentBlock[],
  stop_reason: Anthropic.StopReason,
  usage: Partial<Anthropic.Usage> = {},
): Anthropic.Message {
  return {
    id: `msg_${++nextId}`,
    type: 'message',
    role: 'assistant',
    model: 'claude-test',
    container: null,
    diagnostics: null,
    content,
    stop_reason,
    stop_sequence: null,
    stop_details: null,
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      cache_creation: null,
      inference_geo: null,
      output_tokens_details: null,
      server_tool_use: null,
      service_tier: null,
      speed: null,
      ...usage,
    },
  };
}

const text = (t: string): Anthropic.TextBlock => ({ type: 'text', text: t, citations: null });

const toolUse = (name: string, input: unknown): Anthropic.ToolUseBlock => ({
  type: 'tool_use',
  id: `toolu_${++nextId}`,
  name,
  input,
  caller: { type: 'direct' },
});

const toolResults = (req: Anthropic.MessageCreateParamsNonStreaming | undefined) => {
  const last = req?.messages.at(-1);
  assert.equal(last?.role, 'user');
  assert.ok(Array.isArray(last.content));
  return last.content as Anthropic.ToolResultBlockParam[];
};

const finding = {
  title: 'Idle instance',
  category: 'compute',
  resource_ids: ['i-0e8f7a6b5c4d30031'],
  evidence: 'CPU averaged 1.2% over 90 days',
  estimated_monthly_savings_usd: 276.48,
  proposed_change: 'aws ec2 stop-instances --instance-ids i-0e8f7a6b5c4d30031',
  rollback: 'aws ec2 start-instances --instance-ids i-0e8f7a6b5c4d30031',
  risk: 'low',
  approval_notes: 'Confirm with the owner',
};

const opts = (client: MessagesClient, extra: Partial<AgentOptions> = {}): AgentOptions => ({
  db,
  model: 'claude-test',
  client,
  ...extra,
});

// --- Tests -------------------------------------------------------------------

describe('runAgent', () => {
  it('runs a tool round-trip and returns the findings', async () => {
    const schema = toolUse('describe_schema', {});
    const report = toolUse('report_finding', finding);
    const { client, requests } = fakeClient([
      message([text('Looking at the schema.'), schema], 'tool_use'),
      message([report], 'tool_use'),
      message([text('1 finding, ~$276/month.')], 'end_turn'),
    ]);
    const seen: string[] = [];

    const result = await runAgent('find waste', opts(client, { onToolCall: (c) => seen.push(c.name) }));

    assert.equal(result.stopReason, 'completed');
    assert.equal(result.turns, 3);
    assert.equal(result.summary, '1 finding, ~$276/month.');
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0]?.title, 'Idle instance');
    assert.deepEqual(seen, ['describe_schema', 'report_finding']);
    assert.deepEqual(
      result.toolCalls.map((c) => [c.id, c.turn, c.isError]),
      [
        [schema.id, 1, false],
        [report.id, 2, false],
      ],
    );
    assert.match(result.toolCalls[1]?.summary ?? '', /Recorded finding #1/);

    // The full assistant turn goes back in the history, followed by the results.
    assert.deepEqual(requests[1]?.messages[1], { role: 'assistant', content: [text('Looking at the schema.'), schema] });
    assert.equal(toolResults(requests[1])[0]?.tool_use_id, schema.id);
    assert.match(String(toolResults(requests[1])[0]?.content), /## billing/);
  });

  it('reports each turn start and end around the tool calls', async () => {
    const { client } = fakeClient([
      message([text('Looking.'), toolUse('describe_schema', {})], 'tool_use'),
      message([text('Done.')], 'end_turn'),
    ]);
    const events: string[] = [];
    const ends: TurnEnd[] = [];

    await runAgent(
      'find waste',
      opts(client, {
        onTurnStart: (e) => events.push(`start ${e.turn}`),
        onTurnEnd: (e) => {
          events.push(`end ${e.turn}`);
          ends.push(e);
        },
        onToolCall: (c) => events.push(`tool ${c.name}`),
      }),
    );

    assert.deepEqual(events, ['start 1', 'end 1', 'tool describe_schema', 'start 2', 'end 2']);
    assert.equal(ends[0]?.text, 'Looking.');
    assert.equal(ends[0]?.usage.inputTokens, 10);
    assert.ok((ends[0]?.durationMs ?? -1) >= 0);
    assert.equal(ends[1]?.text, 'Done.');
  });

  it('does not report a turn end when the request fails', async () => {
    const { client } = fakeClient([
      () => {
        throw new Anthropic.InternalServerError(500, undefined, 'boom', new Headers());
      },
    ]);
    const events: string[] = [];

    const result = await runAgent(
      'find waste',
      opts(client, { onTurnStart: (e) => events.push(`start ${e.turn}`), onTurnEnd: (e) => events.push(`end ${e.turn}`) }),
    );

    assert.deepEqual(events, ['start 1']);
    assert.equal(result.stopReason, 'api_error');
  });

  it('caches the system prompt and the conversation', async () => {
    const { client, requests } = fakeClient([message([text('Nothing to report.')], 'end_turn')]);
    await runAgent('find waste', opts(client));

    const req = requests[0];
    assert.ok(Array.isArray(req?.system));
    assert.deepEqual(req.system.at(-1)?.cache_control, { type: 'ephemeral' });
    assert.deepEqual(req.cache_control, { type: 'ephemeral' });
    assert.equal('thinking' in req, false, 'thinking is left to the model default unless set');
    assert.equal('output_config' in req, false, 'so is effort');
  });

  it('passes thinking and effort through when set', async () => {
    const { client, requests } = fakeClient([message([text('done')], 'end_turn')]);
    await runAgent('find waste', opts(client, { thinking: { type: 'adaptive' }, effort: 'low' }));
    assert.deepEqual(requests[0]?.thinking, { type: 'adaptive' });
    assert.deepEqual(requests[0]?.output_config, { effort: 'low' });
  });

  it('sends thinking blocks back unchanged, signature included', async () => {
    const thinking: Anthropic.ThinkingBlock = { type: 'thinking', thinking: 'Check the schema first.', signature: 'sig-abc123' };
    const call = toolUse('describe_schema', {});
    const { client, requests } = fakeClient([message([thinking, call], 'tool_use'), message([text('done')], 'end_turn')]);

    await runAgent('find waste', opts(client));

    assert.deepEqual(requests[1]?.messages[1], { role: 'assistant', content: [thinking, call] });
  });

  it('runs parallel tool calls and returns every result in one message, in order', async () => {
    // The first call is the slowest, so if the calls overlap they finish out of request order.
    const calls = [
      toolUse('run_sql', { sql: 'SELECT sum(a.range * b.range) AS s FROM range(15000) a, range(15000) b' }),
      toolUse('run_sql', { sql: 'DROP TABLE billing' }),
      toolUse('describe_schema', {}),
    ];
    const { client, requests } = fakeClient([message(calls, 'tool_use'), message([text('done')], 'end_turn')]);

    const result = await runAgent('find waste', opts(client));

    const results = toolResults(requests[1]);
    assert.equal(requests[1]?.messages.length, 3, 'one assistant turn and one user message of results');
    assert.deepEqual(
      results.map((r) => [r.tool_use_id, r.is_error]),
      calls.map((c, i) => [c.id, i === 1]),
    );
    assert.deepEqual(
      result.toolCalls.map((c) => c.summary),
      ['1 rows', 'Only SELECT queries are allowed. This database is read-only.', '3 tables described'],
    );

    const [slow, , fast] = result.toolCalls.map((c) => ({ start: Date.parse(c.startedAt), end: Date.parse(c.startedAt) + c.durationMs }));
    assert.ok(slow && fast);
    assert.ok(slow.end - slow.start > 50, 'the first call should be slow enough to overlap the others');
    assert.ok(fast.start < slow.end, 'the calls ran at the same time');
    assert.ok(fast.end < slow.end, 'the last call finished before the first, yet its result comes last');
  });

  it('propagates tool errors to the model and the audit log', async () => {
    const bad = toolUse('report_finding', { ...finding, resource_ids: ['i-doesnotexist'] });
    const unknown = toolUse('delete_everything', {});
    const { client, requests } = fakeClient([message([bad, unknown], 'tool_use'), message([text('done')], 'end_turn')]);
    const errors: boolean[] = [];

    const result = await runAgent('find waste', opts(client, { onToolCall: (c) => errors.push(c.isError) }));

    const [r1, r2] = toolResults(requests[1]);
    assert.equal(r1?.is_error, true);
    assert.match(String(r1?.content), /unknown resource_ids/);
    assert.equal(r2?.is_error, true);
    assert.match(String(r2?.content), /Unknown tool/);
    assert.deepEqual(errors, [true, true]);
    assert.equal(result.findings.length, 0);
  });

  it('stops at the turn cap and keeps the findings so far', async () => {
    const { client, requests } = fakeClient([
      message([toolUse('report_finding', finding)], 'tool_use'),
      message([toolUse('run_sql', { sql: 'SELECT 1' })], 'tool_use'),
      message([toolUse('run_sql', { sql: 'SELECT 2' })], 'tool_use'),
    ]);

    const result = await runAgent('find waste', opts(client, { maxTurns: 2 }));

    assert.equal(result.stopReason, 'max_turns');
    assert.equal(result.turns, 2);
    assert.equal(requests.length, 2);
    assert.equal(result.findings.length, 1);
    assert.equal(result.toolCalls.length, 2, 'the last turn’s tool calls still run and are audited');
  });

  it('does not run a tool call cut off at max_tokens, but runs the complete ones', async () => {
    const complete = toolUse('run_sql', { sql: 'SELECT 1 AS one' });
    const cutOff = toolUse('report_finding', { title: 'Idle inst' });
    const { client, requests } = fakeClient([
      message([complete, cutOff], 'max_tokens'),
      message([text('done')], 'end_turn'),
    ]);

    const result = await runAgent('find waste', opts(client));

    const [r1, r2] = toolResults(requests[1]);
    assert.equal(r1?.tool_use_id, complete.id);
    assert.equal(r1?.is_error, false);
    assert.equal(r2?.tool_use_id, cutOff.id);
    assert.equal(r2?.is_error, true);
    assert.match(String(r2?.content), /max_tokens/);
    assert.equal(result.findings.length, 0);
    assert.equal(result.stopReason, 'completed');
  });

  it('reports a final answer cut off at max_tokens', async () => {
    const { client } = fakeClient([message([text('Summary: 3 findings, and the')], 'max_tokens')]);
    const result = await runAgent('find waste', opts(client));
    assert.equal(result.stopReason, 'max_tokens');
    assert.equal(result.summary, 'Summary: 3 findings, and the');
  });

  it('stops when the token budget is spent', async () => {
    const turn = () => message([toolUse('run_sql', { sql: 'SELECT 1' })], 'tool_use', { input_tokens: 500, output_tokens: 100 });
    const { client, requests } = fakeClient([turn(), turn(), turn(), turn()]);

    const result = await runAgent('find waste', opts(client, { tokenBudget: 1000 }));

    assert.equal(result.stopReason, 'token_budget');
    assert.equal(requests.length, 2, '600 tokens after one call, 1200 after two');
    assert.match(result.stopDetail ?? '', /1200 of a 1000-token budget/);
  });

  it('sums usage across turns, including cache reads and writes', async () => {
    const { client } = fakeClient([
      message([toolUse('describe_schema', {})], 'tool_use', {
        input_tokens: 1200,
        output_tokens: 80,
        cache_creation_input_tokens: 3000,
        cache_read_input_tokens: null,
      }),
      message([text('done')], 'end_turn', {
        input_tokens: 400,
        output_tokens: 150,
        cache_creation_input_tokens: 900,
        cache_read_input_tokens: 3000,
      }),
    ]);

    const result = await runAgent('find waste', opts(client));

    assert.deepEqual(result.usage, {
      inputTokens: 1600,
      outputTokens: 230,
      cacheReadTokens: 3000,
      cacheWriteTokens: 3900,
    });
  });

  it('does not run tool calls from a refused turn', async () => {
    const refused = message([toolUse('report_finding', finding)], 'refusal');
    refused.stop_details = { type: 'refusal', category: null, explanation: 'declined' };
    const { client } = fakeClient([refused]);

    const result = await runAgent('find waste', opts(client));

    assert.equal(result.stopReason, 'refusal');
    assert.equal(result.stopDetail, 'declined');
    assert.equal(result.toolCalls.length, 0);
    assert.equal(result.findings.length, 0);
  });

  it('resumes a paused turn by sending it back', async () => {
    const paused = message([text('Working…')], 'pause_turn');
    const { client, requests } = fakeClient([paused, message([text('done')], 'end_turn')]);

    const result = await runAgent('find waste', opts(client));

    assert.equal(result.stopReason, 'completed');
    assert.deepEqual(requests[1]?.messages.at(-1), { role: 'assistant', content: paused.content });
  });

  for (const [stop, expected] of [
    ['stop_sequence', 'completed'],
    ['model_context_window_exceeded', 'context_window_exceeded'],
    [null, 'unexpected_stop_reason'],
    ['some_future_reason', 'unexpected_stop_reason'],
  ] as const) {
    it(`handles stop_reason ${stop} without running tools`, async () => {
      const { client } = fakeClient([message([text('…'), toolUse('report_finding', finding)], stop as Anthropic.StopReason)]);
      const result = await runAgent('find waste', opts(client));
      assert.equal(result.stopReason, expected);
      assert.equal(result.toolCalls.length, 0);
      assert.equal(result.findings.length, 0);
      if (expected === 'completed') assert.equal(result.summary, '…');
    });
  }

  it('stops when stop_reason is tool_use but there are no tool calls', async () => {
    const { client, requests } = fakeClient([message([text('I will query next.')], 'tool_use')]);
    const result = await runAgent('find waste', opts(client));
    assert.equal(result.stopReason, 'unexpected_stop_reason');
    assert.equal(requests.length, 1);
  });

  it('makes no further model call when aborted during a tool call', async () => {
    const controller = new AbortController();
    const { client, requests } = fakeClient([
      () => {
        setTimeout(() => controller.abort(), 20);
        return message([toolUse('run_sql', { sql: 'SELECT sum(a.range * b.range) AS s FROM range(15000) a, range(15000) b' })], 'tool_use');
      },
      message([text('should not be reached')], 'end_turn'),
    ]);

    const result = await runAgent('find waste', opts(client, { signal: controller.signal }));

    assert.equal(result.stopReason, 'aborted');
    assert.equal(requests.length, 1);
    assert.equal(result.toolCalls.length, 1, 'the call in flight finishes and is audited');
    assert.ok((result.toolCalls[0]?.durationMs ?? 0) > 20, 'the abort fired while the call was running');
  });

  it('stops gracefully when aborted mid-request', async () => {
    const controller = new AbortController();
    const client: MessagesClient = {
      messages: {
        create: (_body, options) =>
          new Promise((_resolve, reject) => {
            options?.signal?.addEventListener('abort', () => reject(new Anthropic.APIUserAbortError()));
            controller.abort();
          }),
      },
    };

    const result = await runAgent('find waste', opts(client, { signal: controller.signal }));

    assert.equal(result.stopReason, 'aborted');
    assert.equal(result.turns, 0);
  });

  it('returns an API error as a stop reason instead of losing the findings', async () => {
    const { client } = fakeClient([
      message([toolUse('report_finding', finding)], 'tool_use'),
      () => {
        throw new Anthropic.InternalServerError(500, undefined, 'overloaded', new Headers());
      },
    ]);

    const result = await runAgent('find waste', opts(client));

    assert.equal(result.stopReason, 'api_error');
    assert.equal(result.findings.length, 1);
  });
});

describe('fake client message rules', () => {
  const call = toolUse('run_sql', { sql: 'SELECT 1' });
  const result = (id: string): Anthropic.ToolResultBlockParam => ({ type: 'tool_result', tool_use_id: id, content: 'ok' });
  const assistant: Anthropic.MessageParam = { role: 'assistant', content: [call] };

  for (const [label, messages, error] of [
    ['a missing tool_result', [{ role: 'user', content: 'q' }, assistant, { role: 'user', content: [text('hi')] }], /0 tool_results/],
    ['a duplicate tool_result', [{ role: 'user', content: 'q' }, assistant, { role: 'user', content: [result(call.id), result(call.id)] }], /2 tool_results/],
    ['an orphan tool_result', [{ role: 'user', content: [result('toolu_nope')] }], /without a tool_use/],
    ['text before a tool_result', [{ role: 'user', content: 'q' }, assistant, { role: 'user', content: [text('hi'), result(call.id)] }], /must come first/],
    ['two user turns in a row', [{ role: 'user', content: 'q' }, { role: 'user', content: 'q' }], /should be assistant/],
  ] as [string, Anthropic.MessageParam[], RegExp][]) {
    it(`rejects ${label}`, async () => {
      const { client } = fakeClient([]);
      await assert.rejects(async () => client.messages.create({ model: 'm', max_tokens: 1, messages }), error);
    });
  }
});
