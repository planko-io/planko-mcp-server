/**
 * Pure helpers for the list/view tools: type labels, kanban board/column name
 * resolution, item rendering and the tasks+notes merge behind planko_list_all.
 * No I/O here so everything is unit-testable; index.js wires them in.
 */

import { isBlankValue } from './sanitize.js';
import { ownerName } from './projectLock.js';
import { descriptionToMarkdown } from './converters.js';

export const TYPE_TASK = 1;
export const TYPE_NOTE = 2;
export const TYPE_STICKY = 3;

const TYPE_LABEL = { 1: 'task', 2: 'note', 3: 'sticky note' };

/** Human label for a Task.type code. */
export function typeLabel(type) {
  return TYPE_LABEL[type] || 'task';
}

const STATUS_LABEL = { 1: 'open', 2: 'complete' };

/** Human label for a status code. */
export function statusLabel(status) {
  return STATUS_LABEL[status] || (status == null ? 'unknown' : String(status));
}

/** Render a task/note's tags as a comma list of names (fallback to ids). */
export function formatTags(tags) {
  if (!Array.isArray(tags) || tags.length === 0) return null;
  return tags
    .map((t) => (t && typeof t === 'object' ? t.name || t._id : t))
    .filter(Boolean)
    .join(', ');
}

/**
 * Name of a populated reference ({ _id, name }) or null. A bare id string
 * (reference not populated, or the board/column no longer exists) yields null
 * so callers can fall back to the id.
 */
export function refName(ref) {
  if (ref && typeof ref === 'object' && !Array.isArray(ref) && typeof ref.name === 'string') {
    return ref.name.trim() || null;
  }
  return null;
}

/** Comparable id string of a bare id or populated reference. */
export function refId(ref) {
  if (ref && typeof ref === 'object') return ref._id != null ? String(ref._id) : ref.id != null ? String(ref.id) : '';
  return ref != null ? String(ref) : '';
}

/** Board label for output: name, else the id. */
export function boardLabel(item) {
  return refName(item.boardId) || (item.boardId ? refId(item.boardId) : null);
}

/** Column label for output: name, else the id. */
export function columnLabel(item) {
  return refName(item.kanbanColumnId) || (item.kanbanColumnId ? refId(item.kanbanColumnId) : null);
}

/** Flatten the /boards response ({ personal, workspace }) into one array. */
export function flattenBoards(res) {
  const personal = Array.isArray(res?.personal) ? res.personal : [];
  const workspace = Array.isArray(res?.workspace) ? res.workspace : [];
  return [...personal, ...workspace];
}

function boardIdOf(b) {
  return refId(b);
}

function normalize(s) {
  return String(s).trim().toLowerCase();
}

function boardSummary(boards) {
  return boards
    .map((b) => {
      const cols = (b.columns || []).map((c) => c.name).join(', ');
      return `  - ${b.name}${b.ownerType === 'workspace' ? ' (workspace)' : ''}${cols ? `: ${cols}` : ''}`;
    })
    .join('\n');
}

/**
 * Resolve board/column NAMES to ids against the caller's boards.
 *
 * Returns { boardId, kanbanColumnId } with only the keys that resolved. Rules:
 *  - an explicit id wins over a name for the same field;
 *  - boardName must match exactly one board (case-insensitive); otherwise an
 *    Error listing the available boards;
 *  - kanbanColumnName resolves inside the resolved board when there is one.
 *    Without a board it must be unique across ALL boards — default column
 *    names ("To Do", "Done") repeat on every board, so an ambiguous name is an
 *    Error listing "board › column" candidates rather than a silent guess.
 */
