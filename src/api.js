/**
 * API client for Planko MCP Project Sync endpoints.
 * Uses native fetch (Node 18+).
 *
 * All external endpoints require projectId (user-scoped API key, PL012).
 */

const DEFAULT_API_BASE = 'https://api.planko.io/v1';

export function createApiClient({ apiKey, apiBase }) {
  const base = apiBase || process.env.PLANKO_API_BASE || DEFAULT_API_BASE;

  async function request(method, path, body) {
    const url = `${base}${path}`;
    const headers = { 'x-api-key': apiKey };

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
      throw new Error(msg);
    }

    return data;
  }

  return {
    /**
     * GET /mcp-project-sync/projects — list all projects accessible by the user
     */
    async projects() {
      return request('GET', '/mcp-project-sync/projects');
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
  };
}
