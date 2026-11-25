/**
 * PL330 — tools of the agentic-tasks runner (runner mode, PLANKO_RUNNER_TOKEN).
 * Each tool maps 1:1 to a /v1/agent/runner endpoint; the backend scopes every call
 * to the token's owner and executor (the tasks whose agent is this runner).
 * Errors are always returned as tool errors.
 * E9 (PL347): the claim returns the standardized payload of the back with the same
 * names, without the owner's "human instructions" (§12.9); finish forwards runMeta.
 */
import { z } from 'zod';

import { toolOk, toolError } from './tools.js';
import { descriptionToMarkdown, markdownToDescription } from './converters.js';

const ANNOTATIONS = {
  WRITE: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  IDEMPOTENT_WRITE: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};

const objectId = z.string().regex(/^[a-fA-F\d]{24}$/, 'Must be a 24-character hex ObjectId');

// Whitelist of agentRunMeta (arquitetura §2.1); mirrors the back Joi. .strict(): the agent cannot invent keys.
const RUN_META_NUMBERS = [
  'steps',
  'inputTokens',
  'outputTokens',
  'costUsd',
  'orFeeUsd',
  'upstreamCostUsd',
  'composioCalls',
  'durationMs',
  'queueLatencyMs',
  'writes',
];
const STOPPED_BY = ['submitted', 'step_cap', 'timeout', 'provider_error', 'deploy', 'interrupted'];
const keyList = z.array(z.string().max(200)).max(50).optional();

export const runMetaSchema = z
  .object({
    executorKind: z.enum(['claude_code', 'planko']).optional(),
    model: z.string().max(100).optional(),
    level: z.string().max(100).optional(),
    ...Object.fromEntries(RUN_META_NUMBERS.map((k) => [k, z.number().min(0).optional()])),
    egressDomains: z.array(z.string().max(253)).max(100).optional(),
    memory: z.object({ added: keyList, updated: keyList, removed: keyList }).strict().optional(),
    stoppedBy: z.enum(STOPPED_BY).optional(),
    traceId: z.string().max(200).optional(),
  })
  .strict();

const orNull = (v) => (v === undefined ? null : v);

/**
 * Standardized claim payload (arquitetura §3): same names as the back claim, safe defaults
 * when an older back does not send them. Never carries humanInstructions (§12.9).
 */
export function claimPayload(task) {
  const attachments = Array.isArray(task.context?.attachments) ? task.context.attachments : [];
  return {
    id: task.id,
    claimSeq: task.claimSeq,
    name: task.name,
    projectName: orNull(task.projectName),
    timeoutMin: orNull(task.agentTimeoutMin),
    description: descriptionToMarkdown(task.description),
    context: {
      attachments: attachments.map(({ attachmentId, name, size, mime }) => ({
        attachmentId: String(attachmentId),
        name: orNull(name),
        size: orNull(size),
        mime: orNull(mime),
      })),
    },
    output: { suggestSubtasks: task.output?.suggestSubtasks !== false },
    level: orNull(task.level),
    sourceId: orNull(task.sourceId),
    executorKind: task.executorKind ?? 'claude_code',
    instructions: typeof task.instructions === 'string' && task.instructions.trim() ? task.instructions : null,
    availableAt: orNull(task.availableAt),
    releaseCount: Number.isInteger(task.releaseCount) ? task.releaseCount : 0,
    recentRejections: Array.isArray(task.recentRejections) ? task.recentRejections : [],
    parentContext: task.parent
      ? { id: task.parent.id, name: task.parent.name, description: descriptionToMarkdown(task.parent.description) }
      : null,
  };
}

