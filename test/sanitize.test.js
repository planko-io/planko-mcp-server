import { describe, it, expect } from 'vitest';
import { isBlankValue, ZERO_OBJECT_ID } from '../src/sanitize.js';

describe('isBlankValue', () => {
  it('treats undefined/null as blank', () => {
    expect(isBlankValue(undefined)).toBe(true);
    expect(isBlankValue(null)).toBe(true);
  });

  it('treats empty / whitespace strings as blank', () => {
    expect(isBlankValue('')).toBe(true);
    expect(isBlankValue('   ')).toBe(true);
  });

  it('treats the all-zero placeholder ObjectId as blank (the "Project not found" bug)', () => {
    expect(isBlankValue(ZERO_OBJECT_ID)).toBe(true);
    expect(isBlankValue('000000000000000000000000')).toBe(true);
    expect(isBlankValue('  000000000000000000000000  ')).toBe(true);
  });

  it('treats empty arrays as blank', () => {
    expect(isBlankValue([])).toBe(true);
  });

  it('keeps real values', () => {
    expect(isBlankValue('6a454e4def3e32a8370c24f1')).toBe(false); // real ObjectId
    expect(isBlankValue('bossa')).toBe(false); // real projectName
    expect(isBlankValue(1)).toBe(false); // priority/status
    expect(isBlankValue(0)).toBe(false); // numeric zero is a real value
    expect(isBlankValue(false)).toBe(false); // boolean
    expect(isBlankValue(['tag1'])).toBe(false); // non-empty array
    expect(isBlankValue('2026-07-27')).toBe(false); // date
  });
});
