import { describe, it, expect, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerRunnerTools, claimPayload, runMetaSchema } from '../src/runnerTools.js';
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

const claimJson = (res) => {
  const text = res.content[0].text;
  return JSON.parse(text.slice(text.indexOf('{')));
};

const server = () => setup().server;

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

  it('claim converts BlockNote to markdown into description, includes claimSeq and the parent context', async () => {
    const api = fakeApi({
      claim: vi.fn(async () => ({
        task: {
          id: ID,
          name: 'Relatório',
          description: markdownToDescription('# Faça o relatório'),
          claimSeq: 4,
          projectName: 'Agente',
          agentTimeoutMin: 30,
          parent: { id: 'c'.repeat(24), name: 'Pai', description: markdownToDescription('contexto do pai'), type: 4 },
        },
      })),
    });
    const { server } = setup(api);
    const res = await server.tools.planko_agent_claim.handler({});
    expect(api.claim).toHaveBeenCalledWith(undefined);
    const json = claimJson(res);
    expect(json).toMatchObject({ id: ID, claimSeq: 4, name: 'Relatório', projectName: 'Agente', timeoutMin: 30 });
    expect(json.description).toContain('# Faça o relatório');
    expect(json.parentContext).toMatchObject({ id: 'c'.repeat(24), name: 'Pai' });
    expect(json.parentContext.description).toContain('contexto do pai');
    expect(json.parentContext.instructions).toBeUndefined();
  });

  it('claim keeps a plain-text description as is and has a null parent context', async () => {
    const api = fakeApi({
      claim: vi.fn(async () => ({ task: { id: ID, name: 'x', description: 'texto puro', claimSeq: 1, parent: null } })),
    });
    const { server } = setup(api);
    const json = claimJson(await server.tools.planko_agent_claim.handler({}));
    expect(json.description).toBe('texto puro');
    expect(json.parentContext).toBeNull();
  });

  it('claim returns the nine standardized fields with the back names and never the human instructions (E9)', async () => {
    const rejections = [{ at: '2026-11-20T10:00:00.000Z', reason: 'curto demais', kind: 'execution' }];
    const api = fakeApi({
      claim: vi.fn(async () => ({
        task: {
          id: ID,
          name: 'Relatório',
          description: 'texto',
          claimSeq: 2,
          projectName: null,
          agentTimeoutMin: 60,
          context: { attachments: [{ attachmentId: 'd'.repeat(24), name: 'nota.md', size: 12, mime: 'text/markdown', extra: 1 }] },
          output: { suggestSubtasks: false },
          level: 'baixo',
          sourceId: 'e'.repeat(24),
          executorKind: 'claude_code',
          instructions: 'Leia o README antes.',
          availableAt: '2026-11-24T10:00:00.000Z',
          releaseCount: 2,
          recentRejections: rejections,
          humanInstructions: 'Opção B',
          humanInstructionsLabel: 'Decidir entre A, B ou outro',
          parent: null,
        },
      })),
    });
    const { server } = setup(api);
    const json = claimJson(await server.tools.planko_agent_claim.handler({}));
    expect(json).toMatchObject({
      context: { attachments: [{ attachmentId: 'd'.repeat(24), name: 'nota.md', size: 12, mime: 'text/markdown' }] },
      output: { suggestSubtasks: false },
      level: 'baixo',
      sourceId: 'e'.repeat(24),
      executorKind: 'claude_code',
      instructions: 'Leia o README antes.',
      availableAt: '2026-11-24T10:00:00.000Z',
      releaseCount: 2,
      recentRejections: rejections,
    });
    expect(json.context.attachments[0].extra).toBeUndefined();
    expect(json.projectName).toBeNull();
    expect(json).not.toHaveProperty('humanInstructions');
    expect(json).not.toHaveProperty('humanInstructionsLabel');
  });

  it('claim from a back without the new fields gets safe defaults (E9)', async () => {
    const api = fakeApi({
      claim: vi.fn(async () => ({ task: { id: ID, name: 'x', description: 'y', claimSeq: 1, humanInstructions: 'z' } })),
    });
    const { server } = setup(api);
    const json = claimJson(await server.tools.planko_agent_claim.handler({}));
    expect(json).toMatchObject({
      context: { attachments: [] },
      output: { suggestSubtasks: true },
      level: null,
      sourceId: null,
      executorKind: 'claude_code',
      instructions: null,
      availableAt: null,
      releaseCount: 0,
      recentRejections: [],
    });
    expect(json).not.toHaveProperty('humanInstructions');
  });

  it('claimPayload treats blank basic instructions as null', () => {
    expect(claimPayload({ id: ID, claimSeq: 1, name: 'x', instructions: '   ' }).instructions).toBeNull();
  });

  it('finish forwards result, error and claimSeq', async () => {
    const { server, api } = setup();
    const res = await server.tools.planko_agent_finish.handler({ taskId: ID, claimSeq: 2, result: '# feito', error: true });
    expect(api.finish).toHaveBeenCalledWith(ID, { result: '# feito', error: true, claimSeq: 2 });
    expect(res.content[0].text).toBe(`Finished task ${ID}: validacao`);
  });

  it('finish forwards runMeta when given (E9)', async () => {
    const { server, api } = setup();
    const runMeta = { executorKind: 'claude_code', costUsd: 0.01, steps: 3, durationMs: 1200, stoppedBy: 'submitted' };
    await server.tools.planko_agent_finish.handler({ taskId: ID, claimSeq: 2, result: 'ok', runMeta });
    expect(api.finish).toHaveBeenCalledWith(ID, { result: 'ok', error: false, claimSeq: 2, runMeta });
  });

  it('runMetaSchema accepts the §2.1 whitelist and refuses unknown keys or values', () => {
    const full = {
      executorKind: 'planko',
      model: 'm',
      level: 'baixo',
      steps: 1,
      inputTokens: 2,
      outputTokens: 3,
      costUsd: 0.1,
      orFeeUsd: 0.01,
      upstreamCostUsd: 0.09,
      composioCalls: 4,
      durationMs: 5,
      queueLatencyMs: 6,
      writes: 7,
      egressDomains: ['example.com'],
      memory: { added: ['a'], updated: [], removed: ['b'] },
      stoppedBy: 'timeout',
      traceId: 't',
    };
    expect(runMetaSchema.safeParse(full).success).toBe(true);
    expect(runMetaSchema.safeParse({ stoppedBy: 'x' }).success).toBe(false);
    expect(runMetaSchema.safeParse({ foo: 1 }).success).toBe(false);
    expect(runMetaSchema.safeParse({ costUsd: -1 }).success).toBe(false);
    const { config } = server().tools.planko_agent_finish;
    expect(config.inputSchema.runMeta.safeParse(undefined).success).toBe(true);
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

  it('suggest has no human-instructions fields and never forwards them (§12.9)', async () => {
    const { server, api } = setup();
    const { config } = server.tools.planko_agent_suggest_subtask;
    expect(config.inputSchema).not.toHaveProperty('requireHumanInstructions');
    expect(config.inputSchema).not.toHaveProperty('humanInstructionsLabel');
    expect(config.description).not.toMatch(/requireHumanInstructions|humanInstructionsLabel|Instruções humanas/);
    expect(config.description).toMatch(/question and the options in the description/);
    const res = await server.tools.planko_agent_suggest_subtask.handler({
      parentTaskId: ID,
      name: 'Decidir',
      requireHumanInstructions: true,
      humanInstructionsLabel: 'Decidir entre A, B ou outro',
    });
    expect(res.isError).toBeUndefined();
    expect(api.suggestSubtask).toHaveBeenCalledWith(ID, { name: 'Decidir' });
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
