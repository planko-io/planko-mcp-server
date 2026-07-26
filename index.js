#!/usr/bin/env node

/**
 * planko-mcp-server — MCP server for syncing Planko tasks with local .md files.
 *
 * Environment variables:
 *   PLANKO_API_KEY  (required) — user-scoped MCP API key
 *   PLANKO_API_BASE — optional API base URL override
 *
 * Tools:
 *   planko_setup        — Configure sync for a project folder
 *   planko_sync_preview — Preview what would be synced
 *   planko_sync         — Execute bidirectional sync with delete support
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { createApiClient } from './src/api.js';
import { isBlankValue, applyDueDateFallback } from './src/sanitize.js';
import {
  lockProjectId,
  sanitizeFilters,
  ownerName,
  assertProjectAllowed,
  stripHallucinatedListFilters,
  matchesAssignee,
  hasOwnerInfo,
} from './src/projectLock.js';
import {
  blockNoteToMarkdown,
  markdownToBlockNote,
  descriptionToMarkdown,
  markdownToDescription,
} from './src/converters.js';
import {
  readConfig,
  writeConfig,
  readSyncState,
  writeSyncState,
  createSyncState,
  listLocalFiles,
  getFileMtimeMs,
  deleteLocalFile,
  toFileName,
  toTaskName,
  buildIndexes,
  SYNC_FILE,
} from './src/sync-state.js';

// --- Startup validation ---

const API_KEY = process.env.PLANKO_API_KEY;
if (!API_KEY) {
  console.error(
    'Fatal: PLANKO_API_KEY environment variable is required.'
  );
  process.exit(1);
}

const api = createApiClient({ apiKey: API_KEY });

// Optional project lock. When set, EVERY operation is confined to this single
// project id (a hard override the agent cannot bypass). Read once at startup.
// When null (the default) behavior is identical to before this feature.
const PROJECT_LOCK = (process.env.PLANKO_PROJECT_LOCK || '').trim() || null;

// --- Tool helpers ---

function toolOk(text) {
  return { content: [{ type: 'text', text }] };
}

function toolError(text) {
  return { content: [{ type: 'text', text }], isError: true };
}

// --- Sync engine (shared by preview and sync) ---

/**
 * Compute sync diff for a single project folder.
 * Returns { wouldPush, wouldPull, wouldDeleteLocal, wouldDeleteRemote, conflicts }
 */
async function computeSyncDiff(projectId, folder, sync) {
  const localFiles = listLocalFiles(folder);
  const { byFileName, byId } = buildIndexes(sync.tasks);
  const syncType = sync.syncType;

  // Get ALL tasks from server (no mcpLastSyncDate filter) to detect deletions
  const statusData = await api.status(projectId, null, syncType);
  const remoteTasks = statusData.tasks || [];
  const remoteIdSet = new Set(remoteTasks.map((t) => t._id.toString()));

  // --- Local changes (would be pushed) ---
  const wouldPush = [];
  const localMtimes = {};

  for (const fname of localFiles) {
    const filePath = join(folder, fname);
    const mtimeMs = Math.floor(getFileMtimeMs(filePath));
    localMtimes[fname] = mtimeMs;

    if (fname in byFileName) {
      const task = sync.tasks[byFileName[fname]];
      const lastKnownMtime = task.mcpLastLocalUpdate;
      let isModified = false;
      if (task._id == null) {
        isModified = true; // new task
      } else if (lastKnownMtime != null) {
        isModified = mtimeMs > lastKnownMtime;
      } else if (sync.mcpLastSyncDate == null || mtimeMs > sync.mcpLastSyncDate) {
        isModified = true;
      }
      if (isModified) {
        wouldPush.push({ name: toTaskName(fname), fileName: fname, _id: task._id });
      }
    } else {
      // New local file — will be created on server
      wouldPush.push({ name: toTaskName(fname), fileName: fname, _id: null });
    }
  }

  // --- Remote changes (would be pulled) ---
  const wouldPull = [];
  for (const rt of remoteTasks) {
    if (
      rt.mcpSyncDate &&
      sync.mcpLastSyncDate &&
      new Date(rt.mcpSyncDate).getTime() > sync.mcpLastSyncDate
    ) {
      wouldPull.push({ name: rt.name, _id: rt._id.toString() });
    } else if (!sync.mcpLastSyncDate) {
      // First sync — pull everything not already local
      const fname = toFileName(rt.name);
      if (fname && !(fname in byFileName)) {
        wouldPull.push({ name: rt.name, _id: rt._id.toString() });
      }
    }
  }

  // --- Detect deletions ---
  const localFileSet = new Set(localFiles);

  // Tasks in sync state that have an _id but are no longer on the server → deleted remotely
  const wouldDeleteLocal = [];
  for (const task of sync.tasks) {
    if (task._id && !remoteIdSet.has(task._id.toString())) {
      wouldDeleteLocal.push({ name: task.name, fileName: task.fileName, _id: task._id });
    }
  }

  // Tasks in sync state that have an _id and fileName but the local file is gone → deleted locally
  const wouldDeleteRemote = [];
  for (const task of sync.tasks) {
    if (task._id && task.fileName && !localFileSet.has(task.fileName)) {
      // Only if the task still exists on server
      if (remoteIdSet.has(task._id.toString())) {
        wouldDeleteRemote.push({ name: task.name, fileName: task.fileName, _id: task._id });
      }
    }
  }

  // --- Conflicts ---
  const conflicts = [];
  const pushNames = new Set(wouldPush.map((p) => p.name));
  for (const pull of wouldPull) {
    if (pushNames.has(pull.name)) {
      conflicts.push({
        name: pull.name,
        localMtime: localMtimes[toFileName(pull.name)]
          ? new Date(localMtimes[toFileName(pull.name)]).toISOString()
          : 'unknown',
      });
    }
  }

  return { wouldPush, wouldPull, wouldDeleteLocal, wouldDeleteRemote, conflicts };
}

