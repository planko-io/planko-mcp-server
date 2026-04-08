/**
 * Sync state management for planko-mcp-server.
 *
 * Two types of state:
 * 1. Global config (~/.planko-mcp/config.json) — maps project names to folders
 * 2. Per-folder sync state (planko-mcp-sync.json) — task mappings and timestamps
 *
 * Credentials are NEVER written to any state file.
 * Task names are stored WITHOUT the .md extension.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

export const SYNC_FILE = 'planko-mcp-sync.json';
export const CONFIG_DIR = join(homedir(), '.planko-mcp');
export const CONFIG_FILE = join(CONFIG_DIR, 'config.json');
const IGNORED_FILES = ['.DS_Store', 'Thumbs.db', '.gitkeep'];

export function isIgnoredFile(filename) {
  return IGNORED_FILES.includes(filename) || filename.startsWith('.');
}

// --- File name / task name conversion ---

export function toFileName(name) {
  if (!name) return null;
  return name.endsWith('.md') ? name : `${name}.md`;
}

export function toTaskName(fileName) {
  if (!fileName) return null;
  return fileName.endsWith('.md') ? fileName.slice(0, -3) : fileName;
}

// --- Global config (multi-folder) ---

export function readConfig() {
  if (!existsSync(CONFIG_FILE)) return { projects: {} };
  try {
    const raw = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'));
    // Strip any accidentally-stored credentials
    delete raw.apiKey;
    return raw;
  } catch {
    return { projects: {} };
  }
}

export function writeConfig(config) {
  const safe = { ...config };
  delete safe.apiKey;
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
  writeFileSync(CONFIG_FILE, JSON.stringify(safe, null, 2));
}

// --- Per-folder sync state ---

export function readSyncState(folder) {
  const syncPath = join(folder, SYNC_FILE);
  if (!existsSync(syncPath)) return null;
  const raw = JSON.parse(readFileSync(syncPath, 'utf-8'));
  delete raw.apiKey;
  delete raw.userEmail;
  return raw;
}

export function writeSyncState(folder, data) {
  const safe = { ...data };
  delete safe.apiKey;
  delete safe.apiSecret;
  delete safe.password;
  delete safe.userEmail;
  writeFileSync(join(folder, SYNC_FILE), JSON.stringify(safe, null, 2));
}

export function createSyncState(projectId, projectName) {
  return {
    project: {
      _id: projectId,
      name: projectName,
    },
    mcpLastSyncDate: null,
    mcpLastSyncPullChanges: [],
    mcpLastSyncPushChanges: [],
    tasks: [],
  };
}

// --- Local file operations ---

export function listLocalFiles(folder) {
  if (!existsSync(folder)) return [];
  return readdirSync(folder).filter((f) => {
    if (f === SYNC_FILE) return false;
    if (isIgnoredFile(f)) return false;
    const fullPath = join(folder, f);
    return statSync(fullPath).isFile() && f.endsWith('.md');
  });
}

export function getFileMtimeMs(filePath) {
  return statSync(filePath).mtimeMs;
}

export function deleteLocalFile(folder, fileName) {
  const filePath = join(folder, fileName);
  if (existsSync(filePath)) {
    unlinkSync(filePath);
    return true;
  }
  return false;
}

// --- Index helpers ---

export function buildIndexes(tasks) {
  const byId = {};
  const byFileName = {};
  tasks.forEach((t, i) => {
    if (t._id) byId[t._id] = i;
    if (t.fileName) byFileName[t.fileName] = i;
  });
  return { byId, byFileName };
}