export function resolveBoardFilters(params, boards) {
  const out = {};
  const all = flattenBoards(boards);
  const wantBoardName = !isBlankValue(params.boardName) && isBlankValue(params.boardId);
  const wantColumnName = !isBlankValue(params.kanbanColumnName) && isBlankValue(params.kanbanColumnId);

  if (!isBlankValue(params.boardId)) out.boardId = params.boardId;
  if (!isBlankValue(params.kanbanColumnId)) out.kanbanColumnId = params.kanbanColumnId;
  if (!wantBoardName && !wantColumnName) return out;

  let board = null;
  if (wantBoardName) {
    const needle = normalize(params.boardName);
    const matches = all.filter((b) => normalize(b.name) === needle);
    if (matches.length !== 1) {
      const why = matches.length === 0 ? 'not found' : 'matches more than one board';
      throw new Error(
        `Board "${params.boardName}" ${why}.\n\nAvailable boards:\n${boardSummary(all) || '  (none)'}`
      );
    }
    [board] = matches;
    out.boardId = boardIdOf(board);
  } else if (!isBlankValue(params.boardId)) {
    board = all.find((b) => boardIdOf(b) === String(params.boardId)) || null;
    if (!board) {
      throw new Error(
        `Board id "${params.boardId}" is not one of your boards.\n\nAvailable boards:\n${boardSummary(all) || '  (none)'}`
      );
    }
  }

  if (wantColumnName) {
    const needle = normalize(params.kanbanColumnName);
    const scope = board ? [board] : all;
    const candidates = [];
    for (const b of scope) {
      for (const c of b.columns || []) {
        if (normalize(c.name) === needle) candidates.push({ board: b, column: c });
      }
    }
    if (candidates.length === 0) {
      const where = board ? ` on board "${board.name}"` : '';
      throw new Error(
        `Column "${params.kanbanColumnName}" not found${where}.\n\nAvailable boards and columns:\n${boardSummary(scope) || '  (none)'}`
      );
    }
    if (candidates.length > 1) {
      const list = candidates.map((c) => `  - ${c.board.name} › ${c.column.name}`).join('\n');
      throw new Error(
        `Column "${params.kanbanColumnName}" exists on more than one board — also pass boardName to disambiguate:\n${list}`
      );
    }
    out.kanbanColumnId = refId(candidates[0].column);
    if (!out.boardId) out.boardId = boardIdOf(candidates[0].board);
  }

  return out;
}

/** One concise summary line per item for list output. */
export function summarizeItem(item, index) {
  const parts = [];
  parts.push(`type: ${typeLabel(item.type)}`);
  parts.push(`status: ${statusLabel(item.status)}`);
  if (item.priority != null) parts.push(`priority: ${item.priority}`);
  if (item.dueDate) parts.push(`due: ${item.dueDate}${item.time ? ` ${item.time}` : ''}`);
  else if (item.datePlain) parts.push(`due: ${item.datePlain}${item.time ? ` ${item.time}` : ''}`);
  const tagStr = formatTags(item.tags);
  if (tagStr) parts.push(`tags: ${tagStr}`);
  const board = boardLabel(item);
  if (board) parts.push(`board: ${board}`);
  const column = columnLabel(item);
  if (column) parts.push(`column: ${column}`);
  if (item.projectId) parts.push(`project: ${refId(item.projectId)}`);
  const owner = ownerName(item.userId);
  if (owner) parts.push(`owner: ${owner}`);
  return (
    `${index}. ${item.name || '(untitled)'} [id: ${item._id ?? item.id}]\n` +
    `   ${parts.join(' | ')}`
  );
}

/** Render a list response as a concise, readable summary (not raw JSON). */
export function renderList(result, kindLabelPlural) {
  const tasks = Array.isArray(result?.tasks) ? result.tasks : [];
  const total = result?.total ?? tasks.length;
  const page = result?.page ?? 1;
  const limit = result?.limit ?? tasks.length;

  if (tasks.length === 0) {
    return `No ${kindLabelPlural} found (total: ${total}, page ${page}).`;
  }

  const lines = tasks.map((t, i) => summarizeItem(t, i + 1));
  const footer = `\nShowing ${tasks.length} of ${total} ${kindLabelPlural} (page ${page}, limit ${limit}).`;
  return `${lines.join('\n')}\n${footer}`;
}