/**
 * Execute sync for a single project folder.
 */
async function executeSync(projectId, folder, sync) {
  const localFiles = listLocalFiles(folder);
  const prePullSyncDate = sync.mcpLastSyncDate;
  const syncType = sync.syncType;
  const results = [];

  // Get ALL tasks to detect deletions
  const allStatusData = await api.status(projectId, null, syncType);
  const allRemoteTasks = allStatusData.tasks || [];
  const remoteIdSet = new Set(allRemoteTasks.map((t) => t._id.toString()));

  // --- DELETE phase (remote → local): remove local files for tasks deleted on server ---
  const localFileSet = new Set(localFiles);
  let deletedLocalCount = 0;
  const tasksToRemoveFromState = [];

  for (const task of sync.tasks) {
    if (task._id && !remoteIdSet.has(task._id.toString())) {
      // Task was deleted on server — remove local file
      if (task.fileName && deleteLocalFile(folder, task.fileName)) {
        deletedLocalCount++;
      }
      tasksToRemoveFromState.push(task._id);
    }
  }

  // Remove deleted tasks from sync state
  if (tasksToRemoveFromState.length > 0) {
    const removeSet = new Set(tasksToRemoveFromState.map((id) => id.toString()));
    sync.tasks = sync.tasks.filter((t) => !t._id || !removeSet.has(t._id.toString()));
  }

  if (deletedLocalCount > 0) {
    results.push(`Deleted locally: ${deletedLocalCount} file(s) (removed on server)`);
  }

  // --- DELETE phase (local → remote): delete tasks on server for locally deleted files ---
  const currentLocalFiles = new Set(listLocalFiles(folder));
  const toDeleteRemote = [];

  for (const task of sync.tasks) {
    if (task._id && task.fileName && !currentLocalFiles.has(task.fileName)) {
      if (remoteIdSet.has(task._id.toString())) {
        toDeleteRemote.push({ _id: task._id, name: task.name, deleted: true });
      }
    }
  }

  if (toDeleteRemote.length > 0) {
    const deleteResponse = await api.push(projectId, toDeleteRemote, syncType);
    const deletedRemote = (deleteResponse.tasks || []).filter((t) => t.deleted);
    // Remove deleted tasks from sync state
    const deletedIds = new Set(deletedRemote.map((t) => t._id.toString()));
    sync.tasks = sync.tasks.filter((t) => !t._id || !deletedIds.has(t._id.toString()));
    results.push(`Deleted remotely: ${deletedRemote.length} task(s) (removed locally)`);
  }

  // --- PULL phase ---
  const pullData = await api.pull(projectId, prePullSyncDate, syncType);
  const pulledTasks = pullData.tasks || [];

  const { byId } = buildIndexes(sync.tasks);
  const pulledNames = [];

  for (const pt of pulledTasks) {
    const fileName = toFileName(pt.name);
    const fileContent = descriptionToMarkdown(pt.description);

    const entry = {
      _id: pt._id,
      mcpSyncDate: pt.mcpSyncDate || null,
      fileName,
      name: pt.name,
      mcpLastLocalUpdate: null,
    };

    if (pt._id in byId) {
      sync.tasks[byId[pt._id]] = entry;
    } else {
      sync.tasks.push(entry);
    }
    pulledNames.push(pt.name);

    if (fileName) {
      writeFileSync(join(folder, fileName), fileContent);
    }
  }

  sync.mcpLastSyncPullChanges = pulledNames;
  results.push(`Pulled: ${pulledTasks.length} task(s)`);
  if (pulledNames.length > 0) {
    pulledNames.forEach((n) => results.push(`  - ${n}`));
  }

  // --- PUSH phase ---
  const { byFileName: fnIdx2 } = buildIndexes(sync.tasks);
  const refreshedFiles = listLocalFiles(folder);

  for (const fname of refreshedFiles) {
    const filePath = join(folder, fname);
    const mtimeMs = Math.floor(getFileMtimeMs(filePath));

    if (fname in fnIdx2) {
      sync.tasks[fnIdx2[fname]].mcpLastLocalUpdate = mtimeMs;
    } else {
      sync.tasks.push({
        _id: null,
        mcpSyncDate: null,
        fileName: fname,
        name: toTaskName(fname),
        mcpLastLocalUpdate: mtimeMs,
      });
    }
  }

  const tasksToPush = sync.tasks.filter((t) => {
    if (t.mcpLastLocalUpdate == null) return false;
    if (t._id == null) return true;
    if (prePullSyncDate == null) return true;
    return t.mcpLastLocalUpdate > prePullSyncDate;
  });

  if (tasksToPush.length === 0) {
    results.push('Pushed: 0 task(s) (no local changes)');
  } else {
    const pushItems = [];
    for (const t of tasksToPush) {
      if (!t.fileName) continue;
      const filePath = join(folder, t.fileName);
      const content = existsSync(filePath)
        ? readFileSync(filePath, 'utf-8')
        : null;
      const description = content
        ? JSON.stringify(markdownToBlockNote(content))
        : null;

      pushItems.push({
        _id: t._id,
        name: toTaskName(t.fileName),
        description,
      });
    }

    const pushResponse = await api.push(projectId, pushItems, syncType);
    const responseTasks = (pushResponse.tasks || []).filter((t) => !t.deleted);

    const { byId: pushIdIdx, byFileName: pushFnIdx } = buildIndexes(sync.tasks);
    const pushedNames = [];

    for (const rt of responseTasks) {
      pushedNames.push(rt.name);
      const rtFileName = toFileName(rt.name);

      if (rt._id in pushIdIdx) {
        const idx = pushIdIdx[rt._id];
        sync.tasks[idx].mcpSyncDate = rt.mcpSyncDate;
        sync.tasks[idx].name = rt.name;
        if (rtFileName) sync.tasks[idx].fileName = rtFileName;
      } else if (rtFileName && rtFileName in pushFnIdx) {
        const idx = pushFnIdx[rtFileName];
        sync.tasks[idx]._id = rt._id;
        sync.tasks[idx].mcpSyncDate = rt.mcpSyncDate;
        sync.tasks[idx].name = rt.name;
        sync.tasks[idx].fileName = rtFileName;
      }
    }

    sync.mcpLastSyncPushChanges = pushedNames;
    results.push(`Pushed: ${responseTasks.length} task(s)`);
    if (pushedNames.length > 0) {
      pushedNames.forEach((n) => results.push(`  - ${n}`));
    }

    const errors = pushResponse.errors || [];
    if (errors.length > 0) {
      results.push(
        `${errors.length} push error(s):`,
        ...errors.map((e) => `  - Task ${e._id || e.index}: ${e.reason}`)
      );
    }
  }

  sync.mcpLastSyncDate = Date.now();
  writeSyncState(folder, sync);

  return results;
}

