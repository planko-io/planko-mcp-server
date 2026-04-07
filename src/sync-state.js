/**
 * Sync state management for planko-mcp-server.
 *
 * The sync state file (planko-mcp-sync.json) stores:
 * - project metadata (id, name, mcpSyncDate)
 * - task state mappings (id <-> filename, sync timestamps)
 * - last sync date
 *
 * It NEVER stores API keys or credentials.
 *
 * Task names are stored WITHOUT the .md extension. toFileName() adds .md
 * for local file operations. The API receives the bare name.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const SYNC_FILE = 'planko-mcp-sync.json';
const IGNORED_FILES = ['.DS_Store', 'Thumbs.db', '.gitkeep'];

export function isIgnoredFile(filename) {
  return IGNORED_FILES.includes(filename) || filename.startsWith('.');
}

/**
 * Convert a task name to a local filename by appending .md if needed.
 */
export function toFileName(name) {
  if (!name) return null;
  return name.endsWith('.md') ? name : `${name}.md`;
}

/**
 * Extract the bare task name from a filename by stripping the .md extension.
 */
export function toTaskName(fileName) {
  if (!fileName) return null;
  return fileName.endsWith('.md') ? fileName.slice(0, -3) : fileName;
}

/**
 * Read the sync state file from a folder. Returns null if not found.
 */
export function readSyncState(folder) {
  const syncPath = join(folder, SYNC_FILE);
  if (!existsSync(syncPath)) return null;
  const raw = JSON.parse(readFileSync(syncPath, 'utf-8'));
  // Strip any accidentally-stored credentials (defensive)
  delete raw.apiKey;
  delete raw.userEmail;
  return raw;
}

/**
 * Write the sync state file. Ensures no API key is ever persisted.
 */
export function writeSyncState(folder, data) {
  // Defensive: never write credentials
  const safe = { ...data };
  delete safe.apiKey;
  delete safe.apiSecret;
  delete safe.password;
  delete safe.userEmail;
  writeFileSync(join(folder, SYNC_FILE), JSON.stringify(safe, null, 2));
}

/**
 * Create a fresh sync state from API status response.
 */
export function createSyncState(statusData, folder) {
  const tasks = (statusData.tasks || []).map((t) => ({
    _id: t._id,
    mcpSyncDate: t.mcpSyncDate || null,
    fileName: toFileName(t.name),
    name: t.name,
    mcpLastLocalUpdate: null,
  }));

  const existingFileNames = new Set(
    tasks.filter((t) => t.fileName).map((t) => t.fileName)
  );

  const localFiles = listLocalFiles(folder);
  for (const fname of localFiles) {
    if (!existingFileNames.has(fname)) {
      tasks.push({
        _id: null,
        mcpSyncDate: null,
        fileName: fname,
        name: toTaskName(fname),
        mcpLastLocalUpdate: null,
      });
    }
  }

  return {
    project: {
      _id: statusData.project?._id || null,
      name: statusData.project?.name || null,
      mcpSyncDate: statusData.project?.mcpSyncDate || null,
    },
    mcpLastSyncDate: null,
    mcpLastSyncPullChanges: [],
    mcpLastSyncPushChanges: [],
    tasks,
  };
}

/**
 * List local .md files in a folder, excluding sync file and ignored files.
 */
export function listLocalFiles(folder) {
  if (!existsSync(folder)) return [];
  return readdirSync(folder).filter((f) => {
    if (f === SYNC_FILE) return false;
    if (isIgnoredFile(f)) return false;
    const fullPath = join(folder, f);
    return statSync(fullPath).isFile() && f.endsWith('.md');
  });
}

/**
 * Get file modification time in milliseconds.
 */
export function getFileMtimeMs(filePath) {
  return statSync(filePath).mtimeMs;
}

/**
 * Build task indexes for quick lookup.
 */
export function buildIndexes(tasks) {
  const byId = {};
  const byFileName = {};
  tasks.forEach((t, i) => {
    if (t._id) byId[t._id] = i;
    if (t.fileName) byFileName[t.fileName] = i;
  });
  return { byId, byFileName };
}
