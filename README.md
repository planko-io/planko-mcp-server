# planko-mcp-server

MCP server for syncing [Planko](https://planko.io) tasks with local Markdown files. Works with Claude Code, Cursor, and any MCP-compatible AI agent.

## Features

- **3 tools**: setup, sync preview, sync
- **Multi-folder**: sync multiple projects to different local folders
- **Bidirectional sync**: pull remote changes, push local changes
- **Delete sync**: deleted local files remove tasks on server; deleted tasks remove local files
- **User-scoped API key**: one key works across all your projects

## Getting Started

### Step 1 — Get your API key

1. Open [app.planko.io/integrations](https://app.planko.io/integrations)
2. Find the **Model Context Protocol (MCP)** card
3. Click **"Ativar"** to generate your API key
4. Copy the key (you can only see it once — regenerate if you lose it)

### Step 2 — Add to your MCP client

**Claude Code** — add to `.mcp.json` in your project root (or `~/.claude/settings.local.json` for global):

```json
{
  "mcpServers": {
    "planko": {
      "command": "npx",
      "args": ["-y", "planko-mcp-server"],
      "env": {
        "PLANKO_API_KEY": "your-api-key"
      }
    }
  }
}
```

**Cursor** — add to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "planko": {
      "command": "npx",
      "args": ["-y", "planko-mcp-server"],
      "env": {
        "PLANKO_API_KEY": "your-api-key"
      }
    }
  }
}
```

No `npm install` or cloning needed. Requires Node.js 18+.

### Step 3 — Restart your tool

Restart Claude Code, Cursor, or whichever MCP client you use so it picks up the new server.

### Step 4 — Setup a project folder

Ask your AI agent to run:

```
planko_setup(projectName: "My Project", folderPath: "/path/to/folder", email: "you@email.com")
```

This maps a Planko project to a local folder. You can set up multiple projects pointing to different folders.

### Step 5 — Sync

```
planko_sync()
```

Tasks are pulled as `.md` files into your folder. Local changes are pushed back to Planko.

## Tools

| Tool | Description | Parameters |
|---|---|---|
| `planko_setup` | Set up sync between a project and a local folder | `projectName`, `folderPath`, `email` |
| `planko_sync_preview` | Preview what would be synced (read-only) | `projectName` (optional) |
| `planko_sync` | Execute bidirectional sync with delete support | `projectName` (optional) |

### Sync preview

```
planko_sync_preview()                           # Preview all projects
planko_sync_preview(projectName: "My Project")  # Preview one project
```

### Sync

```
planko_sync()                           # Sync all projects
planko_sync(projectName: "My Project")  # Sync one project
```

When `projectName` is omitted, all configured projects are synced.

Sync order: delete, pull, push. Local changes overwrite remote on conflict.

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `PLANKO_API_KEY` | Yes | Your MCP API key from app.planko.io/integrations |
| `PLANKO_API_BASE` | No | API base URL override (defaults to production) |

## How it works

- Each Planko task maps to a local `.md` file (task name becomes filename)
- Task descriptions are converted between BlockNote and Markdown automatically
- Sync state is tracked in `.planko-mcp-sync.json` per folder
- Global config is stored at `~/.planko-mcp/config.json`
- API keys are never written to any file

## License

MIT
