import { describe, expect, it } from 'vitest';
import { VERSION } from '../src/version.js';

describe('VERSION', () => {
  it('equals 2.1.0', () => {
    expect(VERSION).toBe('2.1.0');
  });
});
