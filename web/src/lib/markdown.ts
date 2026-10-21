/**
 * The small slice of Markdown the model writes in summaries and findings: paragraphs,
 * bullet and numbered lists, headings, **bold** and `code`. Parsed into plain data that
 * components render as React elements, so model text can never become HTML.
 */

export type Inline =
  | { type: 'text'; text: string }
  | { type: 'strong'; children: Inline[] }
  | { type: 'code'; text: string };

export type Block =
  | { type: 'p'; lines: Inline[][] }
  | { type: 'ul'; items: Inline[][] }
  | { type: 'ol'; start: number; items: Inline[][] };

const BULLET = /^\s*[-*]\s+(.*)$/;
const NUMBERED = /^\s*(\d+)[.)]\s+(.*)$/;
const HEADING = /^\s*#{1,6}\s+(.*)$/;

export function parseInline(s: string): Inline[] {
  const out: Inline[] = [];
  let text = '';
  const flush = () => {
    if (text) out.push({ type: 'text', text });
    text = '';
  };

  let i = 0;
  while (i < s.length) {
    if (s[i] === '`') {
      const end = s.indexOf('`', i + 1);
      if (end > i + 1) {
        flush();
        out.push({ type: 'code', text: s.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    if (s.startsWith('**', i)) {
      const end = closingBold(s, i + 2);
      if (end > i + 2) {
        flush();
        out.push({ type: 'strong', children: parseInline(s.slice(i + 2, end)) });
        i = end + 2;
        continue;
      }
    }
    text += s[i];
    i++;
  }
  flush();
  return out;
}

/** Index of the `**` closing a bold span that opened before `from`, skipping code spans; -1 if none. */
function closingBold(s: string, from: number): number {
  for (let i = from; i < s.length; i++) {
    if (s[i] === '`') {
      const end = s.indexOf('`', i + 1);
      if (end > i) i = end;
    } else if (s.startsWith('**', i)) {
      return i;
    }
  }
  return -1;
}

export function parseBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  let current: Block | null = null;
  const close = () => {
    if (current) blocks.push(current);
    current = null;
  };

  for (const line of text.split('\n')) {
    if (line.trim() === '') {
      close();
      continue;
    }
    const bullet = BULLET.exec(line);
    const numbered = NUMBERED.exec(line);
    const heading = HEADING.exec(line);
    if (bullet) {
      if (current?.type !== 'ul') close();
      current ??= { type: 'ul', items: [] };
      (current as Extract<Block, { type: 'ul' }>).items.push(parseInline(bullet[1]!));
    } else if (numbered) {
      if (current?.type !== 'ol') close();
      current ??= { type: 'ol', start: Number(numbered[1]), items: [] };
      (current as Extract<Block, { type: 'ol' }>).items.push(parseInline(numbered[2]!));
    } else if (heading) {
      close();
      blocks.push({ type: 'p', lines: [[{ type: 'strong', children: parseInline(heading[1]!) }]] });
    } else if (current && current.type !== 'p' && /^\s/.test(line)) {
      // An indented line under a list item continues that item.
      const items: Inline[][] = current.items;
      items[items.length - 1] = parseInline(`${plainSource(items.at(-1)!)} ${line.trim()}`);
    } else {
      if (current?.type !== 'p') close();
      current ??= { type: 'p', lines: [] };
      (current as Extract<Block, { type: 'p' }>).lines.push(parseInline(line));
    }
  }
  close();
  return blocks;
}

/** Inline nodes back to their Markdown source, so a continuation line can be re-parsed with its item. */
function plainSource(nodes: Inline[]): string {
  return nodes
    .map((n) => (n.type === 'text' ? n.text : n.type === 'code' ? `\`${n.text}\`` : `**${plainSource(n.children)}**`))
    .join('');
}

/** The text with bold and code markers removed, for one-line previews. */
export function plainText(s: string): string {
  const strip = (nodes: Inline[]): string =>
    nodes.map((n) => (n.type === 'strong' ? strip(n.children) : n.text)).join('');
  return strip(parseInline(s));
}
