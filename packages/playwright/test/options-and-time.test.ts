import { BluetoothValidationError } from '@gattlab/core';
import { describe, expect, it, vi } from 'vitest';

import { normalizeGattLabFixtureOptions } from '../src/options.js';
import {
  createPlaywrightDeadlineScheduler,
  createPlaywrightMonotonicClock,
} from '../src/time.js';

describe('GattLab fixture options', () => {
  it('returns the documented immutable defaults', () => {
    const normalized = normalizeGattLabFixtureOptions(undefined);

    expect(normalized).toEqual({
      centralState: 'powered-on',
      operationTimeoutMs: 5_000,
      promptTimeoutMs: 5_000,
      teardownTimeoutMs: 5_000,
      historyLimit: 1_000,
      operationHistoryLimit: 1_000,
      artifacts: 'retain-on-failure',
      payloadLogging: { mode: 'redacted' },
    });
    expect(Object.isFrozen(normalized)).toBe(true);
  });

  it.each(['absent', 'powered-off', 'powered-on'] as const)(
    'accepts the %s central state',
    (centralState) => {
      expect(
        normalizeGattLabFixtureOptions({ centralState }).centralState,
      ).toBe(centralState);
    },
  );

  it('copies caller-owned options into a frozen snapshot', () => {
    const input = { operationTimeoutMs: 25 };
    const normalized = normalizeGattLabFixtureOptions(input);

    input.operationTimeoutMs = 90;

    expect(normalized.operationTimeoutMs).toBe(25);
    expect(Object.isFrozen(normalized)).toBe(true);
  });

  it('normalizes artifact retention and bounded payload previews', () => {
    const normalized = normalizeGattLabFixtureOptions({
      artifacts: 'always',
      payloadLogging: { mode: 'truncated', maxBytes: 7 },
    });

    expect(normalized.artifacts).toBe('always');
    expect(normalized.payloadLogging).toEqual({
      mode: 'truncated',
      maxBytes: 7,
    });
    expect(Object.isFrozen(normalized.payloadLogging)).toBe(true);
  });

  it.each([
    null,
    [],
    'options',
    1,
    { centralState: 'sleeping' },
    { unknownOption: true },
    { artifacts: 'sometimes' },
    { payloadLogging: null },
    { payloadLogging: { mode: 'full' } },
    { payloadLogging: { mode: 'redacted', maxBytes: 1 } },
    { payloadLogging: { mode: 'truncated', maxBytes: 0 } },
    { payloadLogging: { mode: 'truncated', maxBytes: 4_097 } },
    { payloadLogging: { mode: 'truncated', extra: true } },
  ])('rejects malformed option containers and fields: %j', (input) => {
    expect(() =>
      normalizeGattLabFixtureOptions(
        input as Parameters<typeof normalizeGattLabFixtureOptions>[0],
      ),
    ).toThrow(BluetoothValidationError);
  });

  it.each([
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
  ])('rejects invalid numeric boundaries: %s', (value) => {
    for (const option of [
      'operationTimeoutMs',
      'promptTimeoutMs',
      'teardownTimeoutMs',
      'historyLimit',
      'operationHistoryLimit',
    ] as const) {
      expect(() => normalizeGattLabFixtureOptions({ [option]: value })).toThrow(
        BluetoothValidationError,
      );
    }
  });
});

describe('Playwright time adapters', () => {
  it('provides a finite nondecreasing monotonic clock', () => {
    const clock = createPlaywrightMonotonicClock();
    const first = clock.now();
    const second = clock.now();

    expect(Number.isFinite(first)).toBe(true);
    expect(second).toBeGreaterThanOrEqual(first);
  });

  it('schedules asynchronously and cancellation is idempotent', async () => {
    const scheduler = createPlaywrightDeadlineScheduler();
    const fired = vi.fn();
    const deadline = scheduler.schedule(1, fired);

    expect(fired).not.toHaveBeenCalled();
    deadline.cancel();
    deadline.cancel();
    await new Promise<void>((resolve) => {
      scheduler.schedule(5, resolve);
    });
    expect(fired).not.toHaveBeenCalled();

    await new Promise<void>((resolve) => {
      scheduler.schedule(1, () => {
        fired();
        resolve();
      });
    });
    expect(fired).toHaveBeenCalledOnce();
  });
});
