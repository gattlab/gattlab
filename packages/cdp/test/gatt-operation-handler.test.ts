import { describe, expect, it } from 'vitest';

import {
  BluetoothTimeoutError,
  createBluetoothTimeline,
  normalizeBluetoothAddress,
  validatePeripheralDefinition,
  type BluetoothAddress,
  type BluetoothTimeline,
  type GattOperationEvent,
  type HciErrorName,
  type MonotonicClock,
} from '@gattlab/core';

import { CdpEntityRegistry } from '../src/entity-registry.js';
import { CdpGattOperationHandler } from '../src/gatt-operation-handler.js';
import {
  PendingOperationRegistry,
  type OperationDeadline,
  type OperationDeadlineScheduler,
} from '../src/pending-operation-registry.js';
import { createCdpTransport, type CdpSessionLike } from '../src/transport.js';

interface SentCommand {
  readonly method: string;
  readonly parameters?: object;
}

class FakeCdpSession implements CdpSessionLike {
  readonly calls: SentCommand[] = [];
  readonly listeners = new Map<string, Set<(payload: unknown) => void>>();

  async send(method: string, parameters?: object): Promise<unknown> {
    this.calls.push({
      method,
      ...(parameters === undefined ? {} : { parameters }),
    });
    return {};
  }

  on(event: string, listener: (payload: unknown) => void): void {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
  }

  off(event: string, listener: (payload: unknown) => void): void {
    this.listeners.get(event)?.delete(listener);
  }

  detach(): Promise<void> {
    return Promise.resolve();
  }

  emit(event: string, payload: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(payload);
  }
}

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

interface HandlerHarness {
  readonly address: BluetoothAddress;
  readonly errors: unknown[];
  readonly events: GattOperationEvent[];
  readonly handler: CdpGattOperationHandler;
  readonly pendingOperations: PendingOperationRegistry;
  readonly session: FakeCdpSession;
  readonly time: FakeTime;
  readonly timeline: BluetoothTimeline;
  readonly unsubscribe: () => void;
}

async function createHarness(
  listener?: (event: GattOperationEvent) => void,
): Promise<HandlerHarness> {
  const definition = validatePeripheralDefinition({
    address,
    name: 'GATT handler sensor',
    services: [],
  });
  if (!definition.success) throw new Error('Expected a valid fixture.');

  const session = new FakeCdpSession();
  const transport = createCdpTransport('browser', session);
  const entities = new CdpEntityRegistry(transport);
  await entities.addPeripheralHierarchy(definition.value);
  const time = new FakeTime();
  const timeline = createBluetoothTimeline({ limit: 100, clock: time });
  const pendingOperations = new PendingOperationRegistry({
    timeline,
    defaultDeadlineMs: 25,
    deadlineScheduler: time,
    operationIdNamespace: 'gatt-handler',
  });
  const handler = new CdpGattOperationHandler({
    transport,
    entities,
    pendingOperations,
    timeline,
  });
  const events: GattOperationEvent[] = [];
  const errors: unknown[] = [];
  const unsubscribe = handler.subscribe(
    listener ?? ((event) => events.push(event)),
    (cause) => errors.push(cause),
  );
  return {
    address,
    errors,
    events,
    handler,
    pendingOperations,
    session,
    time,
    timeline,
    unsubscribe,
  };
}

async function flushPromiseQueue(): Promise<void> {
  for (let index = 0; index < 6; index += 1) await Promise.resolve();
}

