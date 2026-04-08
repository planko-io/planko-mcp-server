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
import {
  blockNoteToMarkdown,
  markdownToBlockNote,
  descriptionToMarkdown,
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

  // Get ALL tasks from server (no mcpLastSyncDate filter) to detect deletions
  const statusData = await api.status(projectId);
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
  const results = [];

  // Get ALL tasks to detect deletions
  const allStatusData = await api.status(projectId);
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
    const deleteResponse = await api.push(projectId, toDeleteRemote);
    const deletedRemote = (deleteResponse.tasks || []).filter((t) => t.deleted);
    // Remove deleted tasks from sync state
    const deletedIds = new Set(deletedRemote.map((t) => t._id.toString()));
    sync.tasks = sync.tasks.filter((t) => !t._id || !deletedIds.has(t._id.toString()));
    results.push(`Deleted remotely: ${deletedRemote.length} task(s) (removed locally)`);
  }

  // --- PULL phase ---
  const pullData = await api.pull(projectId, prePullSyncDate);
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

    const pushResponse = await api.push(projectId, pushItems);
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
  version: '0.2.0',
});

// ---- planko_setup ----
server.tool(
  'planko_setup',
  'Set up sync between a Planko project and a local folder. Supports multiple project-folder mappings. The user must provide the project name, local folder path, and email.',
  {
    projectName: z.string().describe('Name of the Planko project to sync'),
    folderPath: z.string().describe('Absolute path to the local folder for .md task files'),
    email: z.string().email().describe('User email for task attribution'),
  },
  async ({ projectName, folderPath, email }) => {
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

      // Save to global config
      const config = readConfig();
      config.projects = config.projects || {};
      config.projects[match.name] = {
        projectId: match._id,
        folder: folderPath,
        email,
        isWorkspace: match.isWorkspace,
      };
      writeConfig(config);

      // Initialize sync state for this folder
      const syncState = createSyncState(match._id, match.name);
      writeSyncState(folderPath, syncState);

      return toolOk(
        `Setup complete for project "${match.name}".\n` +
          `  Project ID: ${match._id}\n` +
          `  Folder: ${folderPath}\n` +
          `  Email: ${email}\n` +
          `  Workspace: ${match.isWorkspace ? 'Yes' : 'No (personal)'}\n\n` +
          `Run planko_sync to pull tasks into this folder.`
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

        const diff = await computeSyncDiff(target.projectId, target.folder, sync);

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
          sync = createSyncState(target.projectId, target.name);
        }

        allResults.push(`--- ${target.name} (${target.folder}) ---`);

        const results = await executeSync(target.projectId, target.folder, sync);
        allResults.push(...results);
        allResults.push('');
      }

      return toolOk('Sync complete.\n\n' + allResults.join('\n'));
    } catch (err) {
      return toolError(`Sync failed: ${err.message}`);
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