// --- MCP Server ---

const server = new McpServer({
  name: 'planko-mcp-server',
  version: '0.5.0',
});

// ---- planko_setup ----
server.tool(
  'planko_setup',
  'Set up sync between a Planko project and a local folder. Supports multiple project-folder mappings. The user must provide the project name, local folder path, email, and whether the folder syncs tasks or notes.',
  {
    projectName: z.string().describe('Name of the Planko project to sync'),
    folderPath: z.string().describe('Absolute path to the local folder for .md task files'),
    email: z.string().email().describe('User email for task attribution'),
    syncType: z
      .enum(['tasks', 'notes'])
      .describe("Whether this folder syncs 'tasks' (type=1) or 'notes' (type=2)"),
  },
  async ({ projectName, folderPath, email, syncType }) => {
    try {
      // List user's projects to find the matching one
      const { projects } = await api.projects();

      const match = projects.find(
        (p) => p.name.toLowerCase() === projectName.toLowerCase()
      );

      if (!match) {
        const available = projects.map((p) => `  - ${p.name}`).join('\n');
        return toolError(
          `Project "${projectName}" not found.\n\nAvailable projects:\n${available}`
        );
      }

      // Ensure folder exists
      if (!existsSync(folderPath)) {
        mkdirSync(folderPath, { recursive: true });
      }

      const type = syncType === 'notes' ? 2 : 1;

      // Save to global config
      const config = readConfig();
      config.projects = config.projects || {};
      config.projects[match.name] = {
        projectId: match._id,
        folder: folderPath,
        email,
        isWorkspace: match.isWorkspace,
        type,
      };
      writeConfig(config);

      // Initialize sync state for this folder
      const syncState = createSyncState(match._id, match.name, type);
      writeSyncState(folderPath, syncState);

      const typeLabel = type === 2 ? 'Notes' : 'Tasks';

      return toolOk(
        `Setup complete for project "${match.name}".\n` +
          `  Project ID: ${match._id}\n` +
          `  Folder: ${folderPath}\n` +
          `  Email: ${email}\n` +
          `  Syncs: ${typeLabel} (type=${type})\n` +
          `  Workspace: ${match.isWorkspace ? 'Yes' : 'No (personal)'}\n\n` +
          `Run planko_sync to pull ${typeLabel.toLowerCase()} into this folder.`
      );
    } catch (err) {
      return toolError(`Setup failed: ${err.message}`);
    }
  }
);

