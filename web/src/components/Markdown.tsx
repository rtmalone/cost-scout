import { Fragment } from 'react';
import { parseBlocks, parseInline, type Inline } from '../lib/markdown.ts';

/** Renders parsed nodes as React elements only, so model text is never treated as HTML. */
function Nodes({ nodes }: { nodes: Inline[] }) {
  return (
    <>
      {nodes.map((n, i) =>
        n.type === 'text' ? (
          <Fragment key={i}>{n.text}</Fragment>
        ) : n.type === 'code' ? (
          <code key={i}>{n.text}</code>
        ) : (
          <strong key={i}>
            <Nodes nodes={n.children} />
          </strong>
        ),
      )}
    </>
  );
}

/** One line of model text with **bold** and `code`. */
export function InlineMarkdown({ text }: { text: string }) {
  return <Nodes nodes={parseInline(text)} />;
}

/** Model text with paragraphs and lists as well. */
export function Markdown({ text, className, role }: { text: string; className?: string; role?: string }) {
  return (
    <div className={className ? `md ${className}` : 'md'} role={role}>
      {parseBlocks(text).map((b, i) =>
        b.type === 'p' ? (
          <p key={i}>
            {b.lines.map((line, j) => (
              <Fragment key={j}>
                {j > 0 && <br />}
                <Nodes nodes={line} />
              </Fragment>
            ))}
          </p>
        ) : b.type === 'ul' ? (
          <ul key={i}>
            {b.items.map((item, j) => (
              <li key={j}>
                <Nodes nodes={item} />
              </li>
            ))}
          </ul>
        ) : (
          <ol key={i} start={b.start}>
            {b.items.map((item, j) => (
              <li key={j}>
                <Nodes nodes={item} />
              </li>
            ))}
          </ol>
        ),
      )}
    </div>
  );
}
