/**
 * Recommendations (PL274) — pure helpers, no I/O.
 *
 * A recommendation is a SUGGESTION sent to the owner of the API key: the
 * backend stores it as `pending`, notifies the owner (notification centre +
 * push) and only creates the task when the owner accepts. Nothing is written
 * to the task collection by the MCP call itself.
 *
 * Endpoint: POST /mcp-project-sync/recommendations
 *   body     { type: 'new_task', payload: { title, ...task attributes } }
 *   response the Recommendation document (toJSON → `id`, never `_id`)
 */

import { isBlankValue } from './sanitize.js';

export const RECOMMENDATION_NEW_TASK = 'new_task';

const DATE_PREFIX = /^\d{4}-\d{2}-\d{2}/;

/**
 * Build the request body for a `new_task` recommendation.
 *
 * `taskBody` is an already-sanitized task attribute bag (blank values dropped,
 * Markdown description converted, datePlain→dueDate mirrored). The owner's
 * notification card previews `datePlain` only, so a dueDate-only suggestion
 * would reach them with no visible date: derive datePlain from the date part
 * of dueDate when it is missing. An explicit datePlain is never overridden.
 */
export function buildRecommendationBody(title, taskBody = {}) {
  const payload = { title };
  for (const [key, value] of Object.entries(taskBody)) {
    if (isBlankValue(value)) continue;
    payload[key] = value;
  }
  if (
    isBlankValue(payload.datePlain) &&
    typeof payload.dueDate === 'string' &&
    DATE_PREFIX.test(payload.dueDate)
  ) {
    payload.datePlain = payload.dueDate.slice(0, 10);
  }
  return { type: RECOMMENDATION_NEW_TASK, payload };
}

/**
 * Text returned to the agent after a successful POST. Tolerates an unexpected
 * response shape. `res.id` is the primary path on purpose: the recommendation
 * doc goes through the toJSON plugin, which exposes `id` (unlike task
 * responses, which may carry `_id`).
 */
export function renderRecommendation(res, { projectId, lock, projectNameIgnored } = {}) {
  const doc = (res && typeof res === 'object' && (res.recommendation || res)) || {};
  const id = doc.id || doc._id || 'unknown';
  const status = doc.status || 'pending';
  const title =
    doc.payload && typeof doc.payload.title === 'string' ? doc.payload.title : '(untitled)';
  const where = projectId ? ` in project ${projectId}` : " in the owner's default project";

  const lines = [
    `Recommendation sent (id: ${id}, status: ${status}): "${title}"${where}.`,
    'Nothing was created yet. The account owner will see this suggestion in ' +
      "Planko's notification centre (and as a push notification) and can accept " +
      'it (which creates the task) or reject it.',
  ];
  if (projectNameIgnored) {
    lines.push(
      `Note: projectName was ignored because this server is locked to project ${lock}.`
    );
  }
  return lines.join('\n');
}

/**
 * Under a project lock the caller never chose the project, so the backend's
 * "Invalid projectId" would blame the wrong party. Rewrite it with lock context.
 * Coupled to the literal message in planko-back's newTask.handler
 * (`assertReferences`); if that wording changes the generic error still surfaces,
 * only the friendlier text is lost.
 */
export function describeLockError(err, lock) {
  if (lock && err && err.message === 'Invalid projectId') {
    return new Error(
      `The locked project (${lock}) is not accessible to this API key, so the recommendation was rejected.`
    );
  }
  return err;
}
