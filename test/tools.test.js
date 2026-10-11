import { describe, it, expect, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerStandaloneTools } from '../src/tools.js';

const STANDALONE_TOOLS = [
  'planko_create_task',
  'planko_create_note',
  'planko_create_sticky_note',
  'planko_recommend_task',
  'planko_edit_task',
  'planko_edit_note',
  'planko_edit_sticky_note',
  'planko_complete_task',
  'planko_delete_task',
  'planko_delete_note',
  'planko_delete_sticky_note',
  'planko_list_tasks',
  'planko_list_notes',
  'planko_list_sticky_notes',
  'planko_list_all',
  'planko_view_task',
  'planko_view_note',
  'planko_view_sticky_note',
];

const READ_ONLY = [
  'planko_list_tasks',
  'planko_list_notes',
  'planko_list_sticky_notes',
  'planko_list_all',
  'planko_view_task',
  'planko_view_note',
  'planko_view_sticky_note',
];

const DESTRUCTIVE = [
  'planko_delete_task',
  'planko_delete_note',
  'planko_delete_sticky_note',
  'planko_complete_task',
];

const IDEMPOTENT = [
  'planko_delete_task',
  'planko_delete_note',
  'planko_delete_sticky_note',
  'planko_complete_task',
  'planko_edit_task',
  'planko_edit_note',
  'planko_edit_sticky_note',
];

function fakeServer() {
  const tools = {};
  return {
    tools,
    registerTool: vi.fn((name, config, handler) => {
      tools[name] = { config, handler };
    }),
  };
}

function fakeApi(overrides = {}) {
  return {
    projects: vi.fn(async () => ({ projects: [] })),
    boards: vi.fn(async () => ({ personal: [], workspace: [] })),
    createTask: vi.fn(async (body) => ({ _id: 'abc', name: body.name })),
    updateTask: vi.fn(async () => ({ _id: 'abc', name: 'x' })),
    completeTask: vi.fn(async () => ({ _id: 'abc', name: 'x' })),
    deleteTask: vi.fn(async () => ({})),
    createRecommendation: vi.fn(async () => ({ _id: 'r1', status: 'pending' })),
    listTasks: vi.fn(async () => ({ tasks: [], total: 0 })),
    getTask: vi.fn(async () => ({ _id: 'abc', name: 'x', type: 1 })),
    ...overrides,
  };
}

