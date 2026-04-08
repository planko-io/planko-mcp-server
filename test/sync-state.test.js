import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  readSyncState,
  writeSyncState,
  createSyncState,
  listLocalFiles,
  deleteLocalFile,
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
    const fileName = 'My Task.md';
    const taskName = toTaskName(fileName);
    expect(taskName).toBe('My Task');
    expect(toFileName(taskName)).toBe('My Task.md');
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
      project: { _id: 'p1', name: 'Test' },
      mcpLastSyncDate: 12345,
      tasks: [],
    };
    writeSyncState(tempDir, state);
    const read = readSyncState(tempDir);
    expect(read.project._id).toBe('p1');
    expect(read.mcpLastSyncDate).toBe(12345);
  });

  it('NEVER stores credentials in sync file', () => {
    const state = {
      project: { _id: 'p1' },
      apiKey: 'SECRET_KEY_123',
      apiSecret: 'another_secret',
      password: 'super_secret',
      userEmail: 'test@example.com',
      tasks: [],
    };
    writeSyncState(tempDir, state);

    const raw = readFileSync(join(tempDir, SYNC_FILE), 'utf-8');
    expect(raw).not.toContain('SECRET_KEY_123');
    expect(raw).not.toContain('another_secret');
    expect(raw).not.toContain('super_secret');
    expect(raw).not.toContain('test@example.com');
    expect(raw).not.toContain('apiKey');
    expect(raw).not.toContain('userEmail');

    const read = readSyncState(tempDir);
    expect(read.apiKey).toBeUndefined();
    expect(read.userEmail).toBeUndefined();
  });

  it('strips credentials on read even if file was tampered', () => {
    const tampered = JSON.stringify({
      project: { _id: 'p1' },
      apiKey: 'TAMPERED_KEY',
      userEmail: 'hack@test.com',
      tasks: [],
    });
    writeFileSync(join(tempDir, SYNC_FILE), tampered);

    const read = readSyncState(tempDir);
    expect(read.apiKey).toBeUndefined();
    expect(read.userEmail).toBeUndefined();
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

describe('deleteLocalFile', () => {
  it('deletes an existing file', () => {
    writeFileSync(join(tempDir, 'task.md'), 'content');
    expect(deleteLocalFile(tempDir, 'task.md')).toBe(true);
    expect(existsSync(join(tempDir, 'task.md'))).toBe(false);
  });

  it('returns false for nonexistent file', () => {
    expect(deleteLocalFile(tempDir, 'nonexistent.md')).toBe(false);
  });
});

describe('createSyncState', () => {
  it('creates state with project info', () => {
    const state = createSyncState('proj1', 'My Project');
    expect(state.project._id).toBe('proj1');
    expect(state.project.name).toBe('My Project');
    expect(state.tasks).toEqual([]);
    expect(state.mcpLastSyncDate).toBeNull();
  });

  it('does not include credentials', () => {
    const state = createSyncState('proj1', 'Test');
    expect(state.apiKey).toBeUndefined();
    expect(state.userEmail).toBeUndefined();
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
