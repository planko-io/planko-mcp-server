import { describe, it, expect } from 'vitest';
import {
  typeLabel,
  refName,
  refId,
  flattenBoards,
  resolveBoardFilters,
  summarizeItem,
  renderItem,
  renderList,
  mergeAllLists,
  renderAll,
  parseSort,
} from '../src/listing.js';

const B1 = '6742635e764bda007ab98701';
const B2 = '6742635e764bda007ab98702';
const C_TODO_1 = '6742635e764bda007ab98711';
const C_DONE_1 = '6742635e764bda007ab98712';
const C_TODO_2 = '6742635e764bda007ab98721';
const C_REVIEW_2 = '6742635e764bda007ab98722';

const boards = {
  personal: [
    {
      id: B1,
      name: 'Meu Kanban',
      ownerType: 'user',
      columns: [
        { id: C_TODO_1, name: 'To Do', type: 'To Do' },
        { id: C_DONE_1, name: 'Done', type: 'Done' },
      ],
    },
  ],
  workspace: [
    {
      id: B2,
      name: 'Time Planko',
      ownerType: 'workspace',
      columns: [
        { id: C_TODO_2, name: 'To Do', type: 'To Do' },
        { id: C_REVIEW_2, name: 'Review', type: 'In Progress' },
      ],
    },
  ],
};

describe('typeLabel', () => {
  it('labels 1/2/3 and falls back to task', () => {
    expect(typeLabel(1)).toBe('task');
    expect(typeLabel(2)).toBe('note');
    expect(typeLabel(3)).toBe('sticky note');
    expect(typeLabel(undefined)).toBe('task');
  });
});

describe('refName / refId', () => {
  it('reads a populated reference and tolerates bare ids', () => {
    expect(refName({ _id: B1, name: 'Meu Kanban' })).toBe('Meu Kanban');
    expect(refName(B1)).toBeNull();
    expect(refName(null)).toBeNull();
    expect(refId({ _id: B1 })).toBe(B1);
    expect(refId({ id: B1 })).toBe(B1);
    expect(refId(B1)).toBe(B1);
    expect(refId(null)).toBe('');
  });
});

describe('flattenBoards', () => {
  it('concatenates personal + workspace and tolerates a missing key', () => {
    expect(flattenBoards(boards).map((b) => b.name)).toEqual(['Meu Kanban', 'Time Planko']);
    expect(flattenBoards({ personal: [{ id: B1, name: 'x' }] })).toHaveLength(1);
    expect(flattenBoards(undefined)).toEqual([]);
  });
});

describe('resolveBoardFilters', () => {
  it('returns nothing when no board/column input is given', () => {
    expect(resolveBoardFilters({}, boards)).toEqual({});
    expect(resolveBoardFilters({ boardName: '', kanbanColumnName: '   ' }, boards)).toEqual({});
  });

  it('passes explicit ids through untouched', () => {
    expect(resolveBoardFilters({ boardId: B2, kanbanColumnId: C_REVIEW_2 }, boards)).toEqual({
      boardId: B2,
      kanbanColumnId: C_REVIEW_2,
    });
  });

  it('resolves a board by name, case-insensitive, and ignores blank ids', () => {
    expect(resolveBoardFilters({ boardName: 'time planko', boardId: '' }, boards)).toEqual({ boardId: B2 });
  });

  it('errors with the available boards when the board name is unknown', () => {
    expect(() => resolveBoardFilters({ boardName: 'Nope' }, boards)).toThrow(/not found[\s\S]*Meu Kanban[\s\S]*Time Planko \(workspace\)/);
  });

  it('resolves a column inside the named board even when the column name repeats elsewhere', () => {
    expect(resolveBoardFilters({ boardName: 'Meu Kanban', kanbanColumnName: 'to do' }, boards)).toEqual({
      boardId: B1,
      kanbanColumnId: C_TODO_1,
    });
  });

  it('resolves a column inside an explicit boardId', () => {
    expect(resolveBoardFilters({ boardId: B2, kanbanColumnName: 'To Do' }, boards)).toEqual({
      boardId: B2,
      kanbanColumnId: C_TODO_2,
    });
  });

  it('resolves a globally unique column name without a board and fills boardId', () => {
    expect(resolveBoardFilters({ kanbanColumnName: 'Review' }, boards)).toEqual({
      boardId: B2,
      kanbanColumnId: C_REVIEW_2,
    });
  });

  it('refuses to guess when a column name exists on more than one board', () => {
    expect(() => resolveBoardFilters({ kanbanColumnName: 'To Do' }, boards)).toThrow(
      /more than one board[\s\S]*Meu Kanban › To Do[\s\S]*Time Planko › To Do/
    );
  });

  it('errors when the column is not on the named board', () => {
    expect(() => resolveBoardFilters({ boardName: 'Meu Kanban', kanbanColumnName: 'Review' }, boards)).toThrow(
      /Column "Review" not found on board "Meu Kanban"/
    );
  });

  it('errors when an explicit boardId is not one of the caller boards (instead of a silent zero result)', () => {
    expect(() => resolveBoardFilters({ boardId: '6742635e764bda007ab98799', kanbanColumnName: 'Review' }, boards)).toThrow(
      /Board id "6742635e764bda007ab98799" is not one of your boards/
    );
  });

  it('an explicit kanbanColumnId wins over kanbanColumnName', () => {
    expect(resolveBoardFilters({ kanbanColumnId: C_DONE_1, kanbanColumnName: 'To Do' }, boards)).toEqual({
      kanbanColumnId: C_DONE_1,
    });
  });
});

