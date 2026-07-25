# planko-mcp-server

MCP server for syncing [Planko](https://planko.io) tasks with local Markdown files. Works with Claude Code, Cursor, and any MCP-compatible AI agent.

## Features

- **14 tools**: 3 folder-sync tools + 7 standalone task/note CRUD tools + 4 standalone read (list/view) tools
- **Type-aware sync**: each folder syncs either **tasks** (type=1) or **notes** (type=2), chosen at setup
- **Multi-folder**: sync multiple projects to different local folders
- **Bidirectional sync**: pull remote changes, push local changes
- **Delete sync**: deleted local files remove tasks on server; deleted tasks remove local files
- **Standalone CRUD**: create/edit/complete/delete tasks and notes directly, no folder setup required
- **Standalone read**: list and view tasks/notes with rich filters, no folder setup required
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
planko_setup(projectName: "My Project", folderPath: "/path/to/folder", email: "you@email.com", syncType: "tasks")
```

This maps a Planko project to a local folder. `syncType` is **required** and must be `"tasks"` or `"notes"`:

- `syncType: "tasks"` — the folder pulls/pushes only **tasks** (type=1). New local `.md` files are created as tasks.
- `syncType: "notes"` — the folder pulls/pushes only **notes** (type=2). New local `.md` files are created as notes.

A folder is bound to one type for its whole lifetime. To sync both tasks and notes for the same project, set up two folders. You can set up multiple projects pointing to different folders.

### Step 5 — Sync

```
planko_sync()
```

Tasks are pulled as `.md` files into your folder. Local changes are pushed back to Planko.

## Tools

The server exposes 14 tools in three groups: **folder-sync** tools (bind a project to a local folder), **standalone CRUD** tools (create/edit/complete/delete directly via your API key, no folder needed), and **standalone read** tools (list/view directly via your API key, no folder needed).

### Folder-sync tools

| Tool | Description | Parameters |
|---|---|---|
| `planko_setup` | Set up sync between a project and a local folder | `projectName`, `folderPath`, `email`, `syncType` (`tasks`\|`notes`) |
| `planko_sync_preview` | Preview what would be synced (read-only) | `projectName` (optional) |
| `planko_sync` | Execute bidirectional sync with delete support | `projectName` (optional) |

### Standalone CRUD tools

These work with the **same API key** and require **no folder setup**. Notes are Planko tasks with `type=2`; tasks are `type=1`. They live in the same collection, so edit/delete work on both. `create_*` tools accept all task/note properties as optional params (only `name` is required); the Markdown `description` is converted to Planko's rich-text (BlockNote) format automatically.

| Tool | Description | Key parameters |
|---|---|---|
| `planko_create_task` | Create a task (type=1) | `name` (required), `projectName` (optional), plus any properties below |
| `planko_create_note` | Create a note (type=2) | `name` (required), `projectName` (optional), plus any properties below |
| `planko_edit_task` | Edit an existing task by id | `taskId` (required), plus any properties to change |
| `planko_edit_note` | Edit an existing note by id (shares the task edit endpoint) | `taskId` (required), plus any properties to change |
| `planko_complete_task` | Mark a task complete (status=2) | `taskId` (required) |
| `planko_delete_task` | Delete a task by id | `taskId` (required) |
| `planko_delete_note` | Delete a note by id (shares the task delete endpoint) | `taskId` (required) |

**Optional properties** accepted by the create/edit tools (all optional; omit to leave unchanged):

| Property | Type | Notes |
|---|---|---|
| `description` | Markdown string | Converted to BlockNote JSON before saving |
| `dueDate` | ISO 8601 string | |
| `datePlain` | `YYYY-MM-DD` | |
| `time` / `endTime` | `HH:MM` | Start / end time |
| `alert` | boolean | Whether a reminder is enabled |
| `alertLeadTime` | `null`\|`ontime`\|`15min`\|`30min`\|`1hour`\|`1day` | Reminder lead time |
| `priority` | `1`\|`2`\|`3` | |
| `repeat` | `null`\|`daily`\|`workdays`\|`weekly`\|`biweekly`\|`monthly`\|`custom_weekly`\|`yearly` | Recurrence rule |
| `repeatDate` | ISO 8601 string | Recurrence anchor/end |
| `selectedWeekdays` | array of `0`–`6` | For `custom_weekly` (0=Sunday) |
| `parentId` | ObjectId | Parent task, for subtasks |
| `tags` | array of ObjectId | Tag ids |
| `kanbanColumnId` / `boardId` | ObjectId | Kanban placement |
| `type` | `1`\|`2` | (edit tools only) switch task↔note |
| `projectId` | ObjectId | (edit tools only) move to another project |

Notes:

- On create, `projectName` is resolved to a project id via your accessible projects (not the local folder config). If omitted, the backend applies your default project.
- `complete` sets status=2 and, for a recurring task, stops the series and completes the current occurrence.
- Reminders, recurrence, positions, kanban and timezone handling are all applied server-side (the tools reuse Planko's own task logic).

#### Examples

```
planko_create_task(name: "Ship v2", projectName: "Work", dueDate: "2026-08-01", priority: 1)
planko_create_note(name: "Meeting notes", description: "# Sync\n- point A\n- point B")
planko_edit_task(taskId: "665f...c0", name: "Ship v2.1", alertLeadTime: "1hour")
planko_complete_task(taskId: "665f...c0")
planko_delete_note(taskId: "665f...aa")
```

### Standalone read tools

These also work with the **same API key** and require **no folder setup**. `list_*` returns a concise, readable summary (one line per item plus a `total`/page footer) — never a raw JSON dump. `view_*` returns full detail with the `description` converted from BlockNote to **Markdown** for display.

| Tool | Description | Key parameters |
|---|---|---|
| `planko_list_tasks` | List your tasks (type=1) | all filters below |
| `planko_list_notes` | List your notes (type=2) | filter subset: `showCompleted`, `projectName`/`projectId`, `tags`, `search`, `sortBy`, `limit`, `page` |
| `planko_view_task` | View one task by id | `taskId` (required) |
| `planko_view_note` | View one note by id (shares the view endpoint) | `taskId` (required) |

**Scope.** Without `projectId`/`projectName`, a list is scoped to **your own** items. With a project (resolved from `projectName` via your accessible projects), it includes that project's items **including workspace-shared** ones from other members. `view_*` returns the item if you own it or can access its project, otherwise it errors (404 if missing, 403 if not visible). `view_task`/`view_note` do not filter by type — either id resolves; the `task`/`note` label is informational.

**List filters** (`planko_list_tasks` accepts all; `planko_list_notes` accepts the applicable subset):

| Filter | Type | Notes |
|---|---|---|
| `status` | `1` \| `2` | 1=open, 2=complete |
| `showCompleted` | boolean | When false/omitted and no explicit `status`, completed items are excluded |
| `priority` | `1` \| `2` \| `3` | (tasks only) |
| `projectName` | string | Resolved to a project id via your accessible projects |
| `projectId` | ObjectId | Alternative to `projectName` |
| `parentId` | ObjectId | (tasks only) list subtasks of this parent |
| `tags` | array of ObjectId | AND semantics — item must have all tags |
| `search` | string | Case-insensitive match on the name |
| `dueDateFrom` / `dueDateTo` | `YYYY-MM-DD` | (tasks only) inclusive due-date bounds |
| `sortBy` | `field:asc` \| `field:desc` | Fields: `dueDate`, `createdAt`, `updatedAt`, `priority`, `position`, `name`; default `updatedAt:desc` |
| `limit` | int | Default 50, max 200 |
| `page` | int | Default 1 |

Notes-specific behavior: deleted notes and recurring-copy notes are excluded server-side. For tasks, recurring occurrences appear as separate dated items.

#### Examples

```
planko_list_tasks(status: 1, priority: 1, dueDateFrom: "2026-07-20", dueDateTo: "2026-07-26", sortBy: "dueDate:asc")
planko_list_tasks(projectName: "Work", search: "invoice", limit: 20)
planko_list_notes(search: "meeting", showCompleted: false)
planko_view_task(taskId: "665f...c0")
planko_view_note(taskId: "665f...aa")
```

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

- Each Planko task/note maps to a local `.md` file (task name becomes filename)
- Each folder is **type-bound**: `planko_setup` records `type` (1=tasks, 2=notes) on the folder's sync state and in the global config, and sync only pulls/pushes that type. New local `.md` files are created with the folder's type.
  - The chosen `type` is sent to the backend on every `status`/`pull` (`&type=`) and `push` (body `type`) call.
  - Backward-compatible: a config entry created before this feature has no `type`, so its folder keeps the legacy type-agnostic behavior (syncs all task types).
- Task descriptions are converted between BlockNote and Markdown automatically
- Sync state is tracked in `.planko-mcp-sync.json` per folder (includes `syncType` when set)
- Global config is stored at `~/.planko-mcp/config.json` (each project entry stores `projectId`, `folder`, `email`, `type`)
- The standalone CRUD tools bypass folders entirely and call user-scoped endpoints directly with your API key
- API keys are never written to any file

## License

MIT
