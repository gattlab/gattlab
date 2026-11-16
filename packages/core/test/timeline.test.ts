import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  BluetoothBackendStoppedError,
  createBluetoothTimeline,
  type MonotonicClock,
  type TimelineCategory,
  type TimelineEventInput,
  type TimelineStatus,
} from '../src/index.js';

function createClock(...values: number[]): MonotonicClock {
  let index = 0;
  return {
    now() {
      const value = values[index];
      index += 1;
      if (value === undefined) throw new Error('Clock exhausted.');
      return value;
    },
  };
}

describe('createBluetoothTimeline foundation', () => {
  it('exposes the complete timeline contract from the package entrypoint', () => {
    expectTypeOf<TimelineCategory>().toEqualTypeOf<
      | 'lifecycle'
      | 'adapter'
      | 'peripheral'
      | 'advertisement'
      | 'prompt'
      | 'gatt'
      | 'characteristic'
      | 'descriptor'
      | 'diagnostic'
    >();
    expectTypeOf<TimelineStatus>().toEqualTypeOf<
      | 'requested'
      | 'pending'
      | 'succeeded'
      | 'failed'
      | 'cancelled'
      | 'timed-out'
    >();
    expectTypeOf<TimelineEventInput>().toMatchTypeOf<{
      readonly category: TimelineCategory;
      readonly type: string;
    }>();
  });

  it('assigns sequences and distinguishes monotonic from elapsed time', () => {
    const timeline = createBluetoothTimeline({
      limit: 3,
      clock: createClock(100, 100.5, 104),
    });

    expect(
      timeline.append({ category: 'lifecycle', type: 'started' }),
    ).toMatchObject({ sequence: 1, monotonicMs: 100.5, elapsedMs: 0.5 });
    expect(
      timeline.append({ category: 'adapter', type: 'powered-on' }),
    ).toMatchObject({ sequence: 2, monotonicMs: 104, elapsedMs: 4 });
  });

  it('retains only the newest limit events in frozen snapshots', () => {
    const timeline = createBluetoothTimeline({
      limit: 2,
      clock: createClock(0, 1, 2, 3),
    });
    timeline.append({ category: 'diagnostic', type: 'first' });
    timeline.append({ category: 'diagnostic', type: 'second' });
    timeline.append({ category: 'diagnostic', type: 'third' });

    const snapshot = timeline.snapshot();
    expect(snapshot.map(({ sequence, type }) => ({ sequence, type }))).toEqual([
      { sequence: 2, type: 'second' },
      { sequence: 3, type: 'third' },
    ]);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(snapshot.every(Object.isFrozen)).toBe(true);
  });

  it('recursively copies and freezes diagnostic data', () => {
    const timeline = createBluetoothTimeline({
      limit: 1,
      clock: createClock(0, 1),
    });
    const data = { attempt: 1, nested: { states: ['pending'] } };
    const event = timeline.append({
      category: 'gatt',
      type: 'connection',
      data,
    });

    data.attempt = 2;
    data.nested.states[0] = 'changed';
    expect(event.data).toEqual({
      attempt: 1,
      nested: { states: ['pending'] },
    });
    expect(Object.isFrozen(event.data)).toBe(true);
    expect(Object.isFrozen(event.data?.['nested'])).toBe(true);
  });

  it('records teardown diagnostics before final close and rejects silent loss afterward', () => {
    const timeline = createBluetoothTimeline({
      limit: 2,
      clock: createClock(0, 1),
    });
    timeline.append({
      category: 'diagnostic',
      type: 'cleanup-failed',
      status: 'failed',
      data: { step: 'remove-peripherals' },
    });
    timeline.close();
    timeline.close();

    expect(timeline.closed).toBe(true);
    expect(timeline.snapshot()).toMatchObject([
      { type: 'cleanup-failed', data: { step: 'remove-peripherals' } },
    ]);
    expect(() =>
      timeline.append({ category: 'lifecycle', type: 'late' }),
    ).toThrow(BluetoothBackendStoppedError);
    try {
      timeline.append({ category: 'lifecycle', type: 'late' });
    } catch (error) {
      expect(error).toMatchObject({
        context: { operation: 'append', timelineClosed: true },
      });
    }
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid limit %s',
    (limit) => {
      expect(() =>
        createBluetoothTimeline({ limit, clock: createClock(0) }),
      ).toThrow(RangeError);
    },
  );

  it('rejects non-finite and regressing clock values', () => {
    expect(() =>
      createBluetoothTimeline({ limit: 1, clock: createClock(Infinity) }),
    ).toThrow(TypeError);
    const timeline = createBluetoothTimeline({
      limit: 1,
      clock: createClock(2, 1),
    });
    expect(() =>
      timeline.append({ category: 'diagnostic', type: 'regressed' }),
    ).toThrow(RangeError);
  });
});
