import { describe, it, expect } from 'vitest';
import {
  lockProjectId,
  sanitizeFilters,
  ownerName,
  assertProjectAllowed,
  stripHallucinatedListFilters,
  matchesAssignee,
  hasOwnerInfo,
} from '../src/projectLock.js';
import { ZERO_OBJECT_ID } from '../src/sanitize.js';

const LOCK = '6742635e764bda007ab987ed'; // the "planko" project id

describe('stripHallucinatedListFilters (the "0 tasks always" bug)', () => {
  it('drops parentId/assigneeId/priority that GPT fabricates as non-blank garbage', () => {
    const out = {
      type: 1,
      status: 1,
      projectId: LOCK,
      priority: 1, // guessed
      parentId: LOCK, // copied the project id -> zeroed every query
      assigneeId: '8222653984433766701a0000', // derived from a chat user id
      dueDateFrom: '2026-07-27',
    };
    stripHallucinatedListFilters(out);
    expect(out.parentId).toBeUndefined();
    expect(out.assigneeId).toBeUndefined();
    expect(out.priority).toBeUndefined();
    // real filters survive
    expect(out).toMatchObject({ type: 1, status: 1, projectId: LOCK, dueDateFrom: '2026-07-27' });
  });

  it('is a no-op when none are present', () => {
    const out = { type: 1, status: 1, projectId: LOCK };
    stripHallucinatedListFilters(out);
    expect(out).toEqual({ type: 1, status: 1, projectId: LOCK });
  });
});

describe('matchesAssignee (member narrowing by name)', () => {
  const vitor = { _id: 'a1', name: 'Vitor Fonseca', email: 'sfz.vitor@gmail.com' };
  const other = { _id: 'b2', name: 'Rafael Souza', email: 'rafael@planko.io' };

  it('keeps everyone when the needle is blank (default = all members)', () => {
    expect(matchesAssignee(vitor, '')).toBe(true);
    expect(matchesAssignee(vitor, undefined)).toBe(true);
    expect(matchesAssignee(vitor, ZERO_OBJECT_ID)).toBe(true);
  });

  it('matches on name or email, case-insensitively', () => {
    expect(matchesAssignee(vitor, 'vitor')).toBe(true);
    expect(matchesAssignee(vitor, 'FONSECA')).toBe(true);
    expect(matchesAssignee(vitor, 'sfz.vitor@gmail.com')).toBe(true);
    expect(matchesAssignee(other, 'vitor')).toBe(false);
  });

  it('does not match a non-blank needle when userId is a bare id (no owner info)', () => {
    expect(matchesAssignee('a1b2c3d4e5f6a1b2c3d4e5f6', 'vitor')).toBe(false);
  });
});

describe('hasOwnerInfo', () => {
  it('true when any item carries a populated owner', () => {
    expect(hasOwnerInfo([{ userId: 'bareid' }, { userId: { name: 'Vitor' } }])).toBe(true);
  });
  it('false when all items have bare-id/absent owners (pre owner-populate deploy)', () => {
    expect(hasOwnerInfo([{ userId: 'bareid' }, { userId: null }, {}])).toBe(false);
    expect(hasOwnerInfo([])).toBe(false);
  });
});

describe('lockProjectId', () => {
  it('overrides the requested projectId when the lock is set (create/list hard override)', () => {
    expect(lockProjectId(LOCK, 'someOtherProject')).toBe(LOCK);
    expect(lockProjectId(LOCK, undefined)).toBe(LOCK);
    expect(lockProjectId(LOCK, LOCK)).toBe(LOCK);
  });

  it('passes the requested value through unchanged when the lock is null (clawis regression)', () => {
    expect(lockProjectId(null, 'someProject')).toBe('someProject');
    expect(lockProjectId(null, undefined)).toBe(undefined);
    expect(lockProjectId('', 'someProject')).toBe('someProject');
  });
});

describe('sanitizeFilters', () => {
  it('drops a blank assigneeId (omitted => all members)', () => {
    expect(sanitizeFilters({ assigneeId: '' })).toEqual({});
    expect(sanitizeFilters({ assigneeId: ZERO_OBJECT_ID })).toEqual({});
    expect(sanitizeFilters({ assigneeId: undefined })).toEqual({});
  });

  it('keeps a real assigneeId', () => {
    const real = '6a454e4def3e32a8370c24f1';
    expect(sanitizeFilters({ assigneeId: real })).toEqual({ assigneeId: real });
  });

  it('sanitizes a mixed filter bag, keeping real values and numeric/boolean zeros', () => {
    expect(
      sanitizeFilters({
        status: 1,
        showCompleted: false,
        search: '',
        tags: [],
        projectId: ZERO_OBJECT_ID,
        assigneeId: '6a454e4def3e32a8370c24f1',
      })
    ).toEqual({
      status: 1,
      showCompleted: false,
      assigneeId: '6a454e4def3e32a8370c24f1',
    });
  });

  it('handles empty/undefined input', () => {
    expect(sanitizeFilters()).toEqual({});
    expect(sanitizeFilters({})).toEqual({});
  });
});

describe('ownerName', () => {
  it('returns the name when userId is a populated object', () => {
    expect(ownerName({ _id: 'u1', name: 'Xavier', email: 'x@planko.io' })).toBe('Xavier');
  });

  it('returns null for a bare string/id', () => {
    expect(ownerName('6a454e4def3e32a8370c24f1')).toBe(null);
  });

  it('returns null for null/undefined or object without a usable name', () => {
    expect(ownerName(null)).toBe(null);
    expect(ownerName(undefined)).toBe(null);
    expect(ownerName({ _id: 'u1' })).toBe(null);
    expect(ownerName({ _id: 'u1', name: '   ' })).toBe(null);
    expect(ownerName(['x'])).toBe(null);
  });
});

describe('assertProjectAllowed', () => {
  it('is a no-op when the lock is null (any task allowed)', () => {
    expect(() => assertProjectAllowed(null, { projectId: 'anything' })).not.toThrow();
    expect(() => assertProjectAllowed(null, {})).not.toThrow();
  });

  it('allows a task in the locked project', () => {
    expect(() => assertProjectAllowed(LOCK, { projectId: LOCK })).not.toThrow();
  });

  it('allows a task whose projectId is a populated object matching the lock', () => {
    expect(() => assertProjectAllowed(LOCK, { projectId: { _id: LOCK, name: 'planko' } })).not.toThrow();
  });

  it('throws for a task in a different project', () => {
    expect(() => assertProjectAllowed(LOCK, { projectId: 'deadbeefdeadbeefdeadbeef' })).toThrow(
      'This agent is restricted to the "planko" project.'
    );
  });

  it('throws for a task with a missing projectId', () => {
    expect(() => assertProjectAllowed(LOCK, {})).toThrow(
      'This agent is restricted to the "planko" project.'
    );
    expect(() => assertProjectAllowed(LOCK, null)).toThrow(
      'This agent is restricted to the "planko" project.'
    );
  });
});
