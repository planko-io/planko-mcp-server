import { describe, it, expect } from 'vitest';
import {
  lockProjectId,
  sanitizeFilters,
  ownerName,
  assertProjectAllowed,
} from '../src/projectLock.js';
import { ZERO_OBJECT_ID } from '../src/sanitize.js';

const LOCK = '6742635e764bda007ab987ed'; // the "planko" project id

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
