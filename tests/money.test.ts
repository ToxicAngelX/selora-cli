import { describe, expect, it } from 'vitest';
import { formatUsd, parseMoneyMicro } from '../src/money.js';

describe('money formatting (scale-6 decimal strings, integer math only)', () => {
  it('formats plain values', () => {
    expect(formatUsd('42.180000')).toBe('$42.18');
    expect(formatUsd('0')).toBe('$0.00');
    expect(formatUsd('0.000000')).toBe('$0.00');
    expect(formatUsd('5')).toBe('$5.00');
  });

  it('rounds toward zero only for display', () => {
    expect(formatUsd('1.999999')).toBe('$1.99');
    expect(formatUsd('0.009999')).toBe('$0.00');
    expect(formatUsd('2.999999')).toBe('$2.99');
  });

  it('handles shorter fractions (pads to scale 6)', () => {
    expect(formatUsd('42.5')).toBe('$42.50');
    expect(formatUsd('42.18')).toBe('$42.18');
  });

  it('handles large values without float drift', () => {
    expect(formatUsd('123456789.123456')).toBe('$123456789.12');
  });

  it('handles negative balances with sign', () => {
    expect(formatUsd('-1.500000')).toBe('-$1.50');
  });

  it('falls back to the raw string when unparseable — never throws', () => {
    expect(formatUsd('nan')).toBe('$nan');
    expect(formatUsd('')).toBe('$');
  });

  it('parses to exact micro-units', () => {
    expect(parseMoneyMicro('42.180000')).toBe(42180000n);
    expect(parseMoneyMicro('0')).toBe(0n);
    expect(parseMoneyMicro('1.999999')).toBe(1999999n);
    expect(parseMoneyMicro('-0.000001')).toBe(-1n);
    expect(parseMoneyMicro('bogus')).toBeNull();
  });
});
