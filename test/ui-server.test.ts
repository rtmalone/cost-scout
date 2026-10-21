import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import Anthropic from '@anthropic-ai/sdk';
import type { MessagesClient } from '../src/agent/run.ts';
import { generate } from '../src/data/generate.ts';
import { ReadOnlyDb } from '../src/tools/db.ts';
import type { RunEvent, UiStatus } from '../src/ui/events.ts';
import { createUiServer, type UiServerOptions } from '../src/ui/server.ts';

let dir: string;
let staticDir: string;
let db: ReadOnlyDb;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cost-scout-ui-server-test-'));
  staticDir = join(dir, 'static');
  mkdirSync(staticDir);
  writeFileSync(join(staticDir, 'index.html'), 'hello');
  const { dbPath } = await generate({ dataDir: dir, groundTruthPath: join(dir, 'ground-truth.json') });
  db = await ReadOnlyDb.open(dbPath);
});

after(() => {
  db?.close();
  rmSync(dir, { recursive: true, force: true });
});

// --- A scripted stand-in for the Anthropic client ---------------------------

type Step = Anthropic.Message | ((body: Anthropic.MessageCreateParamsNonStreaming) => Anthropic.Message | Promise<Anthropic.Message>);

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

// --- Server harness ----------------------------------------------------------

const servers: http.Server[] = [];
after(() => {
  for (const s of servers) {
    s.closeAllConnections();
    s.close();
  }
});

async function start(overrides: Partial<UiServerOptions> = {}) {
  const server = createUiServer({
    db,
    problems: [],
    model: 'claude-test',
    staticDir,
    ...overrides,
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { server, port: (server.address() as AddressInfo).port };
}

interface Reply {
  status: number;
  type: string;
  body: string;
}

function request(
  port: number,
  method: string,
  path: string,
  body?: string,
  headers: http.OutgoingHttpHeaders = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, type: String(res.headers['content-type']), body: data }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

const getStatus = async (port: number) => JSON.parse((await request(port, 'GET', '/api/status')).body) as UiStatus;
const JSON_TYPE = { 'content-type': 'application/json' };
const postRun = (port: number, body: string, headers: http.OutgoingHttpHeaders = {}) =>
  request(port, 'POST', '/api/run', body, { ...JSON_TYPE, ...headers });
const ndjson = (body: string) => body.split('\n').filter(Boolean).map((l) => JSON.parse(l) as RunEvent);

const done = () => message([text('Nothing found.')], 'end_turn');

async function until(cond: () => boolean | Promise<boolean>, ms = 1000) {
  const deadline = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('ui server', () => {
  it('streams a run as NDJSON', async () => {
    const { client } = fakeClient([done()]);
    const { port } = await start({ client });
    const res = await postRun(port, '{"question":"find waste"}');
    assert.equal(res.status, 200);
    assert.match(res.type, /^application\/x-ndjson/);
    const events = ndjson(res.body);
    assert.equal(events[0]?.type, 'run_started');
    assert.equal(events.at(-1)?.type, 'run_finished');
  });

  it('rejects a second run while one is going', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { client } = fakeClient([async () => (await gate, done())]);
    const { port } = await start({ client });

    const first = postRun(port, '{"question":"one"}');
    await until(async () => (await getStatus(port)).busy);

    const second = await postRun(port, '{"question":"two"}');
    assert.equal(second.status, 409);
    assert.deepEqual(JSON.parse(second.body), { error: 'A run is already in progress.' });

    release();
    assert.equal((await first).status, 200);
    assert.equal((await getStatus(port)).busy, false);
  });

  it('aborts the run when the client disconnects', async () => {
    let sawAbort = false;
    let entered!: () => void;
    const inStep = new Promise<void>((r) => (entered = r));
    const client: MessagesClient = {
      messages: {
        create(_body, options) {
          return new Promise((_resolve, reject) => {
            const signal = options?.signal;
            const onAbort = () => {
              sawAbort = true;
              reject(new Anthropic.APIUserAbortError());
            };
            if (signal?.aborted) onAbort();
            else signal?.addEventListener('abort', onAbort, { once: true });
            entered();
          });
        },
      },
    };
    const { port } = await start({ client });

    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/api/run', headers: JSON_TYPE });
    req.on('error', () => {});
    req.on('response', (res) => {
      res.on('error', () => {});
      res.once('data', () => req.destroy());
    });
    req.end('{"question":"x"}');

    await inStep;
    await until(() => sawAbort);
    await until(async () => !(await getStatus(port)).busy);
  });

  it('refuses to run when not ready and says why', async () => {
    const problems = ['No dataset found. Run pnpm generate first.'];
    const { port } = await start({ db: null, problems });
    const status = await getStatus(port);
    assert.equal(status.ready, false);
    assert.deepEqual(status.problems, problems);
    const res = await postRun(port, '{"question":"x"}');
    assert.equal(res.status, 503);
    assert.deepEqual(JSON.parse(res.body), { error: problems[0] });
  });

  it('rejects a non-JSON content type without starting a run', async () => {
    const { client } = fakeClient([done()]);
    const { port } = await start({ client });
    const res = await postRun(port, '{"question":"x"}', { 'content-type': 'text/plain' });
    assert.equal(res.status, 415);
    assert.deepEqual(JSON.parse(res.body), { error: 'Content-Type must be application/json.' });
    assert.equal((await getStatus(port)).busy, false);
    const withCharset = await postRun(port, '{"question":"x"}', { 'content-type': 'application/json; charset=utf-8' });
    assert.equal(withCharset.status, 200);
  });

  it('rejects cross-site and rebinding requests', async () => {
    const { port } = await start();
    const evil = await postRun(port, '{"question":"x"}', { origin: 'https://evil.example' });
    assert.equal(evil.status, 403);
    assert.deepEqual(JSON.parse(evil.body), { error: 'Forbidden.' });
    assert.equal((await getStatus(port)).busy, false);
    const rebound = await request(port, 'GET', '/api/status', undefined, { host: 'evil.example:4317' });
    assert.equal(rebound.status, 403);
    const reboundRun = await postRun(port, '{"question":"x"}', { host: 'evil.example:4317' });
    assert.equal(reboundRun.status, 403);
  });

  it('allows a loopback Origin on another port', async () => {
    const { client } = fakeClient([done()]);
    const { port } = await start({ client });
    const res = await postRun(port, '{"question":"x"}', { origin: 'http://localhost:5173' });
    assert.equal(res.status, 200);
    const ipv6 = await request(port, 'GET', '/api/status', undefined, { host: `[::1]:${port}` });
    assert.equal(ipv6.status, 200);
  });

  it('rejects a malformed body', async () => {
    const { port } = await start();
    assert.equal((await postRun(port, 'not json')).status, 400);
    assert.equal((await postRun(port, '{"question":3}')).status, 400);
  });

  it('serves the page and refuses paths outside it', async () => {
    const { port } = await start();
    const page = await request(port, 'GET', '/');
    assert.equal(page.status, 200);
    assert.equal(page.body, 'hello');
    assert.equal((await request(port, 'GET', '/../package.json')).status, 404);
    assert.equal((await request(port, 'GET', '/%2e%2e/package.json')).status, 404);
    assert.equal((await request(port, 'GET', '/missing.js')).status, 404);
  });

  it('explains when the page is not built', async () => {
    const { port } = await start({ staticDir: join(dir, 'nowhere') });
    const res = await request(port, 'GET', '/');
    assert.equal(res.status, 500);
    assert.equal(res.body, "The page isn't built. Run pnpm ui.");
  });
});
