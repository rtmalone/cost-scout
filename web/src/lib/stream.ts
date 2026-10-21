import type { RunEvent } from '../../../src/ui/events.ts';

/** Read a newline-delimited JSON stream, calling onEvent for each line as soon as it is complete. */
export async function readNdjson(
  body: ReadableStream<Uint8Array>,
  onEvent: (e: RunEvent) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const flush = (line: string) => {
    if (line.trim()) onEvent(JSON.parse(line) as RunEvent);
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    lines.forEach(flush);
  }
  buffer += decoder.decode();
  flush(buffer);
}