// ---- planko_sync_preview ----
server.tool(
  'planko_sync_preview',
  'Preview what would be synced (read-only, no writes). Shows files that would be pushed, pulled, deleted, and any conflicts. If projectName is omitted, previews all configured projects.',
  {
    projectName: z.string().optional().describe('Project name to preview (optional — omit to preview all)'),
  },
  async ({ projectName }) => {
    try {
      const config = readConfig();
      const projectEntries = config.projects || {};

      if (Object.keys(projectEntries).length === 0) {
        return toolError('No projects configured. Run planko_setup first.');
      }

      // Filter to specific project or all
      let targets;
      if (projectName) {
        const key = Object.keys(projectEntries).find(
          (k) => k.toLowerCase() === projectName.toLowerCase()
        );
        if (!key) {
          const available = Object.keys(projectEntries).map((k) => `  - ${k}`).join('\n');
          return toolError(
            `Project "${projectName}" not configured.\n\nConfigured projects:\n${available}`
          );
        }
        targets = [{ name: key, ...projectEntries[key] }];
      } else {
        targets = Object.entries(projectEntries).map(([name, cfg]) => ({ name, ...cfg }));
      }

      const allLines = ['Sync Preview (read-only, no changes made)', ''];

      for (const target of targets) {
        const sync = readSyncState(target.folder);
        if (!sync) {
          allLines.push(`--- ${target.name} ---`);
          allLines.push('No sync state found. Run planko_sync to initialize.', '');
          continue;
        }

        let diff;
        try {
          diff = await computeSyncDiff(target.projectId, target.folder, sync);
        } catch (err) {
          allLines.push(`--- ${target.name} ---`);
          allLines.push(`Error: ${err.message}`, '');
          continue;
        }

        allLines.push(`--- ${target.name} (${target.folder}) ---`);
        allLines.push('');
        allLines.push(`Would push: ${diff.wouldPush.length} task(s)`);
        diff.wouldPush.forEach((p) => allLines.push(`  - ${p.name}${p._id ? '' : ' (new)'}`));

        allLines.push(`Would pull: ${diff.wouldPull.length} task(s)`);
        diff.wouldPull.forEach((p) => allLines.push(`  - ${p.name}`));

        allLines.push(`Would delete locally: ${diff.wouldDeleteLocal.length} file(s) (removed on server)`);
        diff.wouldDeleteLocal.forEach((d) => allLines.push(`  - ${d.name}`));

        allLines.push(`Would delete remotely: ${diff.wouldDeleteRemote.length} task(s) (removed locally)`);
        diff.wouldDeleteRemote.forEach((d) => allLines.push(`  - ${d.name}`));

        if (diff.conflicts.length > 0) {
          allLines.push('');
          allLines.push(`Conflicts: ${diff.conflicts.length} (modified both locally and remotely)`);
          diff.conflicts.forEach((c) => allLines.push(`  - ${c.name} (local: ${c.localMtime})`));
          allLines.push('Note: sync uses pull-then-push order — local changes overwrite remote on conflict.');
        }

        allLines.push('');
      }

      return toolOk(allLines.join('\n'));
    } catch (err) {
      return toolError(`Sync preview failed: ${err.message}`);
    }
  }
);

// ---- planko_sync ----
server.tool(
  'planko_sync',
  'Execute bidirectional sync with delete support: deletes, then pulls remote changes, then pushes local changes. If projectName is omitted, syncs all configured projects.',
  {
    projectName: z.string().optional().describe('Project name to sync (optional — omit to sync all)'),
  },
  async ({ projectName }) => {
    try {
      const config = readConfig();
      const projectEntries = config.projects || {};

      if (Object.keys(projectEntries).length === 0) {
        return toolError('No projects configured. Run planko_setup first.');
      }

      // Filter to specific project or all
      let targets;
      if (projectName) {
        const key = Object.keys(projectEntries).find(
          (k) => k.toLowerCase() === projectName.toLowerCase()
        );
        if (!key) {
          const available = Object.keys(projectEntries).map((k) => `  - ${k}`).join('\n');
          return toolError(
            `Project "${projectName}" not configured.\n\nConfigured projects:\n${available}`
          );
        }
        targets = [{ name: key, ...projectEntries[key] }];
      } else {
        targets = Object.entries(projectEntries).map(([name, cfg]) => ({ name, ...cfg }));
      }

      const allResults = [];

      for (const target of targets) {
        let sync = readSyncState(target.folder);
        if (!sync) {
          // target.type is undefined for pre-feature config entries → legacy type-agnostic sync.
          sync = createSyncState(target.projectId, target.name, target.type);
        }

        allResults.push(`--- ${target.name} (${target.folder}) ---`);

        try {
          const results = await executeSync(target.projectId, target.folder, sync);
          allResults.push(...results);
        } catch (err) {
          allResults.push(`Error: ${err.message}`);
        }
        allResults.push('');
      }

      return toolOk('Sync complete.\n\n' + allResults.join('\n'));
    } catch (err) {
      return toolError(`Sync failed: ${err.message}`);
    }
  }
);

// --- Standalone CRUD tools (Part B) ---
// These operate directly via the user-scoped API key and do NOT require any
// folder to be configured with planko_setup. Notes are Task docs with type=2;
// tasks are type=1. Edit/Delete work on both; Complete is task-oriented.

const objectId = z
  .string()
  .regex(/^[a-fA-F\d]{24}$/, 'Must be a 24-character hex ObjectId');

const timeRegex = /^([01]?[0-9]|2[0-3]):[0-5][0-9]$/;

