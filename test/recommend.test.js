import { describe, it, expect } from 'vitest';
import {
  RECOMMENDATION_NEW_TASK,
  buildRecommendationBody,
  renderRecommendation,
  describeLockError,
} from '../src/recommend.js';

const LOCK = '6742635e764bda007ab987ed';

describe('buildRecommendationBody', () => {
  it('wraps the title and task attributes in a new_task envelope', () => {
    expect(buildRecommendationBody('Ship it', { priority: 1, tags: ['t1'] })).toEqual({
      type: RECOMMENDATION_NEW_TASK,
      payload: { title: 'Ship it', priority: 1, tags: ['t1'] },
    });
  });

  it('drops blank attributes and tolerates a missing body', () => {
    const { payload } = buildRecommendationBody('x', {
      description: '',
      parentId: '000000000000000000000000',
      tags: [],
      alert: null,
    });
    expect(payload).toEqual({ title: 'x' });
    expect(buildRecommendationBody('y').payload).toEqual({ title: 'y' });
  });

  it('derives datePlain from the date part of dueDate when datePlain is absent', () => {
    expect(buildRecommendationBody('x', { dueDate: '2026-09-30T12:00:00.000Z' }).payload).toEqual({
      title: 'x',
      dueDate: '2026-09-30T12:00:00.000Z',
      datePlain: '2026-09-30',
    });
    expect(buildRecommendationBody('x', { dueDate: '2026-09-30' }).payload.datePlain).toBe('2026-09-30');
  });

  it('never overrides an explicit datePlain', () => {
    const { payload } = buildRecommendationBody('x', {
      dueDate: '2026-09-30T23:30:00-03:00',
      datePlain: '2026-10-01',
    });
    expect(payload.datePlain).toBe('2026-10-01');
  });

  it('leaves datePlain absent when dueDate is not date-like', () => {
    expect(buildRecommendationBody('x', { dueDate: 'tomorrow' }).payload).toEqual({
      title: 'x',
      dueDate: 'tomorrow',
    });
  });
});

describe('renderRecommendation', () => {
  const res = { id: 'r1', status: 'pending', payload: { title: 'Ship it' } };

  it('names the id, status, title and project, and says nothing was created', () => {
    const out = renderRecommendation(res, { projectId: 'p1' });
    expect(out).toContain('Recommendation sent (id: r1, status: pending): "Ship it" in project p1.');
    expect(out).toContain('Nothing was created yet');
    expect(out).toContain('accept it (which creates the task) or reject it');
    expect(out).not.toContain('projectName was ignored');
  });

  it("defaults to the owner's default project", () => {
    expect(renderRecommendation(res)).toContain("in the owner's default project");
  });

  it('adds the lock note when projectName was ignored', () => {
    const out = renderRecommendation(res, { projectId: LOCK, lock: LOCK, projectNameIgnored: true });
    expect(out).toContain(`projectName was ignored because this server is locked to project ${LOCK}`);
  });

  it('tolerates an unexpected response shape', () => {
    expect(renderRecommendation(null)).toContain('(id: unknown, status: pending): "(untitled)"');
    expect(renderRecommendation({ recommendation: { _id: 'r2', payload: { title: 'T' } } })).toContain(
      '(id: r2, status: pending): "T"'
    );
  });
});

describe('describeLockError', () => {
  it('rewrites the backend "Invalid projectId" under a lock', () => {
    const out = describeLockError(new Error('Invalid projectId'), LOCK);
    expect(out.message).toContain(`The locked project (${LOCK}) is not accessible`);
  });

  it('passes every other error through untouched', () => {
    const err = new Error('Invalid tags');
    expect(describeLockError(err, LOCK)).toBe(err);
    const same = new Error('Invalid projectId');
    expect(describeLockError(same, null)).toBe(same);
  });
});