export function registerRunnerTools(server, { api }) {
  // ---- planko_agent_claim ----
  server.registerTool(
    'planko_agent_claim',
    {
      title: 'Claim agentic task',
      description:
        'Take the oldest queued agentic task of this runner (long-poll), or "No task available.". Returns id, claimSeq (send it back on planko_agent_finish), name, projectName, timeoutMin, ' +
        'description (the task instruction, Markdown), instructions (the basic instructions of this agent: apply them before the task instruction; on conflict the task wins; null when none), ' +
        'context.attachments (files of the instruction), output.suggestSubtasks (when false, do not suggest subtasks), level, sourceId, executorKind, availableAt, releaseCount, recentRejections and parentContext.',
      inputSchema: {
        waitSeconds: z
          .number()
          .int()
          .min(0)
          .max(25)
          .optional()
          .describe('How long to wait for a task, in seconds (default: server maximum)'),
      },
      annotations: ANNOTATIONS.WRITE,
    },
    async ({ waitSeconds }) => {
      try {
        const { task } = await api.claim(waitSeconds);
        if (!task) return toolOk('No task available.');
        const payload = claimPayload(task);
        return toolOk(`Claimed task ${task.id}.\n\n${JSON.stringify(payload, null, 2)}`);
      } catch (err) {
        return toolError(`planko_agent_claim failed: ${err.message}`);
      }
    }
  );

  // ---- planko_agent_finish ----
  server.registerTool(
    'planko_agent_finish',
    {
      title: 'Finish agentic task',
      description:
        'Report the result of a claimed agentic task (Markdown). Set error=true when the task could not be completed. The task goes to validation, or is concluded automatically when its model allows it.',
      inputSchema: {
        taskId: objectId.describe('Id of the claimed task'),
        claimSeq: z.number().int().min(1).describe('claimSeq returned by planko_agent_claim for this task'),
        result: z.string().max(100000).describe('Markdown output'),
        error: z.boolean().optional().describe('true when the task failed'),
        runMeta: runMetaSchema.optional().describe('Run summary (cost, tokens, steps, duration…) shown to the owner'),
      },
      annotations: ANNOTATIONS.IDEMPOTENT_WRITE,
    },
    async ({ taskId, claimSeq, result, error, runMeta }) => {
      try {
        const body = { result, error: !!error, claimSeq };
        if (runMeta) body.runMeta = runMeta;
        const { task } = await api.finish(taskId, body);
        const auto = task.agentDecision === 'auto' ? ' (auto)' : '';
        return toolOk(`Finished task ${task.id}: ${task.agentStatus}${auto}`);
      } catch (err) {
        return toolError(`planko_agent_finish failed: ${err.message}`);
      }
    }
  );

  // ---- planko_agent_suggest_subtask ----
  server.registerTool(
    'planko_agent_suggest_subtask',
    {
      title: 'Suggest subtask',
      description:
        'Suggest a subtask under an agentic task. It is created as a suggestion that the owner accepts or rejects; it never runs before being accepted. ' +
        'If it depends on a decision only the owner can make, write the question and the options in the description (e.g. "A) …, B) …, C) …, or another one"): ' +
        'the owner edits the instruction before accepting.',
      inputSchema: {
        parentTaskId: objectId.describe('Id of the agentic parent task'),
        name: z.string().min(1).max(200).describe('Subtask title'),
        description: z.string().optional().describe('Instructions for the subtask, as Markdown'),
        timeoutMin: z.number().int().min(1).max(1440).optional().describe('Timeout in minutes (default 60)'),
      },
      annotations: ANNOTATIONS.WRITE,
    },
    async ({ parentTaskId, name, description, timeoutMin }) => {
      try {
        const body = { name, description: markdownToDescription(description) };
        if (timeoutMin !== undefined) body.agentTimeoutMin = timeoutMin;
        if (body.description == null) delete body.description;
        const { task } = await api.suggestSubtask(parentTaskId, body);
        return toolOk(`Suggested subtask "${task.name}" (id: ${task.id}) under ${parentTaskId}: ${task.agentStatus}`);
      } catch (err) {
        return toolError(`planko_agent_suggest_subtask failed: ${err.message}`);
      }
    }
  );
}
