import { describe, expect, it, vi } from 'vitest';

import {
  BluetoothCancelledError,
  BluetoothConcurrentOperationError,
  BluetoothTimeoutError,
  BluetoothValidationError,
  createBluetoothTimeline,
  normalizeBluetoothAddress,
  normalizeBluetoothUuid,
  type BluetoothTimeline,
  type CharacteristicOperationType,
  type CharacteristicReference,
  type DescriptorReference,
  type GattOperationType,
  type MonotonicClock,
} from '@gattlab/core';

import {
  PendingOperationRegistry,
  type OperationDeadline,
  type OperationDeadlineScheduler,
  type PendingOperationEventInput,
} from '../src/pending-operation-registry.js';

class FakeTime implements MonotonicClock, OperationDeadlineScheduler {
  #now = 0;
  #nextId = 0;
  readonly #deadlines = new Map<
    number,
    Readonly<{ at: number; onDeadline: () => void }>
  >();

  now(): number {
    return this.#now;
  }

  get pendingDeadlineCount(): number {
    return this.#deadlines.size;
  }

  schedule(deadlineMs: number, onDeadline: () => void): OperationDeadline {
    this.#nextId += 1;
    const id = this.#nextId;
    this.#deadlines.set(id, { at: this.#now + deadlineMs, onDeadline });
    return Object.freeze({
      cancel: () => {
        this.#deadlines.delete(id);
      },
    });
  }

  advanceBy(durationMs: number): void {
    const target = this.#now + durationMs;
    while (true) {
      const next = [...this.#deadlines.entries()]
        .filter(([, deadline]) => deadline.at <= target)
        .sort((left, right) => left[1].at - right[1].at)[0];
      if (next === undefined) break;
      const [id, deadline] = next;
      this.#deadlines.delete(id);
      this.#now = deadline.at;
      deadline.onDeadline();
    }
    this.#now = target;
  }
}

const address = normalizeBluetoothAddress('00:11:22:33:44:55');
const otherAddress = normalizeBluetoothAddress('00:11:22:33:44:66');
const serviceUuid = normalizeBluetoothUuid('180f');
const characteristicUuid = normalizeBluetoothUuid('2a19');
const otherCharacteristicUuid = normalizeBluetoothUuid('2a1a');
const descriptorUuid = normalizeBluetoothUuid('2901');

const characteristic: CharacteristicReference = Object.freeze({
  kind: 'characteristic',
  address,
  serviceUuid,
  characteristicUuid,
});
const otherCharacteristic: CharacteristicReference = Object.freeze({
  kind: 'characteristic',
  address,
  serviceUuid,
  characteristicUuid: otherCharacteristicUuid,
});
const descriptor: DescriptorReference = Object.freeze({
  kind: 'descriptor',
  address,
  serviceUuid,
  characteristicUuid,
  descriptorUuid,
});

function createRegistry(options: Readonly<{ terminalLimit?: number }> = {}): {
  readonly time: FakeTime;
  readonly timeline: BluetoothTimeline;
  readonly registry: PendingOperationRegistry;
} {
  const time = new FakeTime();
  const timeline = createBluetoothTimeline({ limit: 100, clock: time });
  const registry = new PendingOperationRegistry({
    timeline,
    defaultDeadlineMs: 100,
    deadlineScheduler: time,
    operationIdNamespace: 'test-operation',
    ...(options.terminalLimit === undefined
      ? {}
      : { terminalRetentionLimit: options.terminalLimit }),
  });
  return { time, timeline, registry };
}

function gattInput(
  type: GattOperationType,
  peripheralAddress = address,
): PendingOperationEventInput {
  return {
    kind: 'gatt-operation',
    peripheral: Object.freeze({
      kind: 'peripheral',
      address: peripheralAddress,
    }),
    type,
  };
}

function characteristicInput(
  type: CharacteristicOperationType,
  reference = characteristic,
  data: Uint8Array = new Uint8Array([1, 2]),
): PendingOperationEventInput {
  return type === 'write'
    ? {
        kind: 'characteristic-operation',
        characteristic: reference,
        type,
        writeType: 'with-response',
        data,
      }
    : {
        kind: 'characteristic-operation',
        characteristic: reference,
        type,
      };
}

describe('GATT operation interruption observations', () => {
  it('reports the retained terminal error and respects unsubscription', async () => {
    const { registry, time } = createRegistry({ terminalLimit: 1 });
    const { operationId } = registry.register(gattInput('connection'));
    const listener = vi.fn();
    const removed = vi.fn();
    registry.onGattOperationInterrupted(operationId, listener);
    const unsubscribe = registry.onGattOperationInterrupted(
      operationId,
      removed,
    );
    unsubscribe();
    unsubscribe();
    time.advanceBy(100);
    registry.onGattOperationInterrupted(operationId, listener);
    registry.cancel(
      registry.register(gattInput('connection')).operationId,
      'other',
    );
    await Promise.resolve();
    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener.mock.calls[0]?.[0]).toBe(listener.mock.calls[1]?.[0]);
    expect(listener.mock.calls[0]?.[0]).toBeInstanceOf(BluetoothTimeoutError);
    expect(removed).not.toHaveBeenCalled();
  });
});

