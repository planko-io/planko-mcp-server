/**
 * BlockNote <-> Markdown converters.
 *
 * Key fix from POC: markdownToBlockNote handles indented lines as nested
 * children instead of flattening them into top-level paragraphs.
 */

// --- BlockNote -> Markdown ---

export function inlineToMarkdown(content) {
  if (!content || !Array.isArray(content)) return '';
  return content
    .map((item) => {
      let text = item.text || '';
      if (!text) return '';
      const s = item.styles || {};
      if (s.code) text = `\`${text}\``;
      if (s.strikethrough) text = `~~${text}~~`;
      if (s.italic) text = `*${text}*`;
      if (s.bold) text = `**${text}**`;
      return text;
    })
    .join('');
}

export function blockNoteToMarkdown(blocks, indent = 0) {
  if (!blocks || !Array.isArray(blocks)) return '';
  const prefix = '  '.repeat(indent);
  const lines = [];

  for (const block of blocks) {
    const text = inlineToMarkdown(block.content);

    switch (block.type) {
      case 'heading': {
        const level = block.props?.level || 1;
        lines.push(`${prefix}${'#'.repeat(level)} ${text}`);
        break;
      }
      case 'bulletListItem':
        lines.push(`${prefix}- ${text}`);
        break;
      case 'numberedListItem':
        lines.push(`${prefix}1. ${text}`);
        break;
      case 'checkListItem': {
        const checked = block.props?.checked ? 'x' : ' ';
        lines.push(`${prefix}- [${checked}] ${text}`);
        break;
      }
      case 'paragraph':
      default:
        lines.push(`${prefix}${text}`);
        break;
    }

    if (block.children && block.children.length > 0) {
      const childMd = blockNoteToMarkdown(block.children, indent + 1);
      lines.push(childMd);
    }
  }

  return lines.join('\n');
}

// --- Markdown -> BlockNote ---

export function parseInlineMarkdown(text) {
  const content = [];
  // Order: bold (**), italic (*), strikethrough (~~), code (`)
  const regex = /(\*\*(.+?)\*\*|\*(.+?)\*|~~(.+?)~~|`(.+?)`|([^*~`]+))/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    if (match[2]) {
      content.push({ type: 'text', text: match[2], styles: { bold: true } });
    } else if (match[3]) {
      content.push({ type: 'text', text: match[3], styles: { italic: true } });
    } else if (match[4]) {
      content.push({
        type: 'text',
        text: match[4],
        styles: { strikethrough: true },
      });
    } else if (match[5]) {
      content.push({ type: 'text', text: match[5], styles: { code: true } });
    } else if (match[6]) {
      content.push({ type: 'text', text: match[6], styles: {} });
    }
  }
  return content.length > 0 ? content : [{ type: 'text', text, styles: {} }];
}

function makeBlock(type, text, props = {}) {
  return {
    type,
    props: {
      backgroundColor: 'default',
      textColor: 'default',
      textAlignment: 'left',
      ...props,
    },
    content: parseInlineMarkdown(text),
    children: [],
  };
}

/**
 * Determine the indentation level of a line (number of 2-space indents).
 */
function indentLevel(line) {
  const match = line.match(/^( *)/);
  if (!match) return 0;
  return Math.floor(match[1].length / 2);
}

/**
 * Parse a trimmed line into a block (without children).
 */
function parseLine(trimmed) {
  const headingMatch = trimmed.match(/^(#{1,6})\s+(.*)$/);
  if (headingMatch) {
    return makeBlock('heading', headingMatch[2], {
      level: headingMatch[1].length,
      isToggleable: false,
    });
  }

  const checkMatch = trimmed.match(/^-\s+\[([ xX])\]\s+(.*)$/);
  if (checkMatch) {
    return makeBlock('checkListItem', checkMatch[2], {
      checked: checkMatch[1] !== ' ',
    });
  }

  const bulletMatch = trimmed.match(/^-\s+(.*)$/);
  if (bulletMatch) {
    return makeBlock('bulletListItem', bulletMatch[1]);
  }

  const numberedMatch = trimmed.match(/^\d+\.\s+(.*)$/);
  if (numberedMatch) {
    return makeBlock('numberedListItem', numberedMatch[1]);
  }

  return makeBlock('paragraph', trimmed);
}

/**
 * Convert markdown string to BlockNote blocks, preserving nesting.
 *
 * Indented lines (2-space increments) become children of the preceding
 * block at the parent indent level. This fixes the POC which flattened
 * all lines into top-level blocks.
 */
export function markdownToBlockNote(md) {
  if (!md) return [];
  const lines = md.split('\n');

  // Recursive helper: parse lines[start..end) at the given base indent level.
  function parseRange(start, end, baseIndent) {
    const blocks = [];
    let i = start;

    while (i < end) {
      const line = lines[i];
      const level = indentLevel(line);
      const trimmed = line.trimStart();

      if (trimmed === '') {
        // Empty lines become empty paragraphs at base level
        blocks.push(makeBlock('paragraph', ''));
        i++;
        continue;
      }

      if (level < baseIndent) {
        // Shouldn't happen in well-formed input, but handle gracefully
        break;
      }

      if (level > baseIndent) {
        // This line is indented deeper than expected — attach as children
        // of the last block at baseIndent level.
        const childStart = i;
        while (i < end) {
          const currentTrimmed = lines[i].trim();
          const currentLevel = currentTrimmed === '' ? -1 : indentLevel(lines[i]);

          if (currentTrimmed === '') {
            // Blank line: look ahead to determine if nesting continues
            let nextNonBlank = i + 1;
            while (nextNonBlank < end && lines[nextNonBlank].trim() === '') nextNonBlank++;
            if (nextNonBlank >= end || indentLevel(lines[nextNonBlank]) <= baseIndent) {
              break; // blank line(s) followed by non-indented or EOF = end of nesting
            }
            i++; // blank line within nested content — include it
          } else if (currentLevel <= baseIndent) {
            break; // back to parent level
          } else {
            i++;
          }
        }

        if (blocks.length > 0) {
          blocks[blocks.length - 1].children = parseRange(childStart, i, baseIndent + 1);
        } else {
          // No parent block — create blocks at the deeper level as top-level
          const deeper = parseRange(childStart, i, level);
          blocks.push(...deeper);
        }
        continue;
      }

      // level === baseIndent
      blocks.push(parseLine(trimmed));
      i++;
    }

    return blocks;
  }

  return parseRange(0, lines.length, 0);
}

// --- Convenience helpers ---

export function descriptionToMarkdown(description) {
  if (!description) return '';
  try {
    const blocks =
      typeof description === 'string' ? JSON.parse(description) : description;
    return blockNoteToMarkdown(blocks);
  } catch (_) {
    return typeof description === 'string' ? description : '';
  }
}

export function markdownToDescription(md) {
  if (!md) return null;
  const blocks = markdownToBlockNote(md);
  return JSON.stringify(blocks);
}
