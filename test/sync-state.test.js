import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  readSyncState,
  writeSyncState,
  createSyncState,
  listLocalFiles,
  toFileName,
  toTaskName,
  buildIndexes,
  isIgnoredFile,
  SYNC_FILE,
} from '../src/sync-state.js';

let tempDir;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'planko-test-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('toFileName', () => {
  it('appends .md to bare names', () => {
    expect(toFileName('My Task')).toBe('My Task.md');
  });

  it('does not double-append .md', () => {
    expect(toFileName('My Task.md')).toBe('My Task.md');
  });

  it('returns null for null input', () => {
    expect(toFileName(null)).toBeNull();
  });
});

describe('toTaskName', () => {
  it('strips .md extension', () => {
    expect(toTaskName('My Task.md')).toBe('My Task');
  });

  it('returns name unchanged if no .md', () => {
    expect(toTaskName('My Task')).toBe('My Task');
  });

  it('returns null for null input', () => {
    expect(toTaskName(null)).toBeNull();
  });

  it('prevents .md.md corruption', () => {
    // This is the key fix: toTaskName strips .md, toFileName adds it
    const fileName = 'My Task.md';
    const taskName = toTaskName(fileName);
    expect(taskName).toBe('My Task');
    // When we push to API, we send taskName (no .md)
    // When we create local file, we use toFileName(taskName)
    expect(toFileName(taskName)).toBe('My Task.md');
    // No double extension
    expect(toFileName(taskName)).not.toBe('My Task.md.md');
  });
});

describe('isIgnoredFile', () => {
  it('ignores .DS_Store', () => {
    expect(isIgnoredFile('.DS_Store')).toBe(true);
  });

  it('ignores dotfiles', () => {
    expect(isIgnoredFile('.gitignore')).toBe(true);
  });

  it('does not ignore regular files', () => {
    expect(isIgnoredFile('task.md')).toBe(false);
  });
});

describe('readSyncState / writeSyncState', () => {
  it('returns null when no sync file exists', () => {
    expect(readSyncState(tempDir)).toBeNull();
  });

  it('reads written sync state', () => {
    const state = {
      project: { _id: 'p1', name: 'Test', mcpSyncDate: null },
      userEmail: 'test@example.com',
      mcpLastSyncDate: 12345,
      tasks: [],
    };
    writeSyncState(tempDir, state);
    const read = readSyncState(tempDir);
    expect(read.project._id).toBe('p1');
    expect(read.mcpLastSyncDate).toBe(12345);
  });

  it('NEVER stores API key in sync file', () => {
    const state = {
      project: { _id: 'p1' },
      apiKey: 'SECRET_KEY_123',
      apiSecret: 'another_secret',
      password: 'super_secret',
      userEmail: 'test@example.com',
      tasks: [],
    };
    writeSyncState(tempDir, state);

    // Read raw file to verify no credentials
    const raw = readFileSync(join(tempDir, SYNC_FILE), 'utf-8');
    expect(raw).not.toContain('SECRET_KEY_123');
    expect(raw).not.toContain('another_secret');
    expect(raw).not.toContain('super_secret');
    expect(raw).not.toContain('apiKey');
    expect(raw).not.toContain('apiSecret');
    expect(raw).not.toContain('password');

    // Also verify the parsed result strips credentials
    const read = readSyncState(tempDir);
    expect(read.apiKey).toBeUndefined();
  });

  it('strips apiKey on read even if file was tampered with', () => {
    // Simulate a tampered file that has apiKey
    const tampered = JSON.stringify({
      project: { _id: 'p1' },
      apiKey: 'TAMPERED_KEY',
      userEmail: 'test@example.com',
      tasks: [],
    });
    writeFileSync(join(tempDir, SYNC_FILE), tampered);

    const read = readSyncState(tempDir);
    expect(read.apiKey).toBeUndefined();
  });
});

describe('listLocalFiles', () => {
  it('returns empty array for empty folder', () => {
    expect(listLocalFiles(tempDir)).toEqual([]);
  });

  it('lists .md files only', () => {
    writeFileSync(join(tempDir, 'task1.md'), 'content');
    writeFileSync(join(tempDir, 'task2.md'), 'content');
    writeFileSync(join(tempDir, 'notes.txt'), 'content');

    const files = listLocalFiles(tempDir);
    expect(files).toContain('task1.md');
    expect(files).toContain('task2.md');
    expect(files).not.toContain('notes.txt');
  });

  it('excludes sync state file', () => {
    writeFileSync(join(tempDir, SYNC_FILE), '{}');
    writeFileSync(join(tempDir, 'task.md'), 'content');

    const files = listLocalFiles(tempDir);
    expect(files).not.toContain(SYNC_FILE);
    expect(files).toContain('task.md');
  });

  it('excludes dotfiles and ignored files', () => {
    writeFileSync(join(tempDir, '.DS_Store'), '');
    writeFileSync(join(tempDir, '.gitkeep'), '');
    writeFileSync(join(tempDir, 'task.md'), 'content');

    const files = listLocalFiles(tempDir);
    expect(files).toEqual(['task.md']);
  });

  it('returns empty for nonexistent folder', () => {
    expect(listLocalFiles('/tmp/nonexistent-xyz')).toEqual([]);
  });
});

describe('createSyncState', () => {
  it('creates state from API status response', () => {
    const statusData = {
      project: { _id: 'proj1', name: 'My Project', mcpSyncDate: 100 },
      tasks: [
        { _id: 't1', name: 'Task One', mcpSyncDate: 200 },
        { _id: 't2', name: 'Task Two', mcpSyncDate: 300 },
      ],
    };

    const state = createSyncState(statusData, tempDir);
    expect(state.project._id).toBe('proj1');
    expect(state.tasks).toHaveLength(2);
    expect(state.tasks[0].name).toBe('Task One');
    expect(state.tasks[0].fileName).toBe('Task One.md');
    expect(state.tasks[0]._id).toBe('t1');
  });

  it('includes local-only files as new tasks', () => {
    writeFileSync(join(tempDir, 'Local Task.md'), 'content');

    const statusData = {
      project: { _id: 'proj1' },
      tasks: [{ _id: 't1', name: 'Remote Task', mcpSyncDate: 100 }],
    };

    const state = createSyncState(statusData, tempDir);
    expect(state.tasks).toHaveLength(2);

    const localTask = state.tasks.find((t) => t.name === 'Local Task');
    expect(localTask).toBeDefined();
    expect(localTask._id).toBeNull();
    expect(localTask.fileName).toBe('Local Task.md');
  });

  it('does not include credentials in created state', () => {
    const state = createSyncState({ project: {}, tasks: [] }, tempDir);
    expect(state.apiKey).toBeUndefined();
    expect(state.apiSecret).toBeUndefined();
  });
});

describe('buildIndexes', () => {
  it('builds id and fileName indexes', () => {
    const tasks = [
      { _id: 'a', fileName: 'Task A.md' },
      { _id: 'b', fileName: 'Task B.md' },
      { _id: null, fileName: 'New Task.md' },
    ];

    const { byId, byFileName } = buildIndexes(tasks);
    expect(byId.a).toBe(0);
    expect(byId.b).toBe(1);
    expect(byFileName['Task A.md']).toBe(0);
    expect(byFileName['New Task.md']).toBe(2);
  });
});
