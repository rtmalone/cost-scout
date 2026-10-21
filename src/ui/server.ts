import { readFile } from 'node:fs/promises';
import http from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import type { MessagesClient } from '../agent/run.ts';
import type { ReadOnlyDb } from '../tools/db.ts';
import type { RunEvent, UiStatus } from './events.ts';
import { runSession } from './session.ts';

export interface UiServerOptions {
  db: ReadOnlyDb | null;
  problems: string[];
  model: string;
  staticDir: string;
  client?: MessagesClient;
  maxTurns?: number;
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
};

const MAX_BODY_BYTES = 1_000_000;

function sendJson(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req: http.IncomingMessage): Promise<string | null> {
  return new Promise((resolveBody) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        resolveBody(null);
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolveBody(null));
  });
}

/** The question from a `{"question": string}` body, or null if the body is anything else. */
function parseQuestion(raw: string | null): string | null {
  if (raw === null) return null;
  try {
    const body: unknown = JSON.parse(raw);
    const q = body && typeof body === 'object' ? (body as { question?: unknown }).question : undefined;
    return typeof q === 'string' ? q : null;
  } catch {
    return null;
  }
}

export function createUiServer(opts: UiServerOptions): http.Server {
  const ready = opts.problems.length === 0 && opts.db !== null;
  let busy = false;

  const status = (): UiStatus => ({ ready, problems: opts.problems, model: opts.model, busy });

  async function handleRun(req: http.IncomingMessage, res: http.ServerResponse) {
    if (!ready || !opts.db) return sendJson(res, 503, { error: opts.problems.join(' ') });
    if (busy) return sendJson(res, 409, { error: 'A run is already in progress.' });

    const question = parseQuestion(await readBody(req));
    if (question === null) return sendJson(res, 400, { error: 'Body must be JSON: {"question": string}.' });
    // Re-check after the await: another request may have started a run while the body was read.
    if (busy) return sendJson(res, 409, { error: 'A run is already in progress.' });
    busy = true;

    const abort = new AbortController();
    // Close before the run has ended means the client went away.
    res.on('close', () => {
      if (!res.writableEnded) abort.abort();
    });
    res.on('error', () => abort.abort());

    res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-cache' });
    const emit = (e: RunEvent) => {
      // Throwing tells runSession the consumer is gone, so it aborts the agent.
      if (res.destroyed || res.writableEnded) throw new Error('client disconnected');
      res.write(`${JSON.stringify(e)}\n`);
    };
    try {
      await runSession(question, {
        db: opts.db,
        model: opts.model,
        signal: abort.signal,
        ...(opts.client && { client: opts.client }),
        ...(opts.maxTurns !== undefined && { maxTurns: opts.maxTurns }),
      }, emit);
    } finally {
      busy = false;
      if (!res.destroyed) res.end();
    }
  }

  async function handleStatic(rawUrl: string, res: http.ServerResponse) {
    let pathname: string;
    try {
      // Not new URL(): it would normalise `/../` away before the containment check.
      pathname = decodeURIComponent(rawUrl.split(/[?#]/)[0] ?? '/');
    } catch {
      res.writeHead(404).end();
      return;
    }
    const root = resolve(opts.staticDir);
    const isIndex = pathname === '/';
    const file = resolve(join(root, isIndex ? 'index.html' : pathname));
    if (file !== root && !file.startsWith(root + sep)) {
      res.writeHead(404).end();
      return;
    }
    try {
      const data = await readFile(file);
      res.writeHead(200, { 'Content-Type': CONTENT_TYPES[extname(file)] ?? 'application/octet-stream' });
      res.end(data);
    } catch {
      if (isIndex) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end("The page isn't built. Run pnpm ui.");
      } else {
        res.writeHead(404).end();
      }
    }
  }

  return http.createServer((req, res) => {
    const url = req.url ?? '/';
    const path = url.split(/[?#]/)[0];
    const handled =
      req.method === 'GET' && path === '/api/status'
        ? Promise.resolve(sendJson(res, 200, status()))
        : req.method === 'POST' && path === '/api/run'
          ? handleRun(req, res)
          : req.method === 'GET'
            ? handleStatic(url, res)
            : Promise.resolve(void res.writeHead(404).end());
    handled.catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
}
