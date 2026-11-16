import { describe, it, expect, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerRunnerTools } from '../src/runnerTools.js';
import { markdownToDescription } from '../src/converters.js';

const RUNNER_TOOLS = ['planko_agent_claim', 'planko_agent_finish', 'planko_agent_suggest_subtask'];
const ID = 'a'.repeat(24);

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
    claim: vi.fn(async () => ({ task: null })),
    finish: vi.fn(async (id) => ({ task: { id, agentStatus: 'validacao', agentDecision: null } })),
    suggestSubtask: vi.fn(async (id, body) => ({ task: { id: 'b'.repeat(24), name: body.name, agentStatus: 'sugestao', parentId: id } })),
    ...overrides,
  };
}

const setup = (api = fakeApi()) => {
  const server = fakeServer();
  registerRunnerTools(server, { api });
  return { server, api };
};

describe('registerRunnerTools (PL330)', () => {
  it('registers exactly the three runner tools with the right annotations', () => {
    const { server } = setup();
    expect(Object.keys(server.tools).sort()).toEqual([...RUNNER_TOOLS].sort());
    const ann = (n) => server.tools[n].config.annotations;
    expect(ann('planko_agent_claim')).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(ann('planko_agent_claim').idempotentHint).toBeUndefined();
    expect(ann('planko_agent_finish')).toMatchObject({ readOnlyHint: false, idempotentHint: true });
    expect(ann('planko_agent_suggest_subtask')).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    for (const n of RUNNER_TOOLS) {
      expect(typeof server.tools[n].config.title).toBe('string');
      expect(typeof server.tools[n].config.description).toBe('string');
      expect(ann(n).openWorldHint).toBe(false);
    }
  });

  it('claim with no task returns "No task available."', async () => {
    const { server, api } = setup();
    const res = await server.tools.planko_agent_claim.handler({ waitSeconds: 5 });
    expect(api.claim).toHaveBeenCalledWith(5);
    expect(res.isError).toBeUndefined();
    expect(res.content[0].text).toBe('No task available.');
  });

  it('claim converts BlockNote to markdown, includes claimSeq and the parent context', async () => {
    const api = fakeApi({
      claim: vi.fn(async () => ({
        task: {
          id: ID,
          name: 'Relatório',
          description: markdownToDescription('# Faça o relatório'),
          claimSeq: 4,
          projectName: 'Agente',
          agentTimeoutMin: 30,
          humanInstructions: 'Opção B',
          humanInstructionsLabel: 'Decidir entre A, B ou outro',
          parent: { id: 'c'.repeat(24), name: 'Pai', description: markdownToDescription('contexto do pai'), type: 4 },
        },
      })),
    });
    const { server } = setup(api);
    const res = await server.tools.planko_agent_claim.handler({});
    expect(api.claim).toHaveBeenCalledWith(undefined);
    const text = res.content[0].text;
    const json = JSON.parse(text.slice(text.indexOf('{')));
    expect(json).toMatchObject({ id: ID, claimSeq: 4, name: 'Relatório', projectName: 'Agente', timeoutMin: 30 });
    expect(json).toMatchObject({ humanInstructions: 'Opção B', humanInstructionsLabel: 'Decidir entre A, B ou outro' });
    expect(json.instructions).toContain('# Faça o relatório');
    expect(json.parentContext).toMatchObject({ id: 'c'.repeat(24), name: 'Pai' });
    expect(json.parentContext.instructions).toContain('contexto do pai');
  });

  it('claim keeps a plain-text description as is and has a null parent context', async () => {
    const api = fakeApi({
      claim: vi.fn(async () => ({ task: { id: ID, name: 'x', description: 'texto puro', claimSeq: 1, parent: null } })),
    });
    const { server } = setup(api);
    const text = (await server.tools.planko_agent_claim.handler({})).content[0].text;
    const json = JSON.parse(text.slice(text.indexOf('{')));
    expect(json.instructions).toBe('texto puro');
    expect(json.parentContext).toBeNull();
    expect(json).toMatchObject({ humanInstructions: null, humanInstructionsLabel: null });
  });

  it('finish forwards result, error and claimSeq', async () => {
    const { server, api } = setup();
    const res = await server.tools.planko_agent_finish.handler({ taskId: ID, claimSeq: 2, result: '# feito', error: true });
    expect(api.finish).toHaveBeenCalledWith(ID, { result: '# feito', error: true, claimSeq: 2 });
    expect(res.content[0].text).toBe(`Finished task ${ID}: validacao`);
  });

  it('finish reports an automatic conclusion', async () => {
    const api = fakeApi({ finish: vi.fn(async () => ({ task: { id: ID, agentStatus: 'concluido', agentDecision: 'auto' } })) });
    const { server } = setup(api);
    const res = await server.tools.planko_agent_finish.handler({ taskId: ID, claimSeq: 1, result: 'ok' });
    expect(api.finish).toHaveBeenCalledWith(ID, { result: 'ok', error: false, claimSeq: 1 });
    expect(res.content[0].text).toBe(`Finished task ${ID}: concluido (auto)`);
  });

  it('suggest converts markdown to BlockNote and maps timeoutMin', async () => {
    const { server, api } = setup();
    const res = await server.tools.planko_agent_suggest_subtask.handler({
      parentTaskId: ID,
      name: 'Revisar',
      description: '**importante**',
      timeoutMin: 15,
    });
    expect(api.suggestSubtask).toHaveBeenCalledWith(ID, {
      name: 'Revisar',
      description: markdownToDescription('**importante**'),
      agentTimeoutMin: 15,
    });
    expect(res.isError).toBeUndefined();
    expect(res.content[0].text).toMatch(/Suggested subtask "Revisar"/);
  });

  it('suggest forwards requireHumanInstructions + label (PL331)', async () => {
    const { server, api } = setup();
    const res = await server.tools.planko_agent_suggest_subtask.handler({
      parentTaskId: ID,
      name: 'Decidir',
      requireHumanInstructions: true,
      humanInstructionsLabel: 'Decidir entre A, B, C ou outro',
    });
    expect(api.suggestSubtask).toHaveBeenCalledWith(ID, {
      name: 'Decidir',
      requireHumanInstructions: true,
      humanInstructionsLabel: 'Decidir entre A, B, C ou outro',
    });
    expect(res.content[0].text).toMatch(/needs the owner instructions/);
    const { config } = server.tools.planko_agent_suggest_subtask;
    expect(config.description).toMatch(/requireHumanInstructions/);
    expect(config.inputSchema.humanInstructionsLabel.safeParse('x'.repeat(201)).success).toBe(false);
  });

  it('suggest with requireHumanInstructions and no label → tool error, no api call (PL331)', async () => {
    const { server, api } = setup();
    const res = await server.tools.planko_agent_suggest_subtask.handler({ parentTaskId: ID, name: 'Decidir', requireHumanInstructions: true });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/humanInstructionsLabel is required/);
    expect(api.suggestSubtask).not.toHaveBeenCalled();
  });

  it('returns isError with the message when the api fails', async () => {
    const api = fakeApi({
      claim: vi.fn(async () => {
        throw new Error('HTTP 401: Invalid or revoked runner token');
      }),
      finish: vi.fn(async () => {
        throw new Error('HTTP 409: stale claim');
      }),
      suggestSubtask: vi.fn(async () => {
        throw new Error('HTTP 422: not agentic');
      }),
    });
    const { server } = setup(api);
    const c = await server.tools.planko_agent_claim.handler({});
    expect(c).toMatchObject({ isError: true });
    expect(c.content[0].text).toBe('planko_agent_claim failed: HTTP 401: Invalid or revoked runner token');
    const f = await server.tools.planko_agent_finish.handler({ taskId: ID, claimSeq: 1, result: 'x' });
    expect(f.isError).toBe(true);
    expect(f.content[0].text).toMatch(/HTTP 409/);
    const s = await server.tools.planko_agent_suggest_subtask.handler({ parentTaskId: ID, name: 'x' });
    expect(s.isError).toBe(true);
    expect(s.content[0].text).toMatch(/HTTP 422/);
  });

  it('registers cleanly on a real McpServer', () => {
    const server = new McpServer({ name: 'test', version: '0.0.0' });
    expect(() => registerRunnerTools(server, { api: fakeApi() })).not.toThrow();
  });
});
