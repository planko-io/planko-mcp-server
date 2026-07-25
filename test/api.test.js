import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createApiClient } from '../src/api.js';

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