describe('summarizeItem / renderItem', () => {
  const item = {
    _id: 'i1',
    name: 'Ship it',
    type: 3,
    status: 1,
    priority: 2,
    boardId: { _id: B1, name: 'Meu Kanban' },
    kanbanColumnId: { _id: C_TODO_1, name: 'To Do', type: 'To Do' },
    projectId: { _id: 'p1', name: 'Planko' },
    userId: { _id: 'u1', name: 'Ana', email: 'ana@planko.io' },
    tags: [{ _id: 't1', name: 'urgent' }],
  };

  it('summarizes with type, board and column names', () => {
    const out = summarizeItem(item, 1);
    expect(out).toContain('1. Ship it [id: i1]');
    expect(out).toContain('type: sticky note');
    expect(out).toContain('board: Meu Kanban');
    expect(out).toContain('column: To Do');
    expect(out).toContain('project: p1');
    expect(out).toContain('owner: Ana');
    expect(out).toContain('tags: urgent');
  });

  it('falls back to bare ids when board/column are not populated', () => {
    const out = summarizeItem({ ...item, boardId: B1, kanbanColumnId: C_TODO_1 }, 2);
    expect(out).toContain(`board: ${B1}`);
    expect(out).toContain(`column: ${C_TODO_1}`);
  });

  it('omits board/column when absent', () => {
    const out = summarizeItem({ _id: 'x', name: 'n', type: 1, status: 1 }, 1);
    expect(out).not.toContain('board:');
    expect(out).not.toContain('column:');
    expect(out).toContain('type: task');
  });

  it('renderItem labels the type by the item, not by the calling tool', () => {
    const out = renderItem({ ...item, type: 2, description: null });
    expect(out).toContain('type: note');
    expect(out).toContain('board: Meu Kanban');
    expect(out).toContain('--- description ---\n(empty)');
  });
});

describe('renderList', () => {
  it('reports an empty result with totals', () => {
    expect(renderList({ tasks: [], total: 0, page: 1 }, 'sticky notes')).toBe(
      'No sticky notes found (total: 0, page 1).'
    );
  });
});

describe('mergeAllLists / renderAll', () => {
  const taskRes = {
    tasks: [
      { _id: 'a', name: 'A', type: 1, status: 1, updatedAt: '2026-09-20T10:00:00Z' },
      { _id: 's', name: 'S', type: 3, status: 1, updatedAt: '2026-09-24T10:00:00Z' },
    ],
    total: 12,
  };
  const noteRes = {
    tasks: [{ _id: 'n', name: 'N', type: 2, status: 1, updatedAt: '2026-09-22T10:00:00Z' }],
    total: 3,
  };

  it('orders the union by updatedAt desc by default and keeps both totals', () => {
    const merged = mergeAllLists(taskRes, noteRes, 50);
    expect(merged.tasks.map((t) => t._id)).toEqual(['s', 'n', 'a']);
    expect(merged.totals).toEqual({ tasksAndStickyNotes: 12, notes: 3 });
    expect(merged.limit).toBe(50);
    expect(merged.sort).toEqual({ field: 'updatedAt', dir: 'desc' });
  });

  it('honours sortBy on the merged union (asc, string field, missing values last)', () => {
    const t = { tasks: [{ _id: 'b', name: 'Beta' }, { _id: 'z' }], total: 2 };
    const n = { tasks: [{ _id: 'a', name: 'alpha' }], total: 1 };
    expect(mergeAllLists(t, n, 50, 'name:asc').tasks.map((x) => x._id)).toEqual(['a', 'b', 'z']);
    expect(mergeAllLists(t, n, 50, 'name:desc').tasks.map((x) => x._id)).toEqual(['b', 'a', 'z']);
    expect(mergeAllLists(taskRes, noteRes, 50, 'updatedAt:asc').tasks.map((x) => x._id)).toEqual(['a', 'n', 's']);
  });

  it('falls back to updatedAt:desc for an unknown sort field', () => {
    expect(parseSort('nope:asc')).toEqual({ field: 'updatedAt', dir: 'desc' });
    expect(parseSort(undefined)).toEqual({ field: 'updatedAt', dir: 'desc' });
    expect(parseSort('priority:asc')).toEqual({ field: 'priority', dir: 'asc' });
  });

  it('cuts the union to limit', () => {
    const merged = mergeAllLists(taskRes, noteRes, 2);
    expect(merged.tasks.map((t) => t._id)).toEqual(['s', 'n']);
  });

  it('tolerates a missing/invalid updatedAt', () => {
    const merged = mergeAllLists({ tasks: [{ _id: 'x', updatedAt: 'nope' }] }, { tasks: [{ _id: 'y' }] }, 10);
    expect(merged.tasks).toHaveLength(2);
    expect(merged.totals).toEqual({ tasksAndStickyNotes: 1, notes: 1 });
  });

  it('renders a footer with the sort key, limit and both totals', () => {
    const out = renderAll(mergeAllLists(taskRes, noteRes, 50));
    expect(out).toContain('1. S [id: s]');
    expect(out).toContain('type: sticky note');
    expect(out).toContain('Showing 3 of 15 items, ordered by updatedAt:desc, limit 50');
    expect(out).toContain('tasks + sticky notes: 12, notes: 3');
  });

  it('renders an empty union', () => {
    expect(renderAll(mergeAllLists({ tasks: [], total: 0 }, { tasks: [], total: 0 }, 50))).toContain('No items found');
  });
});
