import type { BluetoothEntityReference } from './backend.js';
import { BluetoothBackendStoppedError } from './errors.js';
import { snapshotDiagnosticContext, type DiagnosticValue } from './errors.js';

export const timelineCategories: readonly [
  'lifecycle',
  'adapter',
  'peripheral',
  'advertisement',
  'prompt',
  'gatt',
  'characteristic',
  'descriptor',
  'diagnostic',
] = Object.freeze([
  'lifecycle',
  'adapter',
  'peripheral',
  'advertisement',
  'prompt',
  'gatt',
  'characteristic',
  'descriptor',
  'diagnostic',
] as const);

export type TimelineCategory = (typeof timelineCategories)[number];

export const timelineStatuses: readonly [
  'requested',
  'pending',
  'succeeded',
  'failed',
  'cancelled',
  'timed-out',
] = Object.freeze([
  'requested',
  'pending',
  'succeeded',
  'failed',
  'cancelled',
  'timed-out',
] as const);

export type TimelineStatus = (typeof timelineStatuses)[number];

export interface BluetoothTimelineEvent {
  readonly sequence: number;
  readonly monotonicMs: number;
  readonly elapsedMs: number;
  readonly category: TimelineCategory;
  readonly type: string;
  readonly entity?: BluetoothEntityReference;
  readonly operationId?: string;
  readonly status?: TimelineStatus;
  readonly data?: Readonly<Record<string, DiagnosticValue>>;
}

export interface TimelineEventInput {
  readonly category: TimelineCategory;
  readonly type: string;
  readonly entity?: BluetoothEntityReference;
  readonly operationId?: string;
  readonly status?: TimelineStatus;
  readonly data?: Readonly<Record<string, DiagnosticValue>>;
}

export interface MonotonicClock {
  /** Return finite, nondecreasing milliseconds; timeline consumers reject invalid or regressing values. */
  now(): number;
}

export interface BluetoothTimeline {
  readonly limit: number;
  readonly closed: boolean;
  /** Append copied metadata with a sequence and elapsed time; closed timelines throw BluetoothBackendStoppedError, invalid clocks TypeError/RangeError. */
  append(event: TimelineEventInput): BluetoothTimelineEvent;
  /** Return an immutable newest-event snapshot, including after close; no deadline or transport action. */
  snapshot(): readonly BluetoothTimelineEvent[];
  /**
   * Finalizes the timeline after teardown diagnostics and artifact snapshots.
   *
   * Lifecycle owners must call this as their final timeline action, after
   * recording cleanup failures and late completions. The method is idempotent;
   * appends after it throw instead of silently losing diagnostics.
   */
  close(): void;
}

function snapshotEntityReference(
  entity: BluetoothEntityReference,
): BluetoothEntityReference {
  return Object.freeze({ ...entity });
}

function readClock(clock: MonotonicClock): number {
  const value = clock.now();
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError('Monotonic clock must return a finite number.');
  }
  return value;
}

/** Creates a bounded, monotonic, immutable diagnostic event timeline. */
export function createBluetoothTimeline(options: {
  limit: number;
  clock: MonotonicClock;
}): BluetoothTimeline {
  if (!Number.isSafeInteger(options.limit) || options.limit <= 0) {
    throw new RangeError('Timeline limit must be a positive safe integer.');
  }
  const clock: unknown = options.clock;
  if (
    typeof clock !== 'object' ||
    clock === null ||
    !('now' in clock) ||
    typeof clock.now !== 'function'
  ) {
    throw new TypeError('Timeline clock must provide now().');
  }

  const startedAt = readClock(clock as MonotonicClock);
  let lastMonotonicMs = startedAt;
  let sequence = 0;
  let closed = false;
  const events: BluetoothTimelineEvent[] = [];

  return Object.freeze({
    limit: options.limit,
    get closed() {
      return closed;
    },
    append(input: TimelineEventInput) {
      if (closed) {
        throw new BluetoothBackendStoppedError(
          'Cannot append: the Bluetooth timeline is closed.',
          { context: { operation: 'append', timelineClosed: true } },
        );
      }

      const monotonicMs = readClock(clock as MonotonicClock);
      if (monotonicMs < lastMonotonicMs) {
        throw new RangeError('Monotonic clock must not move backwards.');
      }
      lastMonotonicMs = monotonicMs;
      sequence += 1;
      const event = Object.freeze({
        sequence,
        monotonicMs,
        elapsedMs: monotonicMs - startedAt,
        category: input.category,
        type: input.type,
        ...(input.entity === undefined
          ? {}
          : { entity: snapshotEntityReference(input.entity) }),
        ...(input.operationId === undefined
          ? {}
          : { operationId: input.operationId }),
        ...(input.status === undefined ? {} : { status: input.status }),
        ...(input.data === undefined
          ? {}
          : { data: snapshotDiagnosticContext(input.data) }),
      });
      events.push(event);
      if (events.length > options.limit) events.shift();
      return event;
    },
    snapshot() {
      return Object.freeze([...events]);
    },
    close() {
      closed = true;
    },
  });
}
