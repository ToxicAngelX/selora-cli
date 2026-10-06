import { describe, expect, it } from 'vitest';
import { VERSION } from '../src/version.js';

describe('VERSION', () => {
  it('equals 0.6.0', () => {
    expect(VERSION).toBe('0.6.0');
  });
});
