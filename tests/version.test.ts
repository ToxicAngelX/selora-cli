import { describe, expect, it } from 'vitest';
import { VERSION } from '../src/version.js';

describe('VERSION', () => {
  it('equals 1.1.0', () => {
    expect(VERSION).toBe('1.1.0');
  });
});