describe('registerStandaloneTools', () => {
  it('registers exactly the 18 standalone tools and no sync tools', () => {
    const server = fakeServer();
    registerStandaloneTools(server, { api: fakeApi() });
    const names = Object.keys(server.tools);
    expect(names).toHaveLength(18);
    expect(names.sort()).toEqual([...STANDALONE_TOOLS].sort());
    expect(names).not.toContain('planko_setup');
    expect(names).not.toContain('planko_sync');
    expect(names).not.toContain('planko_sync_preview');
  });

  it('gives every tool a title, description, inputSchema and annotations', () => {
    const server = fakeServer();
    registerStandaloneTools(server, { api: fakeApi() });
    for (const name of STANDALONE_TOOLS) {
      const { config } = server.tools[name];
      expect(typeof config.title).toBe('string');
      expect(config.title.length).toBeGreaterThan(0);
      expect(typeof config.description).toBe('string');
      expect(config.description).not.toMatch(/via your API key/);
      expect(config.inputSchema).toBeTypeOf('object');
      expect(config.annotations.openWorldHint).toBe(false);
    }
  });

  it('marks list/view tools read-only and non-destructive', () => {
    const server = fakeServer();
    registerStandaloneTools(server, { api: fakeApi() });
    for (const name of READ_ONLY) {
      expect(server.tools[name].config.annotations.readOnlyHint).toBe(true);
      expect(server.tools[name].config.annotations.destructiveHint).not.toBe(true);
    }
  });

  it('marks delete/complete tools destructive and not read-only', () => {
    const server = fakeServer();
    registerStandaloneTools(server, { api: fakeApi() });
    for (const name of DESTRUCTIVE) {
      expect(server.tools[name].config.annotations.readOnlyHint).toBe(false);
      expect(server.tools[name].config.annotations.destructiveHint).toBe(true);
    }
  });

  it('marks create/edit/recommend as non-destructive writes', () => {
    const server = fakeServer();
    registerStandaloneTools(server, { api: fakeApi() });
    const writes = STANDALONE_TOOLS.filter(
      (n) => !READ_ONLY.includes(n) && !DESTRUCTIVE.includes(n)
    );
    expect(writes).toHaveLength(7);
    for (const name of writes) {
      expect(server.tools[name].config.annotations.readOnlyHint).toBe(false);
      expect(server.tools[name].config.annotations.destructiveHint).toBe(false);
    }
  });

  it('adds idempotentHint on delete, complete and edit only', () => {
    const server = fakeServer();
    registerStandaloneTools(server, { api: fakeApi() });
    for (const name of STANDALONE_TOOLS) {
      const expected = IDEMPOTENT.includes(name) ? true : undefined;
      expect(server.tools[name].config.annotations.idempotentHint).toBe(expected);
    }
  });

  it('applies wrapHandler to every tool handler with the tool name', async () => {
    const server = fakeServer();
    const wrapHandler = vi.fn((name, fn) => async (params) => {
      const res = await fn(params);
      return { ...res, wrappedBy: name };
    });
    registerStandaloneTools(server, { api: fakeApi(), wrapHandler });
    expect(wrapHandler).toHaveBeenCalledTimes(18);
    expect(wrapHandler.mock.calls.map((c) => c[0]).sort()).toEqual([...STANDALONE_TOOLS].sort());
    const res = await server.tools.planko_view_task.handler({ taskId: 'a'.repeat(24) });
    expect(res.wrappedBy).toBe('planko_view_task');
  });

  it('defaults wrapHandler to identity', async () => {
    const server = fakeServer();
    const api = fakeApi();
    registerStandaloneTools(server, { api });
    const res = await server.tools.planko_create_task.handler({ name: 'Hello' });
    expect(res.isError).toBeUndefined();
    expect(res.content[0].text).toMatch(/Created task "Hello"/);
    expect(api.createTask).toHaveBeenCalledWith({ name: 'Hello', type: 1 });
  });

  it('exposes the full list surface when projectLock is null', () => {
    const server = fakeServer();
    registerStandaloneTools(server, { api: fakeApi(), projectLock: null });
    const shape = server.tools.planko_list_tasks.config.inputSchema;
    for (const key of ['projectName', 'projectId', 'assigneeId', 'priority', 'parentId', 'boardId', 'kanbanColumnId']) {
      expect(shape).toHaveProperty(key);
    }
    expect(shape).not.toHaveProperty('assigneeName');
  });

  it('narrows the list surface when a projectLock is set', async () => {
    const server = fakeServer();
    const lock = 'b'.repeat(24);
    const api = fakeApi();
    registerStandaloneTools(server, { api, projectLock: lock });
    const shape = server.tools.planko_list_tasks.config.inputSchema;
    expect(shape).toHaveProperty('assigneeName');
    expect(shape).not.toHaveProperty('projectId');
    await server.tools.planko_list_tasks.handler({});
    expect(api.listTasks).toHaveBeenCalledWith(expect.objectContaining({ projectId: lock }));
  });

  it('returns a tool error (not a throw) when the api fails', async () => {
    const server = fakeServer();
    registerStandaloneTools(server, {
      api: fakeApi({ getTask: vi.fn(async () => { throw new Error('Task not found'); }) }),
    });
    const res = await server.tools.planko_view_note.handler({ taskId: 'a'.repeat(24) });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toBe('View note failed: Task not found');
  });

  it('registers cleanly on a real McpServer', () => {
    const server = new McpServer({ name: 'test', version: '0.0.0' });
    expect(() => registerStandaloneTools(server, { api: fakeApi() })).not.toThrow();
  });
});
