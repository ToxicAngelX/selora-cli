/**
 * Unit tests for the pure Phase 2 formatters: compact tokens, comma counts,
 * reset durations, days-left, and usage summation over multiple daily rows
 * (BigInt, STRING wire numerics).
 */

import { describe, expect, it } from 'vitest';
import {
  formatCount,
  formatDurationCompact,
  formatTokensCompact,
  daysLeft,
} from '../src/format.js';
import { sumUsageRows } from '../src/commands/usage.js';
import type { UsageDay } from '../src/api/endpoints/me.js';
import { formatUsdMicro, microToWireString } from '../src/money.js';

describe('formatTokensCompact', () => {
  it.each([
    [0n, '0'],
    [42n, '42'],
    [512n, '512'],
    [999n, '999'],
    [1000n, '1K'],
    [94_300n, '94.3K'],
    [940_000n, '940K'],
    [2_800_000n, '2.8M'],
    [18_100_000n, '18.1M'],
    [1_100_000n, '1.1M'],
    [7_200_000n, '7.2M'],
    [1_000_000_000n, '1B'],
    [3_500_000_000_000n, '3.5T'],
  ])('%s → %s', (n, expected) => {
    expect(formatTokensCompact(n)).toBe(expected);
  });

  it('truncates toward zero (999_999 → 999.9K, never 1M)', () => {
    expect(formatTokensCompact(999_999n)).toBe('999.9K');
  });

  it('negative mirrors the positive form', () => {
    expect(formatTokensCompact(-2_800_000n)).toBe('-2.8M');
  });
});

describe('formatCount', () => {
  it('comma-groups: 183 → 183, 1204 → 1,204, 1304000 → 1,304,000', () => {
    expect(formatCount(183n)).toBe('183');
    expect(formatCount(1204n)).toBe('1,204');
    expect(formatCount(1_304_000n)).toBe('1,304,000');
  });
});

describe('formatDurationCompact', () => {
  it('4_320_000 ms → 1h 12m', () => {
    expect(formatDurationCompact(4_320_000)).toBe('1h 12m');
  });
  it('sub-minute → seconds', () => {
    expect(formatDurationCompact(45_000)).toBe('45s');
  });
  it('minutes only', () => {
    expect(formatDurationCompact(5 * 60_000)).toBe('5m');
  });
  it('days + hours, at most two units', () => {
    expect(formatDurationCompact(2 * 86_400_000 + 5 * 3_600_000)).toBe('2d 5h');
    expect(formatDurationCompact(3 * 86_400_000 + 5 * 3_600_000 + 12 * 60_000)).toBe('3d 5h');
  });
  it('non-positive or invalid → empty (caller decides)', () => {
    expect(formatDurationCompact(0)).toBe('');
    expect(formatDurationCompact(-5)).toBe('');
    expect(formatDurationCompact(Number.NaN)).toBe('');
  });
  it('positive but under one second → honest "under 1s"', () => {
    expect(formatDurationCompact(500)).toBe('under 1s');
  });
});

describe('daysLeft', () => {
  const NOW = Date.parse('2026-10-05T10:00:00Z');
  it('ceil to whole days: 11d2h remaining → 12', () => {
    expect(daysLeft('2026-10-16T12:00:00Z', NOW)).toBe(12);
  });
  it('exact multiple → no over-count', () => {
    expect(daysLeft('2026-10-10T10:00:00Z', NOW)).toBe(5);
  });
  it('already past → 0', () => {
    expect(daysLeft('2026-10-01T00:00:00Z', NOW)).toBe(0);
  });
  it('absent or unparseable → null (never invented)', () => {
    expect(daysLeft('', NOW)).toBeNull();
    expect(daysLeft('not-a-date', NOW)).toBeNull();
  });
});

describe('sumUsageRows (BigInt summation of STRING wire numerics)', () => {
  it('sums multiple daily rows exactly', () => {
    const rows: UsageDay[] = [
      {
        date: '2026-10-05',
        total_requests: '204',
        total_input_tokens: '3100000',
        total_output_tokens: '1200000',
        total_spend: '1.600000',
      },
      {
        date: '2026-10-04',
        total_requests: '1000',
        total_input_tokens: '15000000',
        total_output_tokens: '6000000',
        total_spend: '7.500000',
      },
    ];
    const t = sumUsageRows(rows);
    expect(t.requests).toBe(1204n);
    expect(t.inputTokens).toBe(18_100_000n);
    expect(t.outputTokens).toBe(7_200_000n);
    expect(t.spendMicro).toBe(9_100_000n);
    expect(formatTokensCompact(t.inputTokens)).toBe('18.1M');
    expect(formatTokensCompact(t.outputTokens)).toBe('7.2M');
    expect(formatUsdMicro(t.spendMicro)).toBe('$9.10');
    expect(microToWireString(t.spendMicro)).toBe('9.100000');
  });
  it('empty rows sum to zero — an honest zero, not a fabricated one', () => {
    const t = sumUsageRows([]);
    expect(t.requests).toBe(0n);
    expect(t.spendMicro).toBe(0n);
  });
  it('malformed numerics contribute nothing rather than NaN', () => {
    const rows: UsageDay[] = [
      {
        date: '2026-10-05',
        total_requests: 'x',
        total_input_tokens: '',
        total_output_tokens: '1.5',
        total_spend: 'garbage',
      },
    ];
    const t = sumUsageRows(rows);
    expect(t.requests).toBe(0n);
    expect(t.inputTokens).toBe(0n);
    expect(t.outputTokens).toBe(0n);
    expect(t.spendMicro).toBe(0n);
  });
});
