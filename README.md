# planko-mcp-server

MCP server for syncing [Planko](https://planko.io) tasks with local Markdown files. Works with Claude Code, Cursor, and any MCP-compatible AI agent.

## Features

- **3 tools**: setup, sync preview, sync
- **Multi-folder**: sync multiple projects to different local folders
- **Bidirectional sync**: pull remote changes, push local changes
- **Delete sync**: deleted local files remove tasks on server; deleted tasks remove local files
- **User-scoped API key**: one key works across all your projects

## Install

No clone needed — run directly via `npx`:

```
npx planko-mcp-server
```

Requires Node.js 18+.

## Configuration

| Variable | Required | Description |
|---|---|---|
| `PLANKO_API_KEY` | Yes | Your MCP API key (generate at planko.io/app/integrations) |
| `PLANKO_API_BASE` | No | API base URL override (defaults to production) |

## Setup with Claude Code

Add to `.claude/settings.json`:

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

## Setup with Cursor

Add to `.cursor/mcp.json`:

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

## Tools

| Tool | Description | Parameters |
|---|---|---|
| `planko_setup` | Set up sync between a project and a local folder | `projectName`, `folderPath`, `email` |
| `planko_sync_preview` | Preview what would be synced (read-only) | `projectName` (optional) |
| `planko_sync` | Execute bidirectional sync with delete support | `projectName` (optional) |

## Usage

### 1. Setup a project folder

```
planko_setup(projectName: "My Project", folderPath: "/path/to/tasks", email: "you@example.com")
```

You can set up multiple projects pointing to different folders.

### 2. Preview changes

```
planko_sync_preview()                           # Preview all projects
planko_sync_preview(projectName: "My Project")  # Preview one project
```

### 3. Sync

```
planko_sync()                           # Sync all projects
planko_sync(projectName: "My Project")  # Sync one project
```

Sync order: delete -> pull -> push. Local changes overwrite remote on conflict.

## How it works

- Each Planko task maps to a local `.md` file (task name becomes filename)
- Task descriptions are converted between BlockNote and Markdown automatically
- Sync state is tracked in `planko-mcp-sync.json` per folder
- Global config is stored at `~/.planko-mcp/config.json`
- API keys are never written to any file

## Development

```bash
cd codebases/planko-mcp-server
npm install
npm test
```

## License

MIT
