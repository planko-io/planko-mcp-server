/**
 * Argument sanitization for MCP tool inputs.
 *
 * LLM tool-callers (especially GPT-class models) tend to fill EVERY schema
 * field with placeholder/default values instead of omitting optional ones:
 * empty strings, the all-zero ObjectId ("000000000000000000000000"), and
 * empty arrays. Left untouched, a placeholder `projectId` makes the backend
 * throw "Project not found", a placeholder `parentId` filters to a nonexistent
 * parent (→ 0 results), and empty `tags`/`search` add noise. Treat all of
 * these as "field omitted".
 */

export const ZERO_OBJECT_ID = '000000000000000000000000';

export function isBlankValue(value) {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === '' || trimmed === ZERO_OBJECT_ID;
  }
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

/**
 * LLM callers often put the date in `datePlain` and leave `dueDate` empty.
 * The backend derives datePlain FROM dueDate but not the reverse, so a
 * datePlain-only task ends up with dueDate=null and never appears on day/agenda
 * views (it looks "not created"). Mirror datePlain -> dueDate in that case.
 * Mutates and returns `body`.
 */
export function applyDueDateFallback(body) {
  if (isBlankValue(body.dueDate) && !isBlankValue(body.datePlain)) {
    body.dueDate = body.datePlain;
  }
  return body;
}
