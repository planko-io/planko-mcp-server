/**
 * Project-lock decision logic (pure, testable).
 *
 * When the env var PLANKO_PROJECT_LOCK is set, the MCP server restricts EVERY
 * operation to that single project id — a hard override the calling agent
 * cannot bypass. When the lock is null (the default), all functions here behave
 * as pass-throughs so existing callers (e.g. the "clawis" agent) are unaffected.
 *
 * These helpers are kept free of any I/O so they can be unit-tested directly;
 * the server entrypoint (index.js) wires them into the tool handlers.
 */

import { isBlankValue } from './sanitize.js';

/**
 * Decide the effective projectId.
 *   - lock set (truthy)  → always returns `lock` (ignores `requested`).
 *   - lock null/blank     → returns `requested` unchanged (pass-through).
 */
export function lockProjectId(lock, requested) {
  if (lock) return lock;
  return requested;
}

/**
 * Sanitize a bag of list/query filter params, dropping blank/placeholder values
 * (empty strings, all-zero ObjectId, empty arrays) via isBlankValue. Used for
 * every list filter including the optional `assigneeId` — when it is blank the
 * key is omitted, which the backend treats as "all members".
 * Returns a new object; does not mutate the input.
 */
export function sanitizeFilters(params) {
  const out = {};
  for (const [key, value] of Object.entries(params || {})) {
    if (isBlankValue(value)) continue;
    out[key] = value;
  }
  return out;
}

/**
 * Format an owner label from an item's `userId` field.
 * The backend may populate `userId` as an object { _id, name, email } on
 * list/view responses. Returns the owner's name when present, else null.
 * Tolerates a bare string/id (returns null) and never throws.
 */
export function ownerName(userId) {
  if (
    userId &&
    typeof userId === 'object' &&
    !Array.isArray(userId) &&
    typeof userId.name === 'string' &&
    userId.name.trim() !== ''
  ) {
    return userId.name;
  }
  return null;
}

/**
 * Extract a comparable project id string from a task's `projectId`, which may be
 * a bare id string or a populated object { _id, ... }.
 */
function projectIdOf(task) {
  const pid = task && task.projectId;
  if (pid && typeof pid === 'object') return pid._id != null ? String(pid._id) : '';
  return pid != null ? String(pid) : '';
}

/**
 * Guard a by-id operation against the lock. When `lock` is null this is a no-op.
 * When `lock` is set, throws unless the task belongs to the locked project.
 * A missing/unknown projectId also throws (cannot prove it is in-scope).
 */
export function assertProjectAllowed(lock, task) {
  if (!lock) return;
  const pid = projectIdOf(task);
  if (!pid || pid !== String(lock)) {
    throw new Error('This agent is restricted to the "planko" project.');
  }
}

/**
 * Under a project lock, LLM tool-callers (esp. GPT-class) reliably fabricate
 * these narrowing filters with plausible-but-wrong NON-blank values that
 * isBlankValue cannot catch: a 24-hex `parentId` copied from the project id, an
 * `assigneeId` derived from a chat user id, a guessed `priority`. Any of these
 * silently narrows a "list the whole team" query to zero. A locked agent's job
 * is "list everyone unless a member is named", and it cannot supply these
 * reliably, so they are dropped from both the tool schema and (defensively) the
 * API params. Member narrowing is done by NAME client-side (see matchesAssignee).
 */
export const HALLUCINATED_LIST_FILTERS = ['parentId', 'assigneeId', 'priority'];

/** Delete the fabrication-prone narrowing filters from an API param bag. */
export function stripHallucinatedListFilters(params) {
  for (const key of HALLUCINATED_LIST_FILTERS) delete params[key];
  return params;
}

/**
 * Client-side member filter by NAME (or email substring), case-insensitive.
 * Returns true (keep) when `needle` is blank (no narrowing) so the default is
 * "all members". Compares against the populated owner {name,email}; a bare-id
 * userId has no name/email and won't match a non-blank needle.
 */
export function matchesAssignee(userId, needle) {
  if (isBlankValue(needle)) return true;
  const owner = ownerName(userId);
  const email =
    userId && typeof userId === 'object' && typeof userId.email === 'string'
      ? userId.email
      : '';
  const hay = `${owner || ''} ${email}`.toLowerCase();
  return hay.includes(String(needle).trim().toLowerCase());
}

/** True when at least one item carries populated owner info (name/email). */
export function hasOwnerInfo(items) {
  return (
    Array.isArray(items) &&
    items.some((it) => it && ownerName(it.userId) !== null)
  );
}
