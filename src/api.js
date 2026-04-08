/**
 * API client for Planko MCP Project Sync endpoints.
 * Uses native fetch (Node 18+).
 *
 * All external endpoints require projectId (user-scoped API key, PL012).
 */

const DEFAULT_API_BASE = 'https://planko-426622.ue.r.appspot.com/v1';

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
     * GET /mcp-project-sync/status?projectId=...&mcpLastSyncDate=...
     */
    async status(projectId, mcpLastSyncDate) {
      let qs = `projectId=${projectId}`;
      if (mcpLastSyncDate != null) {
        qs += `&mcpLastSyncDate=${mcpLastSyncDate}`;
      }
      return request('GET', `/mcp-project-sync/status?${qs}`);
    },

    /**
     * GET /mcp-project-sync/pull?projectId=...&mcpLastSyncDate=...
     */
    async pull(projectId, mcpLastSyncDate) {
      let qs = `projectId=${projectId}`;
      if (mcpLastSyncDate != null) {
        qs += `&mcpLastSyncDate=${mcpLastSyncDate}`;
      }
      return request('GET', `/mcp-project-sync/pull?${qs}`);
    },

    /**
     * POST /mcp-project-sync/push
     */
    async push(projectId, tasks) {
      return request('POST', '/mcp-project-sync/push', {
        projectId,
        tasks,
      });
    },
  };
}