// Shared editable task/note properties (all optional). `description` is Markdown
// here and is converted to BlockNote JSON before being sent to the backend.
const taskProps = {
  description: z
    .string()
    .optional()
    .describe('Body as Markdown (converted to BlockNote JSON before saving)'),
  dueDate: z.string().optional().describe('Due date (ISO 8601 string)'),
  datePlain: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD')
    .optional()
    .describe('Plain date, YYYY-MM-DD'),
  time: z.string().regex(timeRegex, 'Must be HH:MM').optional().describe('Start time, HH:MM'),
  endTime: z.string().regex(timeRegex, 'Must be HH:MM').optional().describe('End time, HH:MM'),
  alert: z.boolean().optional().describe('Whether an alert/reminder is enabled'),
  alertLeadTime: z
    .enum(['ontime', '15min', '30min', '1hour', '1day'])
    .nullable()
    .optional()
    .describe('Reminder lead time (null or one of ontime/15min/30min/1hour/1day)'),
  priority: z
    .union([z.literal(1), z.literal(2), z.literal(3)])
    .optional()
    .describe('Priority: 1, 2, or 3'),
  repeat: z
    .enum(['daily', 'workdays', 'weekly', 'biweekly', 'monthly', 'custom_weekly', 'yearly'])
    .nullable()
    .optional()
    .describe('Recurrence rule (null or one of the recurrence keywords)'),
  repeatDate: z.string().optional().describe('Recurrence end/anchor date (ISO 8601 string)'),
  selectedWeekdays: z
    .array(z.number().int().min(0).max(6))
    .optional()
    .describe('Weekdays for custom_weekly repeat (0=Sunday..6=Saturday)'),
  parentId: objectId.optional().describe('Parent task id (for subtasks)'),
  tags: z.array(objectId).optional().describe('Array of tag ids'),
  kanbanColumnId: objectId.optional().describe('Kanban column id'),
  boardId: objectId.optional().describe('Board id'),
};

/**
 * Build a request body from tool params: drop undefined values and convert the
 * Markdown `description` into BlockNote JSON.
 */
function buildTaskBody(params) {
  const body = {};
  for (const [key, value] of Object.entries(params)) {
    if (isBlankValue(value)) continue;
    body[key] = value;
  }
  applyDueDateFallback(body);
  if ('description' in body) {
    body.description = markdownToDescription(body.description);
  }
  return body;
}

/**
 * Resolve a project name to a project id via the user's accessible projects
 * (NOT the local folder config), so create tools work without any setup.
 */
async function resolveProjectId(projectName) {
  const { projects } = await api.projects();
  const match = projects.find(
    (p) => p.name.toLowerCase() === projectName.toLowerCase()
  );
  if (!match) {
    const available = projects.map((p) => `  - ${p.name}`).join('\n');
    throw new Error(
      `Project "${projectName}" not found.\n\nAvailable projects:\n${available}`
    );
  }
  return match._id;
}

/** Extract { id, name } from a create/edit response (shape-tolerant). */
function describeTask(res) {
  const t = (res && (res.task || res.data)) || res || {};
  return {
    id: t._id || t.id || 'unknown',
    name: t.name != null ? t.name : 'unknown',
  };
}

/**
 * When PROJECT_LOCK is set, fetch a by-id task and refuse the operation unless
 * it belongs to the locked project. No-op when the lock is null.
 */
async function assertTaskInLock(taskId) {
  if (!PROJECT_LOCK) return;
  const res = await api.getTask(taskId);
  assertProjectAllowed(PROJECT_LOCK, unwrapItem(res));
}

/**
 * Shared create handler for tasks (type=1) and notes (type=2).
 */
async function handleCreate(type, params, kindLabel) {
  const { name, projectName, ...rest } = params;
  const body = buildTaskBody(rest);
  body.name = name;
  body.type = type;

  if (PROJECT_LOCK) {
    // Hard override: always the locked project; ignore any caller project field
    // and do NOT resolve projectName.
    body.projectId = lockProjectId(PROJECT_LOCK, body.projectId);
  } else if (!isBlankValue(projectName)) {
    // Resolve projectName -> projectId via the API. When omitted, OMIT the key
    // entirely so the backend applies the user's default project.
    body.projectId = await resolveProjectId(projectName);
  }

  const res = await api.createTask(body);
  const { id, name: savedName } = describeTask(res);
  const where = body.projectId
    ? ` in project ${body.projectId}`
    : ' in your default project';
  return toolOk(`Created ${kindLabel} "${savedName}" (id: ${id})${where}.`);
}

/**
 * Shared edit handler for tasks and notes (same endpoint).
 */
async function handleEdit(params, kindLabel) {
  const { taskId, ...rest } = params;
  const body = buildTaskBody(rest);
  const changed = Object.keys(body);
  if (changed.length === 0) {
    return toolError('Nothing to update: provide at least one field to change.');
  }
  if (PROJECT_LOCK) {
    // Refuse to touch a task outside the locked project.
    await assertTaskInLock(taskId);
    // If the caller tried to move the task to another project, force it back to
    // the lock (never let an edit move a task OUT of the locked project). If no
    // project field was passed, leave the project unchanged.
    if ('projectId' in body) {
      body.projectId = lockProjectId(PROJECT_LOCK, body.projectId);
    }
  }
  const res = await api.updateTask(taskId, body);
  const { id, name: savedName } = describeTask(res);
  return toolOk(
    `Updated ${kindLabel} "${savedName}" (id: ${id}). Changed: ${changed.join(', ')}.`
  );
}

