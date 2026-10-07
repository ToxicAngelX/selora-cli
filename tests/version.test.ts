import { describe, expect, it } from 'vitest';
import { VERSION } from '../src/version.js';

describe('VERSION', () => {
  it('equals 1.2.1', () => {
    expect(VERSION).toBe('1.3.1');
  });
});