/** Render one item's full detail with the description converted to Markdown. */
export function renderItem(item) {
  const lines = [];
  lines.push(`${item.name || '(untitled)'}`);
  lines.push(`id: ${item._id ?? item.id}`);
  lines.push(`type: ${typeLabel(item.type)}`);
  lines.push(`status: ${statusLabel(item.status)}`);
  if (item.priority != null) lines.push(`priority: ${item.priority}`);
  if (item.dueDate) lines.push(`due: ${item.dueDate}${item.time ? ` ${item.time}` : ''}`);
  else if (item.datePlain) lines.push(`due: ${item.datePlain}${item.time ? ` ${item.time}` : ''}`);
  const tagStr = formatTags(item.tags);
  if (tagStr) lines.push(`tags: ${tagStr}`);
  const board = boardLabel(item);
  if (board) lines.push(`board: ${board}`);
  const column = columnLabel(item);
  if (column) lines.push(`column: ${column}`);
  if (item.projectId) lines.push(`project: ${refId(item.projectId)}`);
  const owner = ownerName(item.userId);
  if (owner) lines.push(`owner: ${owner}`);
  if (item.parentId) lines.push(`parent: ${item.parentId}`);
  if (item.createdAt) lines.push(`created: ${item.createdAt}`);
  if (item.updatedAt) lines.push(`updated: ${item.updatedAt}`);

  const md = descriptionToMarkdown(item.description);
  lines.push('');
  lines.push('--- description ---');
  lines.push(md && md.trim() ? md : '(empty)');
  return lines.join('\n');
}

const SORTABLE_FIELDS = new Set(['dueDate', 'createdAt', 'updatedAt', 'priority', 'position', 'name']);
const DATE_FIELDS = new Set(['dueDate', 'createdAt', 'updatedAt']);

/** Parse 'field:dir' with the backend's whitelist; default updatedAt:desc. */
export function parseSort(sortBy) {
  if (typeof sortBy === 'string' && sortBy.includes(':')) {
    const [field, dir] = sortBy.split(':');
    if (SORTABLE_FIELDS.has(field)) return { field, dir: dir === 'asc' ? 'asc' : 'desc' };
  }
  return { field: 'updatedAt', dir: 'desc' };
}

function sortValue(item, field) {
  const v = item?.[field];
  if (v == null) return null;
  if (DATE_FIELDS.has(field)) {
    const t = new Date(v).getTime();
    return Number.isNaN(t) ? null : t;
  }
  return v;
}

function compareBy({ field, dir }) {
  const sign = dir === 'asc' ? 1 : -1;
  return (a, b) => {
    const va = sortValue(a, field);
    const vb = sortValue(b, field);
    if (va === vb) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    if (typeof va === 'string' || typeof vb === 'string') return sign * String(va).localeCompare(String(vb));
    return sign * (va < vb ? -1 : 1);
  };
}

/**
 * Merge the two backend windows behind planko_list_all (tasks+sticky notes,
 * and notes) into one list. Each input is a page-1 window of `limit` items
 * sorted by `sortBy` on the server; the union is re-sorted by the same key and
 * cut to `limit`. Missing values sort last regardless of direction.
 */
export function mergeAllLists(taskRes, noteRes, limit, sortBy) {
  const tasks = Array.isArray(taskRes?.tasks) ? taskRes.tasks : [];
  const notes = Array.isArray(noteRes?.tasks) ? noteRes.tasks : [];
  const sort = parseSort(sortBy);
  const merged = [...tasks, ...notes].sort(compareBy(sort)).slice(0, limit);
  return {
    tasks: merged,
    totals: { tasksAndStickyNotes: taskRes?.total ?? tasks.length, notes: noteRes?.total ?? notes.length },
    limit,
    sort,
  };
}

/** Render the merged planko_list_all result. */
export function renderAll(merged) {
  const { tasks, totals, limit, sort } = merged;
  const total = totals.tasksAndStickyNotes + totals.notes;
  if (tasks.length === 0) {
    return `No items found (tasks + sticky notes: ${totals.tasksAndStickyNotes}, notes: ${totals.notes}).`;
  }
  const lines = tasks.map((t, i) => summarizeItem(t, i + 1));
  const footer =
    `\nShowing ${tasks.length} of ${total} items, ordered by ${sort.field}:${sort.dir}, limit ${limit} ` +
    `(tasks + sticky notes: ${totals.tasksAndStickyNotes}, notes: ${totals.notes}). ` +
    `Use planko_list_tasks / planko_list_notes / planko_list_sticky_notes to page through one kind.`;
  return `${lines.join('\n')}\n${footer}`;
}