// ---- planko_create_task ----
server.tool(
  'planko_create_task',
  'Create a Planko task (type=1) directly via your API key. Works without any folder setup. Provide a name (required); all other properties are optional. Optionally target a project by name (otherwise your default project is used).',
  {
    name: z.string().describe('Task name (required)'),
    projectName: z
      .string()
      .optional()
      .describe('Project name to create the task in (optional — omit for your default project)'),
    ...taskProps,
  },
  async (params) => {
    try {
      return await handleCreate(1, params, 'task');
    } catch (err) {
      return toolError(`Create task failed: ${err.message}`);
    }
  }
);

// ---- planko_create_note ----
server.tool(
  'planko_create_note',
  'Create a Planko note (type=2) directly via your API key. Works without any folder setup. Provide a name (required); all other properties are optional. Optionally target a project by name (otherwise your default project is used).',
  {
    name: z.string().describe('Note name (required)'),
    projectName: z
      .string()
      .optional()
      .describe('Project name to create the note in (optional — omit for your default project)'),
    ...taskProps,
  },
  async (params) => {
    try {
      return await handleCreate(2, params, 'note');
    } catch (err) {
      return toolError(`Create note failed: ${err.message}`);
    }
  }
);

// ---- planko_edit_task ----
server.tool(
  'planko_edit_task',
  'Edit an existing Planko task by id. Provide the taskId and any properties to change. The Markdown description is converted to BlockNote JSON.',
  {
    taskId: objectId.describe('Id of the task to edit (required)'),
    name: z.string().optional().describe('New task name'),
    type: z
      .union([z.literal(1), z.literal(2)])
      .optional()
      .describe('Change type: 1=task, 2=note'),
    projectId: objectId.optional().describe('Move to a different project by id'),
    ...taskProps,
  },
  async (params) => {
    try {
      return await handleEdit(params, 'task');
    } catch (err) {
      return toolError(`Edit task failed: ${err.message}`);
    }
  }
);

// ---- planko_edit_note ----
server.tool(
  'planko_edit_note',
  'Edit an existing Planko note by id (shares the task edit endpoint). Provide the taskId and any properties to change. The Markdown description is converted to BlockNote JSON.',
  {
    taskId: objectId.describe('Id of the note to edit (required)'),
    name: z.string().optional().describe('New note name'),
    type: z
      .union([z.literal(1), z.literal(2)])
      .optional()
      .describe('Change type: 1=task, 2=note'),
    projectId: objectId.optional().describe('Move to a different project by id'),
    ...taskProps,
  },
  async (params) => {
    try {
      return await handleEdit(params, 'note');
    } catch (err) {
      return toolError(`Edit note failed: ${err.message}`);
    }
  }
);

// ---- planko_complete_task ----
server.tool(
  'planko_complete_task',
  'Mark a Planko task complete (status=2) by id.',
  {
    taskId: objectId.describe('Id of the task to complete (required)'),
  },
  async ({ taskId }) => {
    try {
      await assertTaskInLock(taskId);
      const res = await api.completeTask(taskId);
      const { id, name } = describeTask(res);
      return toolOk(`Completed task "${name}" (id: ${id}).`);
    } catch (err) {
      return toolError(`Complete task failed: ${err.message}`);
    }
  }
);

// ---- planko_delete_task ----
server.tool(
  'planko_delete_task',
  'Delete a Planko task by id.',
  {
    taskId: objectId.describe('Id of the task to delete (required)'),
  },
  async ({ taskId }) => {
    try {
      await assertTaskInLock(taskId);
      await api.deleteTask(taskId);
      return toolOk(`Deleted task (id: ${taskId}).`);
    } catch (err) {
      return toolError(`Delete task failed: ${err.message}`);
    }
  }
);

// ---- planko_delete_note ----
server.tool(
  'planko_delete_note',
  'Delete a Planko note by id (shares the task delete endpoint).',
  {
    taskId: objectId.describe('Id of the note to delete (required)'),
  },
  async ({ taskId }) => {
    try {
      await assertTaskInLock(taskId);
      await api.deleteTask(taskId);
      return toolOk(`Deleted note (id: ${taskId}).`);
    } catch (err) {
      return toolError(`Delete note failed: ${err.message}`);
    }
  }
);

// --- Standalone READ tools (Part C) ---
// Read-only, user-scoped via API key; no folder setup required. List tools send
// `type` (1=tasks, 2=notes) and parametrized filters; view tools fetch one item
// by id and render its BlockNote description as Markdown. No mutation.

const datePlain = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD');

const sortBySchema = z
  .string()
  .describe(
    "Sort as 'field:asc' or 'field:desc'. Allowed fields: dueDate, createdAt, updatedAt, priority, position, name. Default updatedAt:desc."
  );

const STATUS_LABEL = { 1: 'open', 2: 'complete' };

/** Human label for a status code. */
function statusLabel(status) {
  return STATUS_LABEL[status] || (status == null ? 'unknown' : String(status));
}

/** Render a task/note's tags as a comma list of names (fallback to ids). */
function formatTags(tags) {
  if (!Array.isArray(tags) || tags.length === 0) return null;
  return tags
    .map((t) => (t && typeof t === 'object' ? t.name || t._id : t))
    .filter(Boolean)
    .join(', ');
}