describe('CdpGattOperationHandler', () => {
  it('normalizes, registers, and responds to a GATT event before unsubscribing idempotently', async () => {
    const harness = await createHarness();

    expect(() =>
      harness.handler.subscribe(
        () => undefined,
        () => undefined,
      ),
    ).toThrow('already subscribed');

    harness.session.emit('BluetoothEmulation.gattOperationReceived', {
      address: '00:11:22:33:44:55'.toLowerCase(),
      type: 'connection',
    });

    const event = harness.events[0];
    expect(event).toEqual({
      kind: 'gatt-operation',
      peripheral: { kind: 'peripheral', address },
      type: 'connection',
      operationId: 'gatt-handler:1',
    });
    expect(Object.isFrozen(event)).toBe(true);
    expect(Object.isFrozen(event?.peripheral)).toBe(true);
    expect(harness.errors).toEqual([]);
    expect(harness.pendingOperations.size).toBe(1);

    if (event === undefined) throw new Error('Expected a GATT event.');
    await harness.handler.respond({
      operationId: event.operationId,
      type: 'connection',
      result: 'success',
    });

    expect(harness.session.calls).toEqual([
      {
        method: 'BluetoothEmulation.simulateGATTOperationResponse',
        parameters: { address, type: 'connection', code: 0x00 },
      },
    ]);
    expect(harness.pendingOperations.size).toBe(0);
    harness.unsubscribe();
    harness.unsubscribe();
    harness.session.emit('BluetoothEmulation.gattOperationReceived', {
      address,
      type: 'discovery',
    });
    expect(harness.events).toHaveLength(1);
  });

  it.each([
    ['authentication-failure', 0x05],
    ['connection-timeout', 0x08],
    ['remote-user-terminated-connection', 0x13],
    ['connection-terminated-by-local-host', 0x16],
    ['connection-failed-to-be-established', 0x3e],
  ] as const)(
    'maps the %s HCI error to code %#i',
    async (error: HciErrorName, code: number) => {
      const harness = await createHarness();
      harness.session.emit('BluetoothEmulation.gattOperationReceived', {
        address,
        type: 'connection',
      });
      const event = harness.events[0];
      if (event === undefined) throw new Error('Expected a GATT event.');

      await harness.handler.respond({
        operationId: event.operationId,
        type: 'connection',
        result: 'error',
        error,
      });

      expect(harness.session.calls).toEqual([
        {
          method: 'BluetoothEmulation.simulateGATTOperationResponse',
          parameters: { address, type: 'connection', code },
        },
      ]);
    },
  );

  it('routes invalid, unknown, and concurrent inbound events to the error sink', async () => {
    const harness = await createHarness();

    harness.session.emit('BluetoothEmulation.gattOperationReceived', {
      address: 'invalid',
      type: 'connection',
    });
    harness.session.emit('BluetoothEmulation.gattOperationReceived', {
      address: '00:11:22:33:44:66',
      type: 'connection',
    });
    harness.session.emit('BluetoothEmulation.gattOperationReceived', {
      address,
      type: 'invalid',
    });
    harness.session.emit('BluetoothEmulation.gattOperationReceived', {
      address,
      type: 'connection',
    });
    harness.session.emit('BluetoothEmulation.gattOperationReceived', {
      address,
      type: 'connection',
    });

    expect(harness.events).toHaveLength(1);
    expect(harness.errors).toHaveLength(4);
    expect(harness.errors).toEqual([
      expect.objectContaining({
        code: 'BLUETOOTH_VALIDATION_FAILED',
        context: expect.objectContaining({
          reason: 'invalid-peripheral-address',
        }),
      }),
      expect.objectContaining({
        code: 'BLUETOOTH_VALIDATION_FAILED',
        context: expect.objectContaining({
          reason: 'unknown-peripheral-address',
        }),
      }),
      expect.objectContaining({
        code: 'BLUETOOTH_VALIDATION_FAILED',
        context: expect.objectContaining({
          reason: 'invalid-gatt-operation-type',
        }),
      }),
      expect.objectContaining({ code: 'BLUETOOTH_CONCURRENT_OPERATION' }),
    ]);
    expect(
      harness.timeline
        .snapshot()
        .filter(({ type }) => type === 'gatt-event-rejected')
        .map(({ status, data }) => ({ status, data })),
    ).toEqual([
      {
        status: 'failed',
        data: { reason: 'invalid-peripheral-address', source: 'event' },
      },
      {
        status: 'failed',
        data: { reason: 'unknown-peripheral-address', source: 'event' },
      },
      {
        status: 'failed',
        data: { reason: 'invalid-gatt-operation-type', source: 'event' },
      },
    ]);
    expect(harness.pendingOperations.size).toBe(1);
    expect(harness.pendingOperations.cancelAll('test cleanup')).toBe(1);
  });

  it('cancels a registered operation when its listener throws', async () => {
    let deliveryAttempts = 0;
    const deliveredEvents: GattOperationEvent[] = [];
    const harness = await createHarness((event) => {
      deliveryAttempts += 1;
      if (deliveryAttempts === 1) throw new Error('listener failed');
      deliveredEvents.push(event);
    });

    harness.session.emit('BluetoothEmulation.gattOperationReceived', {
      address,
      type: 'connection',
    });

    expect(harness.errors).toEqual([new Error('listener failed')]);
    expect(harness.pendingOperations.size).toBe(0);
    expect(harness.timeline.snapshot().at(-1)).toMatchObject({
      type: 'operation-cancelled',
      status: 'cancelled',
      data: { cancellationReason: 'listener-failed' },
    });

    harness.session.emit('BluetoothEmulation.gattOperationReceived', {
      address,
      type: 'connection',
    });
    expect(deliveredEvents).toHaveLength(1);
    expect(harness.errors).toHaveLength(1);
    expect(harness.pendingOperations.size).toBe(1);
    expect(harness.pendingOperations.cancelAll('test cleanup')).toBe(1);
  });

  it('validates response correlation before sending a protocol command', async () => {
    const harness = await createHarness();

    await expect(
      harness.handler.respond({
        operationId: 'unknown',
        type: 'connection',
        result: 'success',
      }),
    ).rejects.toMatchObject({
      context: { reason: 'unknown-operation-id' },
    });

    harness.session.emit('BluetoothEmulation.gattOperationReceived', {
      address,
      type: 'connection',
    });
    const event = harness.events[0];
    if (event === undefined) throw new Error('Expected a GATT event.');
    await expect(
      harness.handler.respond({
        operationId: event.operationId,
        type: 'discovery',
        result: 'success',
      }),
    ).rejects.toMatchObject({
      context: { reason: 'operation-type-mismatch' },
    });

    expect(harness.session.calls).toEqual([]);
    harness.pendingOperations.cancelAll('test cleanup');
  });

  it('rejects an unknown HCI error name before sending or settling', async () => {
    const harness = await createHarness();
    harness.session.emit('BluetoothEmulation.gattOperationReceived', {
      address,
      type: 'connection',
    });
    const event = harness.events[0];
    if (event === undefined) throw new Error('Expected a GATT event.');

    await expect(
      harness.handler.respond({
        operationId: event.operationId,
        type: 'connection',
        result: 'error',
        error: 'not-a-real-name' as never,
      }),
    ).rejects.toMatchObject({
      code: 'BLUETOOTH_VALIDATION_FAILED',
      context: {
        reason: 'unknown-hci-error-name',
        receivedError: 'not-a-real-name',
      },
    });

    expect(harness.session.calls).toEqual([]);
    expect(harness.pendingOperations.size).toBe(1);
    expect(harness.pendingOperations.cancelAll('test cleanup')).toBe(1);
  });

  it('preserves the unsuccessful-discovery diagnostic deadline', async () => {
    const harness = await createHarness();
    harness.session.emit('BluetoothEmulation.gattOperationReceived', {
      address,
      type: 'discovery',
    });
    const event = harness.events[0];
    if (event === undefined) throw new Error('Expected a GATT event.');

    const response = harness.handler.respond({
      operationId: event.operationId,
      type: 'discovery',
      result: 'error',
      error: 'connection-timeout',
    });
    await flushPromiseQueue();

    expect(harness.session.calls).toEqual([
      {
        method: 'BluetoothEmulation.simulateGATTOperationResponse',
        parameters: { address, type: 'discovery', code: 0x08 },
      },
    ]);
    expect(harness.pendingOperations.size).toBe(1);
    harness.time.advanceBy(25);

    await expect(response).rejects.toMatchObject({
      code: 'BLUETOOTH_TIMEOUT',
      context: {
        responseDelivered: true,
        knownLimitation: 'unsuccessful-discovery-does-not-settle',
      },
    } satisfies Partial<BluetoothTimeoutError>);
    expect(harness.timeline.snapshot().at(-1)).toMatchObject({
      type: 'operation-timeout',
      status: 'timed-out',
    });
  });

  it('disconnects only a registered peripheral with its normalized address', async () => {
    const harness = await createHarness();

    await harness.handler.disconnect(
      '00:11:22:33:44:55'.toLowerCase() as BluetoothAddress,
    );
    await expect(
      harness.handler.disconnect(
        normalizeBluetoothAddress('00:11:22:33:44:66'),
      ),
    ).rejects.toMatchObject({
      code: 'BLUETOOTH_VALIDATION_FAILED',
      context: { reason: 'unknown-peripheral-address' },
    });

    expect(harness.session.calls).toEqual([
      {
        method: 'BluetoothEmulation.simulateGATTDisconnection',
        parameters: { address },
      },
    ]);
  });
});
