# Planko MCP Server — Implementation Plan

## Context

- **PL007** defines 3 backend endpoints (`status`, `pull`, `push`) + an `enable` UI flow, already implemented/in-progress in planko-back
- **planko-mcp-sync.js** (`scripts/planko-mcp-sync.js`) is a standalone CLI/POC script that syncs a local folder of `.md` files with Planko tasks via those endpoints. It handles: setup, pull, push, BlockNote-Markdown conversion, and sync state tracking via `planko-mcp-sync.json`
- **planko-mcp** (`codebases/planko-mcp`) is discontinued and should be ignored

## Goal

Build an **open, publishable MCP server** (`planko-mcp-server` on npm) that any user can install via `npx planko-mcp-server` and start syncing Planko tasks with their local folder. The server uses the Model Context Protocol SDK (stdio transport) so AI agents (Claude Code, Cursor, etc.) can call its tools directly. This repo (`codebases/planko-mcp-server/`) is the source for the npm package — users never need to clone it.

---

## Step 1 — Scaffold the npm package

- Directory: `codebases/planko-mcp-server/` (source repo, published to npm as `planko-mcp-server`)
- Use `@modelcontextprotocol/sdk` (official MCP SDK for Node.js)
- Single entry point: `index.js` with `#!/usr/bin/env node` shebang
- `package.json`:
  - `name`: `planko-mcp-server`
  - `type`: `module` (ESM — required by `@modelcontextprotocol/sdk`)
  - `bin`: `{ "planko-mcp-server": "./index.js" }` — makes it runnable via `npx planko-mcp-server`
  - `files`: `["index.js", "src/", "README.md", "LICENSE"]` — explicit allowlist, no `.npmignore`
  - `engines`: `{ "node": ">=18.0.0" }` (native `fetch` + MCP SDK requirement)
- Add a `README.md` with install/usage instructions for end users

## Step 2 — Extract reusable logic from the POC

Move these from `scripts/planko-mcp-sync.js` into ESM modules inside the package. All modules use native `fetch` instead of the POC's `http`/`https` dual-module pattern (available since Node 18).

- **`src/api.js`** — API client using `fetch`, API_BASE defaults to `https://api.planko.io/v1` (configurable via env)
- **`src/converters.js`** — BlockNote-Markdown conversion (`blockNoteToMarkdown`, `markdownToBlockNote`, and helpers)
  - **Fix from POC**: `markdownToBlockNote` must handle indented lines as nested children (the POC flattens them into paragraphs, causing nesting loss on round-trip pull→push→pull)
- **`src/sync-state.js`** — read/write `planko-mcp-sync.json`, file scanning, mtime tracking
  - **Fix from POC**: the sync state file must **never** store the API key — credentials come exclusively from env vars. The sync file only contains: project metadata, task state mappings (id ↔ filename), and sync timestamps
  - **Fix from POC**: task names must be stored/compared **without** the `.md` extension. `toFileName()` adds `.md` for local files, but the `name` sent to the API must be the bare name (e.g., `"My Task"`, not `"My Task.md"`). The pull side derives filenames by appending `.md` to the task name. This prevents `"Task.md.md"` corruption on round-trips

## Step 3 — Define MCP Tools

**As shipped**, the server exposes 10 tools: 3 folder-sync tools + 7 standalone CRUD tools. (The earlier `planko_pull`/`planko_push`/`planko_status` were folded into the bidirectional `planko_sync`/`planko_sync_preview`.)

Folder-sync tools:

| Tool                  | Description                                         | Params                                                        |
| --------------------- | --------------------------------------------------- | ------------------------------------------------------------- |
| `planko_setup`        | Initialize sync for a project folder                | `projectName`, `folderPath`, `email`, `syncType` (`tasks`\|`notes`) |
| `planko_sync_preview` | Preview what would be synced (read-only, no writes) | `projectName` (optional)                                      |
| `planko_sync`         | Execute bidirectional sync (delete, pull, push)     | `projectName` (optional)                                      |

`syncType` binds the folder to tasks (type=1) or notes (type=2); the type is threaded into every `status`/`pull`/`push` call and used when creating new local files. Legacy config entries without a type keep type-agnostic behavior.

Standalone CRUD tools (user-scoped API key, no folder required):

| Tool                    | Description                             | Params                                                    |
| ----------------------- | --------------------------------------- | --------------------------------------------------------- |
| `planko_create_task`    | Create a task (type=1)                  | `name` (required), `projectName` (optional), task props   |
| `planko_create_note`    | Create a note (type=2)                  | `name` (required), `projectName` (optional), task props   |
| `planko_edit_task`      | Edit a task by id                       | `taskId` (required), editable props                       |
| `planko_edit_note`      | Edit a note by id (shared edit endpoint)| `taskId` (required), editable props                       |
| `planko_complete_task`  | Mark a task complete (status=2)         | `taskId` (required)                                       |
| `planko_delete_task`    | Delete a task by id                     | `taskId` (required)                                       |
| `planko_delete_note`    | Delete a note by id (shared endpoint)   | `taskId` (required)                                       |

