import { describe, it, expect } from 'vitest';
import {
  blockNoteToMarkdown,
  markdownToBlockNote,
  inlineToMarkdown,
  parseInlineMarkdown,
  descriptionToMarkdown,
  markdownToDescription,
} from '../src/converters.js';

// --- Helper to make a block quickly ---
function makeBlock(type, text, props = {}, children = []) {
  return {
    type,
    props: {
      backgroundColor: 'default',
      textColor: 'default',
      textAlignment: 'left',
      ...props,
    },
    content: [{ type: 'text', text, styles: {} }],
    children,
  };
}

describe('inlineToMarkdown', () => {
  it('returns empty string for null/undefined', () => {
    expect(inlineToMarkdown(null)).toBe('');
    expect(inlineToMarkdown(undefined)).toBe('');
  });

  it('converts plain text', () => {
    const content = [{ type: 'text', text: 'hello', styles: {} }];
    expect(inlineToMarkdown(content)).toBe('hello');
  });

  it('converts bold text', () => {
    const content = [{ type: 'text', text: 'bold', styles: { bold: true } }];
    expect(inlineToMarkdown(content)).toBe('**bold**');
  });

  it('converts italic text', () => {
    const content = [{ type: 'text', text: 'italic', styles: { italic: true } }];
    expect(inlineToMarkdown(content)).toBe('*italic*');
  });

  it('converts strikethrough text', () => {
    const content = [{ type: 'text', text: 'strike', styles: { strikethrough: true } }];
    expect(inlineToMarkdown(content)).toBe('~~strike~~');
  });

  it('converts code text', () => {
    const content = [{ type: 'text', text: 'code', styles: { code: true } }];
    expect(inlineToMarkdown(content)).toBe('`code`');
  });

  it('handles multiple inline segments', () => {
    const content = [
      { type: 'text', text: 'normal ', styles: {} },
      { type: 'text', text: 'bold', styles: { bold: true } },
      { type: 'text', text: ' end', styles: {} },
    ];
    expect(inlineToMarkdown(content)).toBe('normal **bold** end');
  });
});

describe('parseInlineMarkdown', () => {
  it('parses plain text', () => {
    const result = parseInlineMarkdown('hello world');
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe('hello world');
    expect(result[0].styles).toEqual({});
  });

  it('parses bold text', () => {
    const result = parseInlineMarkdown('**bold**');
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe('bold');
    expect(result[0].styles.bold).toBe(true);
  });

  it('parses italic text', () => {
    const result = parseInlineMarkdown('*italic*');
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe('italic');
    expect(result[0].styles.italic).toBe(true);
  });

  it('parses mixed inline styles', () => {
    const result = parseInlineMarkdown('hello **bold** world');
    expect(result.length).toBeGreaterThanOrEqual(3);
    expect(result[1].text).toBe('bold');
    expect(result[1].styles.bold).toBe(true);
  });
});

describe('blockNoteToMarkdown', () => {
  it('returns empty string for null/empty', () => {
    expect(blockNoteToMarkdown(null)).toBe('');
    expect(blockNoteToMarkdown([])).toBe('');
  });

  it('converts a paragraph', () => {
    const blocks = [makeBlock('paragraph', 'Hello world')];
    expect(blockNoteToMarkdown(blocks)).toBe('Hello world');
  });

  it('converts a heading', () => {
    const blocks = [makeBlock('heading', 'Title', { level: 2 })];
    expect(blockNoteToMarkdown(blocks)).toBe('## Title');
  });

  it('converts bullet list items', () => {
    const blocks = [
      makeBlock('bulletListItem', 'Item 1'),
      makeBlock('bulletListItem', 'Item 2'),
    ];
    expect(blockNoteToMarkdown(blocks)).toBe('- Item 1\n- Item 2');
  });

  it('converts numbered list items', () => {
    const blocks = [
      makeBlock('numberedListItem', 'First'),
      makeBlock('numberedListItem', 'Second'),
    ];
    expect(blockNoteToMarkdown(blocks)).toBe('1. First\n1. Second');
  });

  it('converts check list items', () => {
    const blocks = [
      makeBlock('checkListItem', 'Done', { checked: true }),
      makeBlock('checkListItem', 'Not done', { checked: false }),
    ];
    expect(blockNoteToMarkdown(blocks)).toBe('- [x] Done\n- [ ] Not done');
  });

  it('converts nested children with indentation', () => {
    const blocks = [
      makeBlock('bulletListItem', 'Parent', {}, [
        makeBlock('bulletListItem', 'Child 1'),
        makeBlock('bulletListItem', 'Child 2'),
      ]),
    ];
    const md = blockNoteToMarkdown(blocks);
    expect(md).toBe('- Parent\n  - Child 1\n  - Child 2');
  });

  it('converts deeply nested children', () => {
    const blocks = [
      makeBlock('bulletListItem', 'Level 0', {}, [
        makeBlock('bulletListItem', 'Level 1', {}, [
          makeBlock('bulletListItem', 'Level 2'),
        ]),
      ]),
    ];
    const md = blockNoteToMarkdown(blocks);
    expect(md).toBe('- Level 0\n  - Level 1\n    - Level 2');
  });
});

