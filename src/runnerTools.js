/**
 * PL330 — tools of the agentic-tasks runner (runner mode, PLANKO_RUNNER_TOKEN).
 * Each tool maps 1:1 to a /v1/agent/runner endpoint; the backend scopes every call
 * to the token's projects and owner. Errors are always returned as tool errors.
 */
import { z } from 'zod';

import { toolOk, toolError } from './tools.js';
import { descriptionToMarkdown, markdownToDescription } from './converters.js';

const ANNOTATIONS = {
  WRITE: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  IDEMPOTENT_WRITE: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};

const objectId = z.string().regex(/^[a-fA-F\d]{24}$/, 'Must be a 24-character hex ObjectId');

export function registerRunnerTools(server, { api }) {
  // ---- planko_agent_claim ----
  server.registerTool(
    'planko_agent_claim',
    {
      title: 'Claim agentic task',
      description:
        'Take the oldest queued agentic task of this runner (long-poll). Returns its id, claimSeq and instructions, or "No task available.". The claimSeq must be sent back on planko_agent_finish.',
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
        const payload = {
          id: task.id,
          claimSeq: task.claimSeq,
          name: task.name,
          projectName: task.projectName ?? null,
          timeoutMin: task.agentTimeoutMin ?? null,
          instructions: descriptionToMarkdown(task.description),
          parentContext: task.parent
            ? {
                id: task.parent.id,
                name: task.parent.name,
                instructions: descriptionToMarkdown(task.parent.description),
              }
            : null,
        };
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
      },
      annotations: ANNOTATIONS.IDEMPOTENT_WRITE,
    },
    async ({ taskId, claimSeq, result, error }) => {
      try {
        const { task } = await api.finish(taskId, { result, error: !!error, claimSeq });
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
        'Suggest a subtask under an agentic task. It is created as a suggestion that the owner accepts or rejects; it never runs before being accepted.',
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
