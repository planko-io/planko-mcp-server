import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createApiClient, createRunnerApiClient } from '../src/api.js';

const BASE = 'https://api.example.test/v1';

let calls;

function mockFetch(responseBody = {}) {
  calls = [];
  globalThis.fetch = vi.fn(async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(responseBody),
    };
  });
}

function makeClient() {
  return createApiClient({ apiKey: 'test-key', apiBase: BASE });
}

beforeEach(() => {
  mockFetch();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function lastCall() {
  return calls[calls.length - 1];
}

function bodyOf(call) {
  return call.options.body ? JSON.parse(call.options.body) : undefined;
}

describe('api.status url shaping', () => {
  it('omits mcpLastSyncDate and type when not set', async () => {
    await makeClient().status('P1', null);
    expect(lastCall().url).toBe(`${BASE}/mcp-project-sync/status?projectId=P1`);
  });

  it('appends type independently of mcpLastSyncDate', async () => {
    await makeClient().status('P1', null, 2);
    expect(lastCall().url).toBe(`${BASE}/mcp-project-sync/status?projectId=P1&type=2`);
  });

  it('appends both mcpLastSyncDate and type when both set', async () => {
    await makeClient().status('P1', 123, 1);
    expect(lastCall().url).toBe(
      `${BASE}/mcp-project-sync/status?projectId=P1&mcpLastSyncDate=123&type=1`
    );
  });

  it('ignores invalid type values', async () => {
    await makeClient().status('P1', null, 5);
    expect(lastCall().url).toBe(`${BASE}/mcp-project-sync/status?projectId=P1`);
  });
});

describe('api.pull url shaping', () => {
  it('appends type when set even with null date', async () => {
    await makeClient().pull('P1', null, 1);
    expect(lastCall().url).toBe(`${BASE}/mcp-project-sync/pull?projectId=P1&type=1`);
  });

  it('appends both when set', async () => {
    await makeClient().pull('P1', 999, 2);
    expect(lastCall().url).toBe(
      `${BASE}/mcp-project-sync/pull?projectId=P1&mcpLastSyncDate=999&type=2`
    );
  });
});

describe('api.push body shaping', () => {
  it('includes type in body when set', async () => {
    await makeClient().push('P1', [{ name: 'x' }], 2);
    const call = lastCall();
    expect(call.options.method).toBe('POST');
    expect(bodyOf(call)).toEqual({ projectId: 'P1', tasks: [{ name: 'x' }], type: 2 });
  });

  it('omits type when not set', async () => {
    await makeClient().push('P1', [{ name: 'x' }]);
    expect(bodyOf(lastCall())).toEqual({ projectId: 'P1', tasks: [{ name: 'x' }] });
  });

  it('omits type for invalid value', async () => {
    await makeClient().push('P1', [], 0);
    expect(bodyOf(lastCall())).toEqual({ projectId: 'P1', tasks: [] });
  });
});

describe('api CRUD endpoints', () => {
  it('createTask POSTs to /tasks with body', async () => {
    await makeClient().createTask({ name: 'Buy milk', type: 1 });
    const call = lastCall();
    expect(call.url).toBe(`${BASE}/mcp-project-sync/tasks`);
    expect(call.options.method).toBe('POST');
    expect(bodyOf(call)).toEqual({ name: 'Buy milk', type: 1 });
  });

  it('updateTask PATCHes to /tasks/:id with body', async () => {
    await makeClient().updateTask('abc123', { name: 'renamed' });
    const call = lastCall();
    expect(call.url).toBe(`${BASE}/mcp-project-sync/tasks/abc123`);
    expect(call.options.method).toBe('PATCH');
    expect(bodyOf(call)).toEqual({ name: 'renamed' });
  });

  it('completeTask POSTs to /tasks/:id/complete with no body', async () => {
    await makeClient().completeTask('abc123');
    const call = lastCall();
    expect(call.url).toBe(`${BASE}/mcp-project-sync/tasks/abc123/complete`);
    expect(call.options.method).toBe('POST');
    expect(call.options.body).toBeUndefined();
  });

  it('deleteTask DELETEs /tasks/:id', async () => {
    await makeClient().deleteTask('abc123');
    const call = lastCall();
    expect(call.url).toBe(`${BASE}/mcp-project-sync/tasks/abc123`);
    expect(call.options.method).toBe('DELETE');
  });

  it('sends x-api-key header on every request', async () => {
    await makeClient().deleteTask('abc123');
    expect(lastCall().options.headers['x-api-key']).toBe('test-key');
  });
});

describe('api.listTasks url/query shaping', () => {
  function queryOf(call) {
    return new URL(call.url).searchParams;
  }

  it('GETs /tasks with no query when params are empty', async () => {
    await makeClient().listTasks();
    const call = lastCall();
    expect(call.url).toBe(`${BASE}/mcp-project-sync/tasks`);
    expect(call.options.method).toBe('GET');
  });

  it('serializes type and scalar filters, omitting undefined/null', async () => {
    await makeClient().listTasks({
      type: 1,
      status: 2,
      priority: 3,
      projectId: 'P1',
      search: 'buy milk',
      limit: 25,
      page: 2,
      showCompleted: undefined,
      parentId: null,
    });
    const q = queryOf(lastCall());
    expect(q.get('type')).toBe('1');
    expect(q.get('status')).toBe('2');
    expect(q.get('priority')).toBe('3');
    expect(q.get('projectId')).toBe('P1');
    expect(q.get('search')).toBe('buy milk');
    expect(q.get('limit')).toBe('25');
    expect(q.get('page')).toBe('2');
    expect(q.has('showCompleted')).toBe(false);
    expect(q.has('parentId')).toBe(false);
  });

  it('serializes a tags array to a CSV string', async () => {
    await makeClient().listTasks({ type: 2, tags: ['aaa', 'bbb', 'ccc'] });
    const q = queryOf(lastCall());
    expect(q.get('tags')).toBe('aaa,bbb,ccc');
  });

  it('omits an empty tags array', async () => {
    await makeClient().listTasks({ type: 1, tags: [] });
    const q = queryOf(lastCall());
    expect(q.has('tags')).toBe(false);
  });

  it('serializes a boolean filter', async () => {
    await makeClient().listTasks({ type: 2, showCompleted: false });
    const q = queryOf(lastCall());
    expect(q.get('showCompleted')).toBe('false');
  });

  it('sends the x-api-key header on GET', async () => {
    await makeClient().listTasks({ type: 1 });
    expect(lastCall().options.headers['x-api-key']).toBe('test-key');
  });
});

describe('api.boards', () => {
  it('GETs /boards with the api key', async () => {
    await makeClient().boards();
    expect(lastCall().url).toBe(`${BASE}/mcp-project-sync/boards`);
    expect(lastCall().options.method).toBe('GET');
    expect(lastCall().options.headers['x-api-key']).toBe('test-key');
  });
});

describe('api.createRecommendation', () => {
  it('POSTs the { type, payload } envelope as JSON to /recommendations', async () => {
    const body = { type: 'new_task', payload: { title: 'Ship it', priority: 1 } };
    await makeClient().createRecommendation(body);
    expect(lastCall().url).toBe(`${BASE}/mcp-project-sync/recommendations`);
    expect(lastCall().options.method).toBe('POST');
    expect(lastCall().options.headers['x-api-key']).toBe('test-key');
    expect(lastCall().options.headers['Content-Type']).toBe('application/json');
    expect(bodyOf(lastCall())).toEqual(body);
  });
});

describe('api.getTask url shaping', () => {
  it('GETs /tasks/:id', async () => {
    await makeClient().getTask('abc123');
    const call = lastCall();
    expect(call.url).toBe(`${BASE}/mcp-project-sync/tasks/abc123`);
    expect(call.options.method).toBe('GET');
    expect(call.options.body).toBeUndefined();
  });
});

describe('createRunnerApiClient (PL330 runner mode)', () => {
  const TOKEN = 'pk_run_abc123';
  const runner = () => createRunnerApiClient({ runnerToken: TOKEN, apiBase: BASE });

  it('claims with the bearer token (never x-api-key) and an empty body by default', async () => {
    await runner().claim();
    const call = lastCall();
    expect(call.url).toBe(`${BASE}/agent/runner/claim`);
    expect(call.options.method).toBe('POST');
    expect(call.options.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(call.options.headers['x-api-key']).toBeUndefined();
    expect(bodyOf(call)).toEqual({});
  });

  it('forwards waitSec on claim', async () => {
    await runner().claim(10);
    expect(bodyOf(lastCall())).toEqual({ waitSec: 10 });
  });

  it('finishes with result, error and claimSeq', async () => {
    await runner().finish('t1', { result: '# ok', error: true, claimSeq: 3 });
    const call = lastCall();
    expect(call.url).toBe(`${BASE}/agent/runner/tasks/t1/finish`);
    expect(bodyOf(call)).toEqual({ result: '# ok', error: true, claimSeq: 3 });
  });

  it('defaults error to false on finish', async () => {
    await runner().finish('t1', { result: 'ok', claimSeq: 1 });
    expect(bodyOf(lastCall()).error).toBe(false);
  });

  it('posts subtask suggestions under the parent', async () => {
    await runner().suggestSubtask('p1', { name: 'sub', agentTimeoutMin: 5 });
    const call = lastCall();
    expect(call.url).toBe(`${BASE}/agent/runner/tasks/p1/subtasks`);
    expect(bodyOf(call)).toEqual({ name: 'sub', agentTimeoutMin: 5 });
  });

  it('puts the HTTP status in the error message', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 409,
      text: async () => JSON.stringify({ code: 409, message: 'Task is not running under this claim' }),
    }));
    await expect(runner().finish('t1', { result: 'x', claimSeq: 1 })).rejects.toThrow(
      'HTTP 409: Task is not running under this claim'
    );
  });
});

describe('createApiClient error messages', () => {
  it('keeps the plain backend message for the user client', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({ message: 'Invalid projectId' }),
    }));
    await expect(makeClient().getTask('x')).rejects.toThrow(/^Invalid projectId$/);
  });
});