describe('markdownToBlockNote', () => {
  it('returns empty array for null/empty', () => {
    expect(markdownToBlockNote(null)).toEqual([]);
    expect(markdownToBlockNote('')).toEqual([]);
  });

  it('parses a paragraph', () => {
    const blocks = markdownToBlockNote('Hello world');
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('paragraph');
    expect(blocks[0].content[0].text).toBe('Hello world');
  });

  it('parses headings', () => {
    const blocks = markdownToBlockNote('## My Heading');
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('heading');
    expect(blocks[0].props.level).toBe(2);
    expect(blocks[0].content[0].text).toBe('My Heading');
  });

  it('parses bullet list items', () => {
    const blocks = markdownToBlockNote('- Item 1\n- Item 2');
    expect(blocks).toHaveLength(2);
    expect(blocks[0].type).toBe('bulletListItem');
    expect(blocks[1].type).toBe('bulletListItem');
  });

  it('parses numbered list items', () => {
    const blocks = markdownToBlockNote('1. First\n2. Second');
    expect(blocks).toHaveLength(2);
    expect(blocks[0].type).toBe('numberedListItem');
    expect(blocks[0].content[0].text).toBe('First');
  });

  it('parses check list items', () => {
    const blocks = markdownToBlockNote('- [x] Done\n- [ ] Todo');
    expect(blocks).toHaveLength(2);
    expect(blocks[0].type).toBe('checkListItem');
    expect(blocks[0].props.checked).toBe(true);
    expect(blocks[1].type).toBe('checkListItem');
    expect(blocks[1].props.checked).toBe(false);
  });

  it('parses indented lines as nested children (POC fix)', () => {
    const md = '- Parent\n  - Child 1\n  - Child 2';
    const blocks = markdownToBlockNote(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('bulletListItem');
    expect(blocks[0].content[0].text).toBe('Parent');
    expect(blocks[0].children).toHaveLength(2);
    expect(blocks[0].children[0].type).toBe('bulletListItem');
    expect(blocks[0].children[0].content[0].text).toBe('Child 1');
    expect(blocks[0].children[1].content[0].text).toBe('Child 2');
  });

  it('parses deeply nested indentation', () => {
    const md = '- Level 0\n  - Level 1\n    - Level 2';
    const blocks = markdownToBlockNote(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].children).toHaveLength(1);
    expect(blocks[0].children[0].children).toHaveLength(1);
    expect(blocks[0].children[0].children[0].content[0].text).toBe('Level 2');
  });
});

describe('round-trip conversion', () => {
  it('preserves flat structure', () => {
    const md = '# Title\n\nSome paragraph\n\n- Item 1\n- Item 2';
    const blocks = markdownToBlockNote(md);
    const result = blockNoteToMarkdown(blocks);
    expect(result).toBe(md);
  });

  it('preserves nested bullet lists', () => {
    const md = '- Parent\n  - Child A\n  - Child B';
    const blocks = markdownToBlockNote(md);
    const result = blockNoteToMarkdown(blocks);
    expect(result).toBe(md);
  });

  it('preserves deeply nested structure', () => {
    const md = '- L0\n  - L1\n    - L2';
    const blocks = markdownToBlockNote(md);
    const result = blockNoteToMarkdown(blocks);
    expect(result).toBe(md);
  });

  it('preserves check list items through round-trip', () => {
    const md = '- [x] Done\n- [ ] Todo';
    const blocks = markdownToBlockNote(md);
    const result = blockNoteToMarkdown(blocks);
    expect(result).toBe(md);
  });

  it('preserves heading levels', () => {
    const md = '# H1\n## H2\n### H3';
    const blocks = markdownToBlockNote(md);
    const result = blockNoteToMarkdown(blocks);
    expect(result).toBe(md);
  });

  it('preserves inline styles through round-trip', () => {
    const md = '**bold** and *italic*';
    const blocks = markdownToBlockNote(md);
    const result = blockNoteToMarkdown(blocks);
    expect(result).toBe(md);
  });
});

describe('descriptionToMarkdown', () => {
  it('returns empty string for null', () => {
    expect(descriptionToMarkdown(null)).toBe('');
  });

  it('parses JSON string description', () => {
    const blocks = [makeBlock('paragraph', 'Hello')];
    const json = JSON.stringify(blocks);
    expect(descriptionToMarkdown(json)).toBe('Hello');
  });

  it('accepts array directly', () => {
    const blocks = [makeBlock('paragraph', 'Direct')];
    expect(descriptionToMarkdown(blocks)).toBe('Direct');
  });

  it('returns raw string for invalid JSON', () => {
    expect(descriptionToMarkdown('not json')).toBe('not json');
  });
});

describe('markdownToDescription', () => {
  it('returns null for empty input', () => {
    expect(markdownToDescription(null)).toBeNull();
    expect(markdownToDescription('')).toBeNull();
  });

  it('returns valid JSON string', () => {
    const result = markdownToDescription('Hello world');
    const parsed = JSON.parse(result);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].type).toBe('paragraph');
  });
});
