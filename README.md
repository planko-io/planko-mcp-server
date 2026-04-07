# planko-mcp-server

MCP server for syncing [Planko](https://planko.io) tasks with local Markdown files. Works with Claude Code, Cursor, and any MCP-compatible AI agent.

## Install

No clone needed — run directly via `npx`:

```
npx planko-mcp-server
```

Requires Node.js 18+.

## Configuration

The server is configured via environment variables:

| Variable | Required | Description |
|---|---|---|
| `PLANKO_SYNC_FOLDER` | Yes | Absolute path to the folder where `.md` task files are synced |
| `PLANKO_API_KEY` | Yes* | Project API key from Planko UI |
| `PLANKO_EMAIL` | Yes* | User email for task attribution |
| `PLANKO_API_BASE` | No | API base URL override (defaults to production) |

\* Can also be set via the `planko_setup` tool at runtime.

## Setup with Claude Code

Add to `.claude/settings.json`:

```json
{
  "mcpServers": {
    "planko": {
      "command": "npx",
      "args": ["-y", "planko-mcp-server"],
      "env": {
        "PLANKO_API_KEY": "pk_abc123...",
        "PLANKO_EMAIL": "user@example.com",
        "PLANKO_SYNC_FOLDER": "/absolute/path/to/tasks"
      }
    }
  }
}
```

## Setup with Cursor

Add to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "planko": {
      "command": "npx",
      "args": ["-y", "planko-mcp-server"],
      "env": {
        "PLANKO_API_KEY": "pk_abc123...",
        "PLANKO_EMAIL": "user@example.com",
        "PLANKO_SYNC_FOLDER": "/absolute/path/to/tasks"
      }
    }
  }
}
```

## Tools

| Tool | Description |
|---|---|
| `planko_setup` | Initialize sync for a project folder (alternative to env vars) |
| `planko_pull` | Pull remote task changes to local `.md` files |
| `planko_push` | Push local `.md` file changes to Planko |
| `planko_status` | Check sync status (changed tasks, conflicts, last sync time) |
| `planko_sync_preview` | Preview what would be synced (read-only) |
| `planko_sync` | Execute bidirectional sync (pull then push) |

## How it works

- Each Planko task maps to a local `.md` file (task name becomes filename)
- Task descriptions use BlockNote format internally — the server converts between BlockNote and Markdown automatically
- Sync state is tracked in `planko-mcp-sync.json` in the sync folder (no credentials stored)
- `planko_sync` pulls remote changes first, then pushes local changes
- Use `planko_sync_preview` before `planko_sync` to review conflicts

## Development

```bash
cd codebases/planko-mcp-server
npm install
npm test
```

## License

MIT