Folder-sync tools operate on the folders configured via `planko_setup` (stored in `~/.planko-mcp/config.json`). The CRUD tools operate directly via the `PLANKO_API_KEY`.

### Error handling

All tools catch errors and return them as `isError: true` content in the MCP tool response. The server process **never** calls `process.exit()` on API or sync errors — it stays alive on the stdio transport. Only startup failures (missing SDK, broken config) may exit.

### `planko_sync_preview` + `planko_sync` — bidirectional sync with preview

These are two separate, stateless tools (MCP tools are request/response with no session state):

**`planko_sync_preview`** (read-only) — calls `status` API + scans local files to compute and return:

- Files that would be **pushed** (locally modified since last sync) — list file names
- Tasks that would be **pulled** (remotely modified since last sync) — list task names
- **Conflicts** — tasks modified both locally AND remotely since last sync. For each conflict, report: task name, local mtime, remote `mcpSyncDate`. The preview does not resolve conflicts — it informs the user so they can decide. Note: `planko_sync` (execute) uses pull-then-push order, meaning remote changes are pulled first, then local changes overwrite. Conflicts where the user wants to keep the remote version should be handled by discarding the local file before calling `planko_sync`.

**`planko_sync`** (writes) — executes the actual sync: pull first, then push. The agent should call `planko_sync_preview` first and show the user the summary before calling this.

### `planko_status` output

Returns a human-readable summary: "3 tasks modified locally, 2 tasks modified remotely, 1 conflict. Last sync: 2 hours ago." — not a raw JSON blob. The AI agent surfaces this directly to the user.

### `planko_setup` vs env vars

Env vars (`PLANKO_API_KEY`, `PLANKO_EMAIL`) are the primary config source. If set, `planko_setup` is not required — the server auto-initializes on the first tool call. `planko_setup` exists for agents that need to configure programmatically (e.g., different project per folder). When both are present, explicit `planko_setup` params take precedence for that session. Credentials are **never** written to the sync state file regardless of source.

## Step 4 — Wire up the MCP server

```
index.js (entry point, #!/usr/bin/env node, ESM)
  └── Server (stdio transport, @modelcontextprotocol/sdk)
        └── tools/
              ├── planko_setup         → initialize sync config (records syncType)
              ├── planko_sync_preview  → read-only diff summary with conflict detection
              ├── planko_sync          → execute delete → pull → push
              ├── planko_create_task   → create task (type=1) via API key
              ├── planko_create_note   → create note (type=2) via API key
              ├── planko_edit_task     → edit task by id
              ├── planko_edit_note     → edit note by id (shared edit endpoint)
              ├── planko_complete_task → mark task complete (status=2)
              ├── planko_delete_task   → delete task by id
              └── planko_delete_note   → delete note by id (shared endpoint)
```

## Step 5 — Configuration

Users configure via **environment variables** passed through the MCP server config — no need to clone any repo:

- `PLANKO_API_KEY` — project API key (from Planko UI). **Required** (via env or `planko_setup`)
- `PLANKO_EMAIL` — user email for task attribution. **Required** (via env or `planko_setup`)
- `PLANKO_API_BASE` — optional, defaults to `https://api.planko.io/v1`
- `PLANKO_SYNC_FOLDER` — **Required**. Absolute path to the local folder where `.md` task files are synced. The server will refuse to start if this is not set.

## Step 6 — Installation & registration

### For end users (no clone needed)

Claude Code (`.claude/settings.json`):

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

Cursor (`.cursor/mcp.json`):

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

### For development (this repo)

```json
{
  "mcpServers": {
    "planko": {
      "command": "node",
      "args": ["/path/to/codebases/planko-mcp-server/index.js"],
      "env": {
        "PLANKO_API_KEY": "...",
        "PLANKO_EMAIL": "...",
        "PLANKO_SYNC_FOLDER": "/absolute/path/to/tasks"
      }
    }
  }
}
```

## Step 7 — Publish to npm

- `npm publish` from `codebases/planko-mcp-server/`
- Add `prepublishOnly` script for basic sanity check
- Users install with `npx planko-mcp-server` (zero setup beyond env vars)
- Version follows semver

## Step 8 — Test & iterate

- Test each tool via Claude Code directly
- Ensure pull/push cycle is idempotent
- Test `planko_sync_preview` → `planko_sync` flow end-to-end
- Verify conflict detection surfaces correctly in preview
- Verify `.md` extension handling: task name "My Task" → local file `My Task.md` → push sends "My Task" (no double extension)
- Verify BlockNote nesting survives round-trip (pull → edit → push → pull)
