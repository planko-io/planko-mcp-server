#!/usr/bin/env node

/**
 * planko-mcp-server — MCP server for syncing Planko tasks with local .md files.
 *
 * Environment variables:
 *   PLANKO_SYNC_FOLDER (required) — absolute path to the sync folder
 *   PLANKO_API_KEY     — project API key (or use planko_setup tool)
 *   PLANKO_EMAIL       — user email (or use planko_setup tool)
 *   PLANKO_API_BASE    — optional API base URL override
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { createApiClient } from './src/api.js';
import {
  blockNoteToMarkdown,
  markdownToBlockNote,
  descriptionToMarkdown,
} from './src/converters.js';
import {
  readSyncState,
  writeSyncState,
  createSyncState,
  listLocalFiles,
  getFileMtimeMs,
  toFileName,
  toTaskName,
  buildIndexes,
  SYNC_FILE,
} from './src/sync-state.js';

// --- Startup validation ---

const SYNC_FOLDER = process.env.PLANKO_SYNC_FOLDER;
if (!SYNC_FOLDER) {
  console.error(
    'Fatal: PLANKO_SYNC_FOLDER environment variable is required. Set it to the absolute path of your sync folder.'
  );
  process.exit(1);
}

// --- Session state (in-memory, never persisted) ---

let sessionApiKey = process.env.PLANKO_API_KEY || null;
let sessionEmail = process.env.PLANKO_EMAIL || null;

function getApiClient() {
  if (!sessionApiKey) {
    throw new Error(
      'API key not configured. Set PLANKO_API_KEY env var or call planko_setup first.'
    );
  }
  return createApiClient({ apiKey: sessionApiKey });
}

function getEmail() {
  if (!sessionEmail) {
    throw new Error(
      'Email not configured. Set PLANKO_EMAIL env var or call planko_setup first.'
    );
  }
  return sessionEmail;
}

// --- Tool helpers ---

function toolOk(text) {
  return { content: [{ type: 'text', text }] };
}

function toolError(text) {
  return { content: [{ type: 'text', text }], isError: true };
}

// --- MCP Server ---

const server = new McpServer({
  name: 'planko-mcp-server',
  version: '0.1.0',
});

// ---- planko_setup ----
server.tool(
  'planko_setup',
  'Initialize sync for a project folder. Fetches project status from Planko and creates the local sync state file. Use this if PLANKO_API_KEY / PLANKO_EMAIL are not set via env vars.',
  {
    apiKey: z.string().describe('Planko project API key'),
    email: z.string().email().describe('User email for task attribution'),
  },
  async ({ apiKey, email }) => {
    try {
      // Store credentials in session only (never persisted)
      sessionApiKey = apiKey;
      sessionEmail = email;

      const api = getApiClient();
      const statusData = await api.status();

      const syncState = createSyncState(statusData, SYNC_FOLDER);
      syncState.userEmail = email;

      writeSyncState(SYNC_FOLDER, syncState);

      return toolOk(
        `Setup complete for project "${syncState.project.name || 'unknown'}".\n` +
          `Sync folder: ${SYNC_FOLDER}\n` +
          `Tasks tracked: ${syncState.tasks.length}\n` +
          `Sync state file created at: ${join(SYNC_FOLDER, SYNC_FILE)}`
      );
    } catch (err) {
      return toolError(`Setup failed: ${err.message}`);
    }
  }
);

// ---- planko_pull ----
server.tool(
  'planko_pull',
  'Pull remote task changes from Planko to local .md files. Downloads tasks modified since the last sync and writes/updates local markdown files.',
  {},
  async () => {
    try {
      const api = getApiClient();
      let sync = readSyncState(SYNC_FOLDER);
      if (!sync) {
        // Auto-initialize
        const statusData = await api.status();
        sync = createSyncState(statusData, SYNC_FOLDER);
        sync.userEmail = getEmail();
      }

      const pullData = await api.pull(sync.mcpLastSyncDate);
      const pulledTasks = pullData.tasks || [];

      const { byId } = buildIndexes(sync.tasks);
      const changedNames = [];

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
        changedNames.push(pt.name);

        if (fileName) {
          writeFileSync(join(SYNC_FOLDER, fileName), fileContent);
        }
      }

      sync.mcpLastSyncPullChanges = changedNames;
      sync.mcpLastSyncDate = Date.now();
      writeSyncState(SYNC_FOLDER, sync);

      if (pulledTasks.length === 0) {
        return toolOk('Pull complete. No remote changes.');
      }
      return toolOk(
        `Pull complete. ${pulledTasks.length} task(s) updated:\n` +
          changedNames.map((n) => `  - ${n}`).join('\n')
      );
    } catch (err) {
      return toolError(`Pull failed: ${err.message}`);
    }
  }
);

// ---- planko_push ----
server.tool(
  'planko_push',
  'Push local .md file changes to Planko. Scans the sync folder for modified files and uploads them as task updates.',
  {},
  async () => {
    try {
      const api = getApiClient();
      const email = getEmail();
      let sync = readSyncState(SYNC_FOLDER);
      if (!sync) {
        const statusData = await api.status();
        sync = createSyncState(statusData, SYNC_FOLDER);
        sync.userEmail = email;
      }

      const { byFileName } = buildIndexes(sync.tasks);

      // Scan local files and update mtimes
      const localFiles = listLocalFiles(SYNC_FOLDER);
      for (const fname of localFiles) {
        const filePath = join(SYNC_FOLDER, fname);
        const mtimeMs = Math.floor(getFileMtimeMs(filePath));

        if (fname in byFileName) {
          sync.tasks[byFileName[fname]].mcpLastLocalUpdate = mtimeMs;
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

      // Rebuild indexes after adding new tasks
      const indexes = buildIndexes(sync.tasks);

      // Find tasks changed since last sync
      const tasksToPush = sync.tasks.filter((t) => {
        if (t.mcpLastLocalUpdate == null) return false;
        if (t._id == null) return true; // new task
        if (sync.mcpLastSyncDate == null) return true; // never synced
        return t.mcpLastLocalUpdate > sync.mcpLastSyncDate;
      });

      if (tasksToPush.length === 0) {
        writeSyncState(SYNC_FOLDER, sync);
        return toolOk('Push complete. No local changes to push.');
      }

      // Read file contents and convert to BlockNote
      const pushItems = [];
      for (const t of tasksToPush) {
        if (!t.fileName) continue;
        const filePath = join(SYNC_FOLDER, t.fileName);
        const content = existsSync(filePath)
          ? readFileSync(filePath, 'utf-8')
          : null;
        const description = content
          ? JSON.stringify(markdownToBlockNote(content))
          : null;

        // Send bare name (without .md) to the API
        pushItems.push({
          _id: t._id,
          name: toTaskName(t.fileName),
          description,
        });
      }

      const pushResponse = await api.push(email, pushItems);
      const responseTasks = pushResponse.tasks || [];

      // Update sync state with server responses
      const { byId: idIdx, byFileName: fnIdx } = buildIndexes(sync.tasks);
      const changedNames = [];

      for (const rt of responseTasks) {
        if (rt.name) changedNames.push(rt.name);
        const rtFileName = toFileName(rt.name);

        if (rt._id in idIdx) {
          const idx = idIdx[rt._id];
          sync.tasks[idx].mcpSyncDate = rt.mcpSyncDate;
          sync.tasks[idx].name = rt.name;
          if (rtFileName) sync.tasks[idx].fileName = rtFileName;
        } else if (rtFileName && rtFileName in fnIdx) {
          const idx = fnIdx[rtFileName];
          sync.tasks[idx]._id = rt._id;
          sync.tasks[idx].mcpSyncDate = rt.mcpSyncDate;
          sync.tasks[idx].name = rt.name;
          sync.tasks[idx].fileName = rtFileName;
        }
      }

      sync.mcpLastSyncPushChanges = changedNames;
      sync.mcpLastSyncDate = Date.now();
      writeSyncState(SYNC_FOLDER, sync);

      const errors = pushResponse.errors || [];
      let msg = `Push complete. ${responseTasks.length} task(s) updated/created.`;
      if (changedNames.length > 0) {
        msg += '\n' + changedNames.map((n) => `  - ${n}`).join('\n');
      }
      if (errors.length > 0) {
        msg +=
          `\n\n${errors.length} error(s):\n` +
          errors.map((e) => `  - Task ${e._id || e.index}: ${e.reason}`).join('\n');
      }
      return toolOk(msg);
    } catch (err) {
      return toolError(`Push failed: ${err.message}`);
    }
  }
);

// ---- planko_status ----
server.tool(
  'planko_status',
  'Check sync status: locally modified tasks, remotely modified tasks, conflicts, and last sync time. Returns a human-readable summary.',
  {},
  async () => {
    try {
      const api = getApiClient();
      let sync = readSyncState(SYNC_FOLDER);
      if (!sync) {
        return toolError(
          'No sync state found. Run planko_setup or planko_pull first.'
        );
      }

      // Scan local files for changes
      const localFiles = listLocalFiles(SYNC_FOLDER);
      const localModified = [];
      const { byFileName } = buildIndexes(sync.tasks);

      for (const fname of localFiles) {
        const filePath = join(SYNC_FOLDER, fname);
        const mtimeMs = Math.floor(getFileMtimeMs(filePath));

        if (fname in byFileName) {
          const task = sync.tasks[byFileName[fname]];
          // Use mcpLastLocalUpdate if available; otherwise compare mtime to sync date
          const lastKnownMtime = task.mcpLastLocalUpdate;
          if (lastKnownMtime != null) {
            // File was modified since last recorded mtime
            if (mtimeMs > lastKnownMtime) {
              localModified.push(toTaskName(fname));
            }
          } else if (sync.mcpLastSyncDate == null || mtimeMs > sync.mcpLastSyncDate) {
            localModified.push(toTaskName(fname));
          }
        } else {
          localModified.push(toTaskName(fname) + ' (new)');
        }
      }

      // Check remote changes
      let remoteModified = [];
      let conflicts = [];
      try {
        const statusData = await api.status();
        const remoteTasks = statusData.tasks || [];

        for (const rt of remoteTasks) {
          if (
            rt.mcpSyncDate &&
            sync.mcpLastSyncDate &&
            new Date(rt.mcpSyncDate).getTime() > sync.mcpLastSyncDate
          ) {
            remoteModified.push(rt.name);

            // Check for conflicts
            if (localModified.includes(rt.name)) {
              conflicts.push(rt.name);
            }
          }
        }
      } catch {
        // If API is unreachable, still show local status
      }

      // Format last sync time
      let lastSyncStr = 'never';
      if (sync.mcpLastSyncDate) {
        const ago = Date.now() - sync.mcpLastSyncDate;
        if (ago < 60000) lastSyncStr = 'just now';
        else if (ago < 3600000)
          lastSyncStr = `${Math.floor(ago / 60000)} minute(s) ago`;
        else if (ago < 86400000)
          lastSyncStr = `${Math.floor(ago / 3600000)} hour(s) ago`;
        else lastSyncStr = `${Math.floor(ago / 86400000)} day(s) ago`;
      }

      const lines = [
        `${localModified.length} task(s) modified locally, ${remoteModified.length} task(s) modified remotely, ${conflicts.length} conflict(s).`,
        `Last sync: ${lastSyncStr}.`,
      ];

      if (localModified.length > 0) {
        lines.push('', 'Locally modified:');
        localModified.forEach((n) => lines.push(`  - ${n}`));
      }
      if (remoteModified.length > 0) {
        lines.push('', 'Remotely modified:');
        remoteModified.forEach((n) => lines.push(`  - ${n}`));
      }
      if (conflicts.length > 0) {
        lines.push('', 'Conflicts (modified both locally and remotely):');
        conflicts.forEach((n) => lines.push(`  - ${n}`));
      }

      return toolOk(lines.join('\n'));
    } catch (err) {
      return toolError(`Status check failed: ${err.message}`);
    }
  }
);

// ---- planko_sync_preview ----
server.tool(
  'planko_sync_preview',
  'Preview what would be synced (read-only, no writes). Shows files that would be pushed, tasks that would be pulled, and any conflicts. Call this before planko_sync to review changes.',
  {},
  async () => {
    try {
      const api = getApiClient();
      let sync = readSyncState(SYNC_FOLDER);
      if (!sync) {
        return toolError(
          'No sync state found. Run planko_setup or planko_pull first.'
        );
      }

      // --- Local changes (would be pushed) ---
      const localFiles = listLocalFiles(SYNC_FOLDER);
      const wouldPush = [];
      const { byFileName } = buildIndexes(sync.tasks);

      const localMtimes = {};
      for (const fname of localFiles) {
        const filePath = join(SYNC_FOLDER, fname);
        const mtimeMs = Math.floor(getFileMtimeMs(filePath));
        localMtimes[fname] = mtimeMs;

        if (fname in byFileName) {
          const task = sync.tasks[byFileName[fname]];
          const lastKnownMtime = task.mcpLastLocalUpdate;
          let isModified = false;
          if (task._id == null) {
            isModified = true; // new task, always push
          } else if (lastKnownMtime != null) {
            isModified = mtimeMs > lastKnownMtime;
          } else if (sync.mcpLastSyncDate == null || mtimeMs > sync.mcpLastSyncDate) {
            isModified = true;
          }
          if (isModified) {
            wouldPush.push(toTaskName(fname));
          }
        } else {
          wouldPush.push(toTaskName(fname) + ' (new)');
        }
      }

      // --- Remote changes (would be pulled) ---
      const statusData = await api.status();
      const remoteTasks = statusData.tasks || [];
      const wouldPull = [];
      const conflicts = [];

      for (const rt of remoteTasks) {
        const remoteModTime = rt.mcpSyncDate
          ? new Date(rt.mcpSyncDate).getTime()
          : null;
        if (
          remoteModTime &&
          sync.mcpLastSyncDate &&
          remoteModTime > sync.mcpLastSyncDate
        ) {
          wouldPull.push(rt.name);

          // Check conflict
          const fname = toFileName(rt.name);
          const bareNm = rt.name;
          const pushName = wouldPush.find(
            (n) => n === bareNm || n === bareNm + ' (new)'
          );
          if (pushName) {
            conflicts.push({
              name: bareNm,
              localMtime: localMtimes[fname]
                ? new Date(localMtimes[fname]).toISOString()
                : 'unknown',
              remoteSyncDate: rt.mcpSyncDate,
            });
          }
        }
      }

      // --- Format output ---
      const lines = ['Sync Preview (read-only, no changes made)', ''];

      lines.push(`Would push: ${wouldPush.length} task(s)`);
      if (wouldPush.length > 0) {
        wouldPush.forEach((n) => lines.push(`  - ${n}`));
      }

      lines.push('');
      lines.push(`Would pull: ${wouldPull.length} task(s)`);
      if (wouldPull.length > 0) {
        wouldPull.forEach((n) => lines.push(`  - ${n}`));
      }

      if (conflicts.length > 0) {
        lines.push('');
        lines.push(
          `Conflicts: ${conflicts.length} task(s) modified both locally and remotely`
        );
        for (const c of conflicts) {
          lines.push(
            `  - ${c.name} (local: ${c.localMtime}, remote: ${c.remoteSyncDate})`
          );
        }
        lines.push('');
        lines.push(
          'Note: planko_sync uses pull-then-push order. To keep remote version for a conflicting task, delete the local file before running planko_sync.'
        );
      }

      return toolOk(lines.join('\n'));
    } catch (err) {
      return toolError(`Sync preview failed: ${err.message}`);
    }
  }
);

// ---- planko_sync ----
server.tool(
  'planko_sync',
  'Execute bidirectional sync: pull remote changes first, then push local changes. Run planko_sync_preview first to review what will change.',
  {},
  async () => {
    try {
      const api = getApiClient();
      const email = getEmail();
      let sync = readSyncState(SYNC_FOLDER);
      if (!sync) {
        const statusData = await api.status();
        sync = createSyncState(statusData, SYNC_FOLDER);
        sync.userEmail = email;
      }

      const results = [];
      // Capture pre-pull sync date so push filter works correctly
      const prePullSyncDate = sync.mcpLastSyncDate;

      // --- PULL phase ---
      const pullData = await api.pull(sync.mcpLastSyncDate);
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
          writeFileSync(join(SYNC_FOLDER, fileName), fileContent);
        }
      }

      sync.mcpLastSyncPullChanges = pulledNames;
      results.push(`Pulled: ${pulledTasks.length} task(s)`);
      if (pulledNames.length > 0) {
        pulledNames.forEach((n) => results.push(`  - ${n}`));
      }

      // --- PUSH phase ---
      // Re-index after pull
      const { byFileName: fnIdx2 } = buildIndexes(sync.tasks);

      const localFiles = listLocalFiles(SYNC_FOLDER);
      for (const fname of localFiles) {
        const filePath = join(SYNC_FOLDER, fname);
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
        results.push('', 'Pushed: 0 task(s) (no local changes)');
      } else {
        const pushItems = [];
        for (const t of tasksToPush) {
          if (!t.fileName) continue;
          const filePath = join(SYNC_FOLDER, t.fileName);
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

        const pushResponse = await api.push(email, pushItems);
        const responseTasks = pushResponse.tasks || [];

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
        results.push('', `Pushed: ${responseTasks.length} task(s)`);
        if (pushedNames.length > 0) {
          pushedNames.forEach((n) => results.push(`  - ${n}`));
        }

        const errors = pushResponse.errors || [];
        if (errors.length > 0) {
          results.push(
            '',
            `${errors.length} push error(s):`,
            ...errors.map((e) => `  - Task ${e._id || e.index}: ${e.reason}`)
          );
        }
      }

      sync.mcpLastSyncDate = Date.now();
      writeSyncState(SYNC_FOLDER, sync);

      return toolOk('Sync complete.\n\n' + results.join('\n'));
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