/** Build the API filter params from tool params, resolving projectName. */
async function buildListParams(type, params) {
  // assigneeName is a client-side member filter (see applyAssigneeName); never
  // forward it to the backend, which doesn't know that key.
  const { projectName, assigneeName, ...rest } = params;
  // Sanitize scalar filters (drops blank/placeholder values, incl. a blank
  // assigneeId => "all members").
  const out = { type, ...sanitizeFilters(rest) };
  if (PROJECT_LOCK) {
    // Drop the id/priority narrowers this class of agent fabricates with
    // non-blank garbage (parentId=projectId, assigneeId from a chat id, guessed
    // priority) that would silently zero the "list the whole team" result.
    stripHallucinatedListFilters(out);
    // Hard override: force the project regardless of caller input. Do NOT
    // resolve projectName here — the override wins unconditionally, so an
    // invalid projectName must not be able to fail an otherwise-locked list.
    out.projectId = lockProjectId(PROJECT_LOCK, out.projectId);
  } else if (!isBlankValue(projectName)) {
    // Unlocked (default) path: unchanged behavior.
    out.projectId = await resolveProjectId(projectName);
  }
  return out;
}

/** One concise summary line per item for list output. */
function summarizeItem(item, index) {
  const parts = [];
  parts.push(`status: ${statusLabel(item.status)}`);
  if (item.priority != null) parts.push(`priority: ${item.priority}`);
  if (item.dueDate) parts.push(`due: ${item.dueDate}${item.time ? ` ${item.time}` : ''}`);
  else if (item.datePlain) parts.push(`due: ${item.datePlain}${item.time ? ` ${item.time}` : ''}`);
  const tagStr = formatTags(item.tags);
  if (tagStr) parts.push(`tags: ${tagStr}`);
  if (item.projectId) parts.push(`project: ${item.projectId}`);
  const owner = ownerName(item.userId);
  if (owner) parts.push(`owner: ${owner}`);
  return (
    `${index}. ${item.name || '(untitled)'} [id: ${item._id ?? item.id}]\n` +
    `   ${parts.join(' | ')}`
  );
}

/** Render a list response as a concise, readable summary (not raw JSON). */
function renderList(result, kindLabelPlural) {
  const tasks = Array.isArray(result?.tasks) ? result.tasks : [];
  const total = result?.total ?? tasks.length;
  const page = result?.page ?? 1;
  const limit = result?.limit ?? tasks.length;

  if (tasks.length === 0) {
    return `No ${kindLabelPlural} found (total: ${total}, page ${page}).`;
  }

  const lines = tasks.map((t, i) => summarizeItem(t, i + 1));
  const footer = `\nShowing ${tasks.length} of ${total} ${kindLabelPlural} (page ${page}, limit ${limit}).`;
  return `${lines.join('\n')}\n${footer}`;
}

/** Render one item's full detail with the description converted to Markdown. */
function renderItem(item, kindLabel) {
  const lines = [];
  lines.push(`${item.name || '(untitled)'}`);
  lines.push(`id: ${item._id ?? item.id}`);
  lines.push(`type: ${item.type === 2 ? 'note' : 'task'} (${kindLabel})`);
  lines.push(`status: ${statusLabel(item.status)}`);
  if (item.priority != null) lines.push(`priority: ${item.priority}`);
  if (item.dueDate) lines.push(`due: ${item.dueDate}${item.time ? ` ${item.time}` : ''}`);
  else if (item.datePlain) lines.push(`due: ${item.datePlain}${item.time ? ` ${item.time}` : ''}`);
  const tagStr = formatTags(item.tags);
  if (tagStr) lines.push(`tags: ${tagStr}`);
  if (item.projectId) lines.push(`project: ${item.projectId}`);
  const owner = ownerName(item.userId);
  if (owner) lines.push(`owner: ${owner}`);
  if (item.parentId) lines.push(`parent: ${item.parentId}`);
  if (item.createdAt) lines.push(`created: ${item.createdAt}`);
  if (item.updatedAt) lines.push(`updated: ${item.updatedAt}`);

  const md = descriptionToMarkdown(item.description);
  lines.push('');
  lines.push('--- description ---');
  lines.push(md && md.trim() ? md : '(empty)');
  return lines.join('\n');
}

/** Extract a single item from a view response (shape-tolerant). */
function unwrapItem(res) {
  return (res && (res.task || res.data)) || res || {};
}

// Shared list filter surface (task tools use all; note tools use the applicable subset).
const listStatus = z
  .union([z.literal(1), z.literal(2)])
  .optional()
  .describe('Filter by status: 1=open, 2=complete');
const listShowCompleted = z
  .boolean()
  .optional()
  .describe('When false/omitted (and no explicit status), completed items are excluded');
const listProjectName = z
  .string()
  .optional()
  .describe('Filter to a project by name (resolved to its id)');
const listProjectId = objectId.optional().describe('Filter to a project by id');
const listAssigneeId = objectId
  .optional()
  .describe('Filter to a single project member by their user id (omit for all members)');
const listTags = z.array(objectId).optional().describe('Filter by tag ids (AND — item must have all)');
const listSearch = z.string().optional().describe('Case-insensitive search on the name');
const listSortBy = sortBySchema.optional();
const listLimit = z
  .number()
  .int()
  .min(1)
  .max(200)
  .optional()
  .describe('Max items to return (default 50, max 200)');
const listPage = z.number().int().min(1).optional().describe('Page number (default 1)');
const listPriority = z
  .union([z.literal(1), z.literal(2), z.literal(3)])
  .optional()
  .describe('Filter by priority: 1, 2, or 3');
