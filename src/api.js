/**
 * API client for Planko MCP Project Sync endpoints.
 * Uses native fetch (Node 18+).
 *
 * All external endpoints require projectId (user-scoped API key, PL012).
 */

const DEFAULT_API_BASE = 'https://api.planko.io/v1';

/**
 * Build a JSON request function bound to a base URL and auth headers.
 * `statusInMessage` prefixes errors with the HTTP status (runner mode: the agent
 * must see *why* a call failed). The user client keeps the plain backend message.
 */
function makeRequest({ base, headers: authHeaders, statusInMessage = false }) {
  return async function request(method, path, body) {
    const url = `${base}${path}`;
    const headers = { ...authHeaders };

    const options = { method, headers };

    if (body) {
      headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(body);
    }

    const res = await fetch(url, options);
    const text = await res.text();

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }

    if (!res.ok) {
      const msg =
        typeof data === 'object' && data.message
          ? data.message
          : `API returned HTTP ${res.status}`;
      const err = new Error(statusInMessage ? `HTTP ${res.status}: ${msg}` : msg);
      err.status = res.status;
      throw err;
    }

    return data;
  };
}

export function createApiClient({ apiKey, apiBase }) {
  const base = apiBase || process.env.PLANKO_API_BASE || DEFAULT_API_BASE;
  const request = makeRequest({ base, headers: { 'x-api-key': apiKey } });

  return {
    /**
     * GET /mcp-project-sync/projects — list all projects accessible by the user
     */
    async projects() {
      return request('GET', '/mcp-project-sync/projects');
    },

    /**
     * GET /mcp-project-sync/boards — the caller's kanban boards (personal +
     * workspace), each with its columns: { personal: [...], workspace: [...] }.
     */
    async boards() {
      return request('GET', '/mcp-project-sync/boards');
    },

    /**
     * GET /mcp-project-sync/status?projectId=...&mcpLastSyncDate=...&type=...
     * `type` (1=tasks, 2=notes) is appended whenever set, independent of mcpLastSyncDate.
     */
    async status(projectId, mcpLastSyncDate, type) {
      let qs = `projectId=${projectId}`;
      if (mcpLastSyncDate != null) {
        qs += `&mcpLastSyncDate=${mcpLastSyncDate}`;
      }
      if (type === 1 || type === 2) {
        qs += `&type=${type}`;
      }
      return request('GET', `/mcp-project-sync/status?${qs}`);
    },

    /**
     * GET /mcp-project-sync/pull?projectId=...&mcpLastSyncDate=...&type=...
     */
    async pull(projectId, mcpLastSyncDate, type) {
      let qs = `projectId=${projectId}`;
      if (mcpLastSyncDate != null) {
        qs += `&mcpLastSyncDate=${mcpLastSyncDate}`;
      }
      if (type === 1 || type === 2) {
        qs += `&type=${type}`;
      }
      return request('GET', `/mcp-project-sync/pull?${qs}`);
    },

    /**
     * POST /mcp-project-sync/push
     * `type` (1=tasks, 2=notes) is included in the body whenever set.
     */
    async push(projectId, tasks, type) {
      const body = { projectId, tasks };
      if (type === 1 || type === 2) {
        body.type = type;
      }
      return request('POST', '/mcp-project-sync/push', body);
    },

    // --- Standalone CRUD (user-scoped, no folder sync required) ---

    /**
     * POST /mcp-project-sync/tasks — create a task (type=1) or note (type=2).
     */
    async createTask(body) {
      return request('POST', '/mcp-project-sync/tasks', body);
    },

    /**
     * PATCH /mcp-project-sync/tasks/:taskId — edit a task or note.
     */
    async updateTask(taskId, body) {
      return request('PATCH', `/mcp-project-sync/tasks/${taskId}`, body);
    },

    /**
     * POST /mcp-project-sync/tasks/:taskId/complete — mark complete (status=2).
     */
    async completeTask(taskId) {
      return request('POST', `/mcp-project-sync/tasks/${taskId}/complete`);
    },

    /**
     * DELETE /mcp-project-sync/tasks/:taskId — delete a task or note.
     */
    async deleteTask(taskId) {
      return request('DELETE', `/mcp-project-sync/tasks/${taskId}`);
    },

    /**
     * POST /mcp-project-sync/recommendations — suggest something to the API
     * key's owner (PL274). Body { type, payload }; returns the Recommendation
     * doc (status 'pending'). The task is only created when the owner accepts.
     */
    async createRecommendation(body) {
      return request('POST', '/mcp-project-sync/recommendations', body);
    },

    // --- Read (user-scoped, no folder sync required) ---

    /**
     * GET /mcp-project-sync/tasks — list the user's tasks (type=1) or notes
     * (type=2) with parametrized filters. Builds the query string from `params`,
     * omitting undefined/null values. A `tags` array is serialized to a CSV
     * string (the backend splits on comma).
     */
    async listTasks(params = {}) {
      const qs = new URLSearchParams();
      for (const [key, value] of Object.entries(params)) {
        if (value === undefined || value === null) continue;
        if (key === 'tags' && Array.isArray(value)) {
          if (value.length === 0) continue;
          qs.set(key, value.join(','));
        } else {
          qs.set(key, String(value));
        }
      }
      const query = qs.toString();
      return request(
        'GET',
        `/mcp-project-sync/tasks${query ? `?${query}` : ''}`
      );
    },

    /**
     * GET /mcp-project-sync/tasks/:taskId — fetch one task or note by id.
     */
    async getTask(taskId) {
      return request('GET', `/mcp-project-sync/tasks/${taskId}`);
    },
  };
}

/**
 * PL330 — API client of the agentic-tasks runner, authenticated with a runner
 * token (`pk_run_…`, per executor), never with the user API key.
 */
export function createRunnerApiClient({ runnerToken, apiBase }) {
  const request = makeRequest({
    base: apiBase || process.env.PLANKO_API_BASE || DEFAULT_API_BASE,
    headers: { Authorization: `Bearer ${runnerToken}` },
    statusInMessage: true,
  });

  return {
    /** POST /agent/runner/claim — long-poll; { task } or { task: null } */
    claim: (waitSec) => request('POST', '/agent/runner/claim', waitSec == null ? {} : { waitSec }),

    /**
     * POST /agent/runner/tasks/:taskId/finish — bound to the claim by claimSeq; optional runMeta
     * (run summary, E9). A back older than E1a rejects the unknown key with a 400 that cites it:
     * the finish is sent once more without runMeta so the task still closes.
     */
    finish: async (taskId, { result, error, claimSeq, runMeta }) => {
      const path = `/agent/runner/tasks/${taskId}/finish`;
      const body = { result, error: !!error, claimSeq };
      if (runMeta && Object.keys(runMeta).length) body.runMeta = runMeta;
      try {
        return await request('POST', path, body);
      } catch (err) {
        if (!body.runMeta || err.status !== 400 || !/runMeta/.test(err.message)) throw err;
        delete body.runMeta;
        return request('POST', path, body);
      }
    },

    /** POST /agent/runner/tasks/:taskId/subtasks — suggest a subtask under an agentic task */
    suggestSubtask: (taskId, body) => request('POST', `/agent/runner/tasks/${taskId}/subtasks`, body),
  };
}