function descriptorInput(
  type: 'read' | 'write',
  data: Uint8Array = new Uint8Array([3, 4]),
): PendingOperationEventInput {
  return type === 'write'
    ? { kind: 'descriptor-operation', descriptor, type, data }
    : { kind: 'descriptor-operation', descriptor, type };
}

function createDeferred(): Readonly<{
  promise: Promise<void>;
  resolve: () => void;
}> {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve() {
      if (resolvePromise === undefined) throw new Error('Deferred not ready.');
      resolvePromise();
    },
  };
}

async function flushPromiseQueue(): Promise<void> {
  for (let index = 0; index < 6; index += 1) await Promise.resolve();
}

describe('PendingOperationRegistry', () => {
  it('creates immutable synthetic ids and records a successful lifecycle', async () => {
    const { time, timeline, registry } = createRegistry();
    const source = new Uint8Array([1, 2]);

    const event = registry.register(
      characteristicInput('write', characteristic, source),
    );
    source[0] = 9;

    expect(event.operationId).toBe('test-operation:1');
    expect(Object.isFrozen(event)).toBe(true);
    expect(
      Object.isFrozen(
        event.kind === 'characteristic-operation'
          ? event.characteristic
          : undefined,
      ),
    ).toBe(true);
    expect(event).toMatchObject({
      kind: 'characteristic-operation',
      type: 'write',
      data: new Uint8Array([1, 2]),
    });
    expect(registry.size).toBe(1);

    const mutation = vi.fn(async () => Promise.resolve());
    await registry.respondToCharacteristicOperation(
      { operationId: event.operationId, type: 'write', result: 'success' },
      mutation,
    );

    expect(mutation).toHaveBeenCalledOnce();
    expect(mutation).toHaveBeenCalledWith(event);
    expect(registry.size).toBe(0);
    expect(registry.terminalSize).toBe(1);
    expect(time.pendingDeadlineCount).toBe(0);
    expect(
      timeline.snapshot().map(({ type, status }) => ({ type, status })),
    ).toEqual([
      { type: 'operation-received', status: 'requested' },
      { type: 'operation-pending', status: 'pending' },
      { type: 'operation-response', status: 'requested' },
      { type: 'operation-response', status: 'succeeded' },
    ]);
    time.advanceBy(100);
    expect(timeline.snapshot()).toHaveLength(4);
  });

  it('rejects only an ambiguous same-entity same-type operation', () => {
    const { time, timeline, registry } = createRegistry();
    const first = registry.register(characteristicInput('read'));

    expect(() => registry.register(characteristicInput('read'))).toThrowError(
      expect.objectContaining({
        code: 'BLUETOOTH_CONCURRENT_OPERATION',
        context: expect.objectContaining({
          pendingOperationId: first.operationId,
          operationType: 'read',
        }),
      }) as BluetoothConcurrentOperationError,
    );
    expect(() => registry.register(characteristicInput('write'))).not.toThrow();
    expect(() =>
      registry.register(characteristicInput('read', otherCharacteristic)),
    ).not.toThrow();
    expect(() =>
      registry.register(gattInput('connection', otherAddress)),
    ).not.toThrow();
    expect(registry.size).toBe(4);
    expect(
      timeline
        .snapshot()
        .some(({ type }) => type === 'operation-concurrency-rejected'),
    ).toBe(true);
    expect(registry.cancelAll('test cleanup')).toBe(4);
    expect(time.pendingDeadlineCount).toBe(0);
  });

  it('rejects unknown, mismatched, and duplicate responses before mutation', async () => {
    const { registry } = createRegistry();
    const mutation = vi.fn(async () => Promise.resolve());

    await expect(
      registry.respondToGattOperation(
        { operationId: 'never-issued', type: 'connection', result: 'success' },
        mutation,
      ),
    ).rejects.toMatchObject({
      code: 'BLUETOOTH_VALIDATION_FAILED',
      context: { reason: 'unknown-operation-id' },
    } satisfies Partial<BluetoothValidationError>);

    const event = registry.register(gattInput('connection'));
    await expect(
      registry.respondToDescriptorOperation(
        {
          operationId: event.operationId,
          type: 'read',
          result: 'success',
          data: [1],
        },
        mutation,
      ),
    ).rejects.toMatchObject({
      context: { reason: 'operation-kind-mismatch' },
    });
    await expect(
      registry.respondToGattOperation(
        {
          operationId: event.operationId,
          type: 'discovery',
          result: 'success',
        },
        mutation,
      ),
    ).rejects.toMatchObject({
      context: { reason: 'operation-type-mismatch' },
    });
    expect(mutation).not.toHaveBeenCalled();

    const deferred = createDeferred();
    const firstResponse = registry.respondToGattOperation(
      { operationId: event.operationId, type: 'connection', result: 'success' },
      () => deferred.promise,
    );
    await expect(
      registry.respondToGattOperation(
        {
          operationId: event.operationId,
          type: 'connection',
          result: 'success',
        },
        mutation,
      ),
    ).rejects.toMatchObject({ context: { reason: 'response-in-flight' } });
    expect(mutation).not.toHaveBeenCalled();
    deferred.resolve();
    await firstResponse;

    await expect(
      registry.respondToGattOperation(
        {
          operationId: event.operationId,
          type: 'connection',
          result: 'success',
        },
        mutation,
      ),
    ).rejects.toMatchObject({
      context: { reason: 'settled-operation-id', terminalState: 'completed' },
    });
    expect(mutation).not.toHaveBeenCalled();
  });

  it('reports an entity-rich diagnostic timeout and blocks a late response', async () => {
    const { time, timeline, registry } = createRegistry();
    const timeoutContext = {
      knownLimitation: 'unsuccessful-discovery-does-not-settle',
    };
    const event = registry.register(gattInput('discovery'), {
      deadlineMs: 25,
      timeoutContext,
    });
    timeoutContext.knownLimitation = 'mutated';

    time.advanceBy(25);

    expect(registry.size).toBe(0);
    const mutation = vi.fn(async () => Promise.resolve());
    await expect(
      registry.respondToGattOperation(
        {
          operationId: event.operationId,
          type: 'discovery',
          result: 'error',
          error: 'connection-timeout',
        },
        mutation,
      ),
    ).rejects.toMatchObject({
      code: 'BLUETOOTH_TIMEOUT',
      context: {
        address,
        operationId: event.operationId,
        operationKind: 'gatt',
        operationType: 'discovery',
        deadlineMs: 25,
        knownLimitation: 'unsuccessful-discovery-does-not-settle',
      },
    } satisfies Partial<BluetoothTimeoutError>);
    expect(mutation).not.toHaveBeenCalled();
    expect(timeline.snapshot().at(-1)).toMatchObject({
      type: 'operation-late-completion',
      operationId: event.operationId,
      status: 'timed-out',
      data: { completion: 'response-attempt', terminalState: 'timed-out' },
    });
  });

  it('keeps an unsuccessful discovery pending until its diagnostic deadline', async () => {
    const { time, timeline, registry } = createRegistry();
    const event = registry.register(gattInput('discovery'), {
      deadlineMs: 30,
    });
    const mutation = vi.fn(async () => Promise.resolve());
    const response = registry.respondToGattOperation(
      {
        operationId: event.operationId,
        type: 'discovery',
        result: 'error',
        error: 'connection-timeout',
      },
      mutation,
    );
    await flushPromiseQueue();

    expect(mutation).toHaveBeenCalledOnce();
    expect(registry.size).toBe(1);
    expect(timeline.snapshot().at(-1)).toMatchObject({
      type: 'operation-response',
      status: 'succeeded',
      data: {
        awaitingDiagnosticDeadline: true,
        responseDelivered: true,
        responseResult: 'error',
        knownLimitation: 'unsuccessful-discovery-does-not-settle',
      },
    });

    time.advanceBy(30);

    await expect(response).rejects.toMatchObject({
      code: 'BLUETOOTH_TIMEOUT',
      message: expect.stringContaining('response was accepted by Chromium'),
      context: {
        operationType: 'discovery',
        responseDelivered: true,
        responseResult: 'error',
        knownLimitation: 'unsuccessful-discovery-does-not-settle',
      },
    });
    expect(registry.size).toBe(0);
    expect(timeline.snapshot().at(-1)).toMatchObject({
      type: 'operation-timeout',
      status: 'timed-out',
      data: {
        responseDelivered: true,
        responseResult: 'error',
        knownLimitation: 'unsuccessful-discovery-does-not-settle',
      },
    });
  });

  it('settles at the deadline and records later protocol completion without reversal', async () => {
    const { time, timeline, registry } = createRegistry();
    const event = registry.register(characteristicInput('read'), {
      deadlineMs: 10,
    });
    const deferred = createDeferred();
    const response = registry.respondToCharacteristicOperation(
      {
        operationId: event.operationId,
        type: 'read',
        result: 'success',
        data: [1],
      },
      () => deferred.promise,
    );
    await Promise.resolve();

    time.advanceBy(10);

    await expect(response).rejects.toBeInstanceOf(BluetoothTimeoutError);
    deferred.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(registry.size).toBe(0);
    expect(timeline.snapshot().at(-1)).toMatchObject({
      type: 'operation-late-completion',
      operationId: event.operationId,
      status: 'timed-out',
      data: { completion: 'protocol-success', terminalState: 'timed-out' },
    });
  });

  it('cancels matching operations and records in-flight completion as late', async () => {
    const { time, timeline, registry } = createRegistry();
    const characteristicEvent = registry.register(characteristicInput('read'));
    registry.register(descriptorInput('read'));
    registry.register(gattInput('connection', otherAddress));
    const deferred = createDeferred();
    const response = registry.respondToCharacteristicOperation(
      {
        operationId: characteristicEvent.operationId,
        type: 'read',
        result: 'success',
        data: [1],
      },
      () => deferred.promise,
    );
    await Promise.resolve();

    expect(
      registry.cancelForPeripheral(address, 'peripheral disconnected'),
    ).toBe(2);
    expect(time.pendingDeadlineCount).toBe(1);
    await expect(response).rejects.toMatchObject({
      code: 'BLUETOOTH_CANCELLED',
      context: { cancellationReason: 'peripheral disconnected' },
    } satisfies Partial<BluetoothCancelledError>);
    expect(registry.size).toBe(1);
    expect(registry.cancelAll('backend stopping')).toBe(1);
    expect(registry.size).toBe(0);
    expect(time.pendingDeadlineCount).toBe(0);

    let registrySettled = false;
    const settlement = registry.settled().then(() => {
      registrySettled = true;
    });
    await flushPromiseQueue();
    expect(registrySettled).toBe(false);
    deferred.resolve();
    await settlement;
    expect(registrySettled).toBe(true);

    timeline.close();

    expect(timeline.snapshot().at(-1)).toMatchObject({
      type: 'operation-late-completion',
      status: 'cancelled',
      data: { completion: 'protocol-success', terminalState: 'cancelled' },
    });
  });

  it('preserves response failures and releases the operation key', async () => {
    const { time, timeline, registry } = createRegistry();
    const event = registry.register(descriptorInput('write'));
    const cause = new Error('protocol response failed');

    await expect(
      registry.respondToDescriptorOperation(
        { operationId: event.operationId, type: 'write', result: 'success' },
        async () => Promise.reject(cause),
      ),
    ).rejects.toBe(cause);

    expect(registry.size).toBe(0);
    expect(time.pendingDeadlineCount).toBe(0);
    expect(timeline.snapshot().at(-1)).toMatchObject({
      type: 'operation-response',
      status: 'failed',
    });
    expect(() => registry.register(descriptorInput('write'))).not.toThrow();
    registry.cancelAll('test cleanup');
  });

  it('does not record pending when a scheduler invokes its callback synchronously', async () => {
    const time = new FakeTime();
    const timeline = createBluetoothTimeline({ limit: 100, clock: time });
    const registry = new PendingOperationRegistry({
      timeline,
      defaultDeadlineMs: 100,
      deadlineScheduler: {
        schedule(_deadlineMs, onDeadline) {
          onDeadline();
          return Object.freeze({ cancel: vi.fn() });
        },
      },
      operationIdNamespace: 'synchronous-deadline',
    });

    const event = registry.register(gattInput('connection'));

    expect(registry.size).toBe(0);
    expect(registry.terminalSize).toBe(1);
    expect(timeline.snapshot().map(({ type }) => type)).toEqual([
      'operation-received',
      'operation-timeout',
    ]);
    await expect(
      registry.respondToGattOperation(
        {
          operationId: event.operationId,
          type: 'connection',
          result: 'success',
        },
        async () => Promise.resolve(),
      ),
    ).rejects.toBeInstanceOf(BluetoothTimeoutError);
  });

  it('bounds terminal metadata while every evicted id remains non-mutable', async () => {
    const { registry } = createRegistry({ terminalLimit: 2 });
    const mutation = vi.fn(async () => Promise.resolve());
    const operationIds: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const event = registry.register(gattInput('connection'));
      operationIds.push(event.operationId);
      await registry.respondToGattOperation(
        {
          operationId: event.operationId,
          type: 'connection',
          result: 'success',
        },
        mutation,
      );
    }

    expect(registry.terminalSize).toBe(2);
    const lateMutation = vi.fn(async () => Promise.resolve());
    await expect(
      registry.respondToGattOperation(
        {
          operationId: operationIds[0] ?? '',
          type: 'connection',
          result: 'success',
        },
        lateMutation,
      ),
    ).rejects.toMatchObject({ context: { reason: 'unknown-operation-id' } });
    await expect(
      registry.respondToGattOperation(
        {
          operationId: operationIds[2] ?? '',
          type: 'connection',
          result: 'success',
        },
        lateMutation,
      ),
    ).rejects.toMatchObject({ context: { reason: 'settled-operation-id' } });
    expect(lateMutation).not.toHaveBeenCalled();
  });
});