const listParentId = objectId.optional().describe('List subtasks of this parent task id');
const listAssigneeName = z
  .string()
  .optional()
  .describe(
    'Narrow to ONE team member by their NAME or email (case-insensitive). ' +
      'Omit to list the WHOLE team (all members). Only set this when the user ' +
      'explicitly names a person; never guess.'
  );

// Build the list-filter schema. Under PROJECT_LOCK the project is forced and the
// caller is a bespoke, project-scoped agent whose model fabricates id/priority
// narrowers (parentId/assigneeId/priority) that silently zero the result — so
// those fields are NOT offered; member narrowing is by NAME (assigneeName)
// instead. Unlocked (default, e.g. clawis) keeps the full, unchanged surface.
function listSchema(kind /* 'task' | 'note' */) {
  const base = { showCompleted: listShowCompleted };
  if (kind === 'task') base.status = listStatus;
  const tail = {
    tags: listTags,
    search: listSearch,
    ...(kind === 'task'
      ? {
          dueDateFrom: datePlain.optional().describe('Inclusive lower bound on due date (YYYY-MM-DD)'),
          dueDateTo: datePlain.optional().describe('Inclusive upper bound on due date (YYYY-MM-DD)'),
        }
      : {}),
    sortBy: listSortBy,
    limit: listLimit,
    page: listPage,
  };
  if (PROJECT_LOCK) {
    return { ...base, assigneeName: listAssigneeName, ...tail };
  }
  return {
    ...base,
    priority: listPriority,
    projectName: listProjectName,
    projectId: listProjectId,
    assigneeId: listAssigneeId,
    ...(kind === 'task' ? { parentId: listParentId } : {}),
    ...tail,
  };
}

/**
 * Client-side member narrowing by NAME (used under PROJECT_LOCK, where the
 * agent narrows by a person's name instead of a fabricated user id). Returns
 * { result, note }. When assigneeName is blank, the result is unchanged. When
 * items lack populated owner info (backend owner-populate not deployed yet),
 * the filter can't be applied — the full list is returned with an explanatory
 * note rather than a misleading empty result.
 */
function applyAssigneeName(result, assigneeName) {
  if (isBlankValue(assigneeName)) return { result, note: null };
  const tasks = Array.isArray(result?.tasks) ? result.tasks : [];
  if (!hasOwnerInfo(tasks)) {
    return {
      result,
      note: `Could not narrow to "${assigneeName}" — owner info is not available yet; showing all members.`,
    };
  }
  const filtered = tasks.filter((t) => matchesAssignee(t.userId, assigneeName));
  return { result: { ...result, tasks: filtered, total: filtered.length }, note: null };
}

// ---- planko_list_tasks ----
server.tool(
  'planko_list_tasks',
  'List Planko tasks (type=1) via your API key, no folder setup required. All filters are optional; omit any the user did not explicitly ask for. Recurring tasks appear as separate dated occurrences. Returns a concise summary, not raw JSON.',
  listSchema('task'),
  async (params) => {
    try {
      const apiParams = await buildListParams(1, params);
      const result = await api.listTasks(apiParams);
      const { result: filtered, note } = applyAssigneeName(result, params.assigneeName);
      const out = renderList(filtered, 'tasks');
      return toolOk(note ? `${out}\n\nNote: ${note}` : out);
    } catch (err) {
      return toolError(`List tasks failed: ${err.message}`);
    }
  }
);

// ---- planko_list_notes ----
server.tool(
  'planko_list_notes',
  'List Planko notes (type=2) via your API key, no folder setup required. All filters are optional; omit any the user did not explicitly ask for. Deleted and recurring-copy notes are excluded. Returns a concise summary, not raw JSON.',
  listSchema('note'),
  async (params) => {
    try {
      const apiParams = await buildListParams(2, params);
      const result = await api.listTasks(apiParams);
      const { result: filtered, note } = applyAssigneeName(result, params.assigneeName);
      const out = renderList(filtered, 'notes');
      return toolOk(note ? `${out}\n\nNote: ${note}` : out);
    } catch (err) {
      return toolError(`List notes failed: ${err.message}`);
    }
  }
);

// ---- planko_view_task ----
server.tool(
  'planko_view_task',
  'View one Planko task by id, with its description rendered as Markdown. The type is informational — this endpoint returns the item regardless of task/note type.',
  {
    taskId: objectId.describe('Id of the task to view (required)'),
  },
  async ({ taskId }) => {
    try {
      const res = await api.getTask(taskId);
      const item = unwrapItem(res);
      assertProjectAllowed(PROJECT_LOCK, item);
      return toolOk(renderItem(item, 'task'));
    } catch (err) {
      return toolError(`View task failed: ${err.message}`);
    }
  }
);

// ---- planko_view_note ----
server.tool(
  'planko_view_note',
  'View one Planko note by id, with its description rendered as Markdown. The type is informational — this endpoint returns the item regardless of task/note type.',
  {
    taskId: objectId.describe('Id of the note to view (required)'),
  },
  async ({ taskId }) => {
    try {
      const res = await api.getTask(taskId);
      const item = unwrapItem(res);
      assertProjectAllowed(PROJECT_LOCK, item);
      return toolOk(renderItem(item, 'note'));
    } catch (err) {
      return toolError(`View note failed: ${err.message}`);
    }
  }
);

// --- Start server ---

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
