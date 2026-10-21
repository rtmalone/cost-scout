import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseBlocks, parseInline, plainText } from '../web/src/lib/markdown.ts';

describe('parseInline', () => {
  it('reads bold and inline code', () => {
    assert.deepEqual(parseInline('**Idle:** `analytics-scratch-disk` is unattached'), [
      { type: 'strong', children: [{ type: 'text', text: 'Idle:' }] },
      { type: 'text', text: ' ' },
      { type: 'code', text: 'analytics-scratch-disk' },
      { type: 'text', text: ' is unattached' },
    ]);
  });

  it('keeps code inside bold', () => {
    assert.deepEqual(parseInline('**`vm-01` is busy**'), [
      {
        type: 'strong',
        children: [
          { type: 'code', text: 'vm-01' },
          { type: 'text', text: ' is busy' },
        ],
      },
    ]);
  });

  it('does not read markers inside code', () => {
    assert.deepEqual(parseInline('run `a **b** c` now'), [
      { type: 'text', text: 'run ' },
      { type: 'code', text: 'a **b** c' },
      { type: 'text', text: ' now' },
    ]);
  });

  it('leaves unmatched markers as text', () => {
    assert.deepEqual(parseInline('2 ** 3 and a ` tick'), [{ type: 'text', text: '2 ** 3 and a ` tick' }]);
  });

  it('keeps CLI flags and HTML-looking text as plain text', () => {
    assert.deepEqual(parseInline('az disk delete --yes <b>x</b>'), [
      { type: 'text', text: 'az disk delete --yes <b>x</b>' },
    ]);
  });
});

describe('parseBlocks', () => {
  it('splits paragraphs on blank lines and keeps line breaks inside one', () => {
    const blocks = parseBlocks('First line\nsecond line\n\nNext paragraph');
    assert.deepEqual(blocks, [
      { type: 'p', lines: [[{ type: 'text', text: 'First line' }], [{ type: 'text', text: 'second line' }]] },
      { type: 'p', lines: [[{ type: 'text', text: 'Next paragraph' }]] },
    ]);
  });

  it('reads bullet lists, including a list right after a paragraph line', () => {
    const blocks = parseBlocks('Findings:\n- **Idle:** disk\n* second\n  wraps here');
    assert.deepEqual(blocks, [
      { type: 'p', lines: [[{ type: 'text', text: 'Findings:' }]] },
      {
        type: 'ul',
        items: [
          [
            { type: 'strong', children: [{ type: 'text', text: 'Idle:' }] },
            { type: 'text', text: ' disk' },
          ],
          [{ type: 'text', text: 'second wraps here' }],
        ],
      },
    ]);
  });

  it('reads numbered lists and keeps their start number', () => {
    assert.deepEqual(parseBlocks('3. snapshot\n4) delete'), [
      {
        type: 'ol',
        start: 3,
        items: [[{ type: 'text', text: 'snapshot' }], [{ type: 'text', text: 'delete' }]],
      },
    ]);
  });

  it('turns a heading into a bold paragraph', () => {
    assert.deepEqual(parseBlocks('## Summary'), [
      { type: 'p', lines: [[{ type: 'strong', children: [{ type: 'text', text: 'Summary' }] }]] },
    ]);
  });

  it('returns nothing for blank text', () => {
    assert.deepEqual(parseBlocks('  \n\n'), []);
  });
});

describe('plainText', () => {
  it('strips the markers for one-line previews', () => {
    assert.equal(plainText('**Idle:** `disk-1` is unattached'), 'Idle: disk-1 is unattached');
  });
});
