import { describe, expect, it } from 'vitest';

import {
  attErrorNames,
  createBluetoothTimeline,
  normalizeBluetoothAddress,
  normalizeBluetoothUuid,
  validatePeripheralDefinition,
  type AttErrorName,
  type BluetoothTimeline,
  type DescriptorOperationEvent,
  type MonotonicClock,
} from '@gattlab/core';

import { CdpDescriptorOperationHandler } from '../src/descriptor-operation-handler.js';
import { CdpEntityRegistry } from '../src/entity-registry.js';
import { attErrorCodes } from '../src/error-codes.js';
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
  #nextDescriptorSequence = 0;
  failMethod: string | undefined;

  async send(method: string, parameters?: object): Promise<unknown> {
    this.calls.push({
      method,
      ...(parameters === undefined ? {} : { parameters }),
    });
    if (method === this.failMethod) throw new Error(`${method} failed`);
    switch (method) {
      case 'BluetoothEmulation.addService':
        return { serviceId: 'service-1' };
      case 'BluetoothEmulation.addCharacteristic':
        return { characteristicId: 'characteristic-1' };
      case 'BluetoothEmulation.addDescriptor': {
        this.#nextDescriptorSequence += 1;
        return {
          descriptorId: `descriptor-${String(this.#nextDescriptorSequence)}`,
        };
      }
      default:
        return {};
    }
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
  readonly #deadlines = new Map<number, () => void>();

  now(): number {
    return this.#now;
  }

  schedule(_deadlineMs: number, onDeadline: () => void): OperationDeadline {
    this.#nextId += 1;
    const id = this.#nextId;
    this.#deadlines.set(id, onDeadline);
    return Object.freeze({
      cancel: () => {
        this.#deadlines.delete(id);
      },
    });
  }
}

const address = normalizeBluetoothAddress('00:11:22:33:44:55');
const serviceUuid = normalizeBluetoothUuid('180f');
const characteristicUuid = normalizeBluetoothUuid('2a19');
const descriptorUuid = normalizeBluetoothUuid('2901');
const secondDescriptorUuid = normalizeBluetoothUuid('2902');

interface HandlerHarness {
  readonly entities: CdpEntityRegistry;
  readonly errors: unknown[];
  readonly events: DescriptorOperationEvent[];
  readonly handler: CdpDescriptorOperationHandler;
  readonly pendingOperations: PendingOperationRegistry;
  readonly session: FakeCdpSession;
  readonly timeline: BluetoothTimeline;
  readonly unsubscribe: () => void;
}

async function createHarness(
  listener?: (event: DescriptorOperationEvent) => void,
): Promise<HandlerHarness> {
  const definition = validatePeripheralDefinition({
    address,
    name: 'Descriptor handler sensor',
    advertisement: {
      rssi: -45,
      name: 'Descriptor handler sensor',
    },
    services: [
      {
        uuid: serviceUuid,
        characteristics: [
          {
            uuid: characteristicUuid,
            properties: ['read', 'write'],
            descriptors: [
              { uuid: descriptorUuid },
              { uuid: secondDescriptorUuid },
            ],
          },
        ],
      },
    ],
  });
  if (!definition.success) throw new Error('Expected a valid fixture.');

  const session = new FakeCdpSession();
  const transport = createCdpTransport('browser', session);
  const entities = new CdpEntityRegistry(transport);
  await entities.addPeripheralHierarchy(definition.value);
  session.calls.length = 0;
  const time = new FakeTime();
  const timeline = createBluetoothTimeline({ limit: 100, clock: time });
  const pendingOperations = new PendingOperationRegistry({
    timeline,
    defaultDeadlineMs: 25,
    deadlineScheduler: time,
    operationIdNamespace: 'descriptor-handler',
  });
  const handler = new CdpDescriptorOperationHandler({
    transport,
    entities,
    pendingOperations,
    timeline,
  });
  const events: DescriptorOperationEvent[] = [];
  const errors: unknown[] = [];
  const unsubscribe = handler.subscribe(
    listener ?? ((event) => events.push(event)),
    (cause) => errors.push(cause),
  );
  return {
    entities,
    errors,
    events,
    handler,
    pendingOperations,
    session,
    timeline,
    unsubscribe,
  };
}

function emit(
  session: FakeCdpSession,
  payload: Readonly<Record<string, unknown>>,
): void {
  session.emit('BluetoothEmulation.descriptorOperationReceived', {
    descriptorId: 'descriptor-1',
    ...payload,
  });
}

describe('CdpDescriptorOperationHandler', () => {
  it('maps a stable read event and returns canonical Base64 data', async () => {
    const harness = await createHarness();

    expect(() =>
      harness.handler.subscribe(
        () => undefined,
        () => undefined,
      ),
    ).toThrow('already subscribed');
    emit(harness.session, { type: 'read' });

    const event = harness.events[0];
    expect(event).toEqual({
      kind: 'descriptor-operation',
      descriptor: {
        kind: 'descriptor',
        address,
        serviceUuid,
        characteristicUuid,
        descriptorUuid,
      },
      type: 'read',
      operationId: 'descriptor-handler:1',
    });
    expect(Object.isFrozen(event)).toBe(true);
    expect(Object.isFrozen(event?.descriptor)).toBe(true);
    if (event === undefined) throw new Error('Expected a read event.');

    await harness.handler.respond({
      operationId: event.operationId,
      type: 'read',
      result: 'success',
      data: [1, 2, 3, 4],
    });

    expect(harness.session.calls).toEqual([
      {
        method: 'BluetoothEmulation.simulateDescriptorOperationResponse',
        parameters: {
          descriptorId: 'descriptor-1',
          type: 'read',
          code: 0x00,
          data: 'AQIDBA==',
        },
      },
    ]);
    expect(harness.pendingOperations.size).toBe(0);

    harness.unsubscribe();
    harness.unsubscribe();
    emit(harness.session, { type: 'read' });
    expect(harness.events).toHaveLength(1);
  });

  it('maps exact write bytes and sends a payload-free success', async () => {
    const harness = await createHarness();
    emit(harness.session, { type: 'write', data: 'cIA=' });

    const event = harness.events[0];
    expect(event).toMatchObject({
      kind: 'descriptor-operation',
      descriptor: { address, serviceUuid, characteristicUuid, descriptorUuid },
      type: 'write',
    });
    if (event?.type !== 'write') throw new Error('Expected a write event.');
    expect([...event.data]).toEqual([112, 128]);

    await harness.handler.respond({
      operationId: event.operationId,
      type: 'write',
      result: 'success',
    });
    expect(harness.session.calls).toEqual([
      {
        method: 'BluetoothEmulation.simulateDescriptorOperationResponse',
        parameters: {
          descriptorId: 'descriptor-1',
          type: 'write',
          code: 0x00,
        },
      },
    ]);
  });

  it('routes a second descriptor through its distinct stable-reference index entry', async () => {
    const harness = await createHarness();
    emit(harness.session, { descriptorId: 'descriptor-2', type: 'read' });

    const event = harness.events[0];
    expect(event).toMatchObject({
      kind: 'descriptor-operation',
      descriptor: {
        address,
        serviceUuid,
        characteristicUuid,
        descriptorUuid: secondDescriptorUuid,
      },
      type: 'read',
    });
    if (event === undefined) throw new Error('Expected a read event.');

    await harness.handler.respond({
      operationId: event.operationId,
      type: 'read',
      result: 'success',
      data: [2],
    });
    expect(harness.session.calls).toEqual([
      {
        method: 'BluetoothEmulation.simulateDescriptorOperationResponse',
        parameters: {
          descriptorId: 'descriptor-2',
          type: 'read',
          code: 0x00,
          data: 'Ag==',
        },
      },
    ]);
  });

  it.each(
    attErrorNames.map((name): readonly [AttErrorName, number] => [
      name,
      attErrorCodes[name],
    ]),
  )('maps the %s ATT error to code %#i', async (error, code) => {
    const harness = await createHarness();
    emit(harness.session, { type: 'read' });
    const event = harness.events[0];
    if (event === undefined) throw new Error('Expected a read event.');

    await harness.handler.respond({
      operationId: event.operationId,
      type: 'read',
      result: 'error',
      error,
    });

    expect(harness.session.calls).toEqual([
      {
        method: 'BluetoothEmulation.simulateDescriptorOperationResponse',
        parameters: {
          descriptorId: 'descriptor-1',
          type: 'read',
          code,
        },
      },
    ]);
  });

  it('routes malformed inbound events to the sink and payload-free timeline entries', async () => {
    const harness = await createHarness();
    harness.session.emit('BluetoothEmulation.descriptorOperationReceived', {
      descriptorId: 'unknown',
      type: 'read',
    });
    emit(harness.session, { type: 'invalid' });
    emit(harness.session, { type: 'write', data: 'not base64' });
    emit(harness.session, { type: 'read', data: 'AQ==' });

    expect(harness.events).toEqual([]);
    expect(harness.pendingOperations.size).toBe(0);
    expect(
      harness.errors.map((cause) =>
        typeof cause === 'object' && cause !== null && 'context' in cause
          ? (cause as { context: { reason?: unknown } }).context.reason
          : undefined,
      ),
    ).toEqual([
      'unknown-descriptor-id',
      'invalid-descriptor-operation-type',
      'invalid-descriptor-write-data',
      'unexpected-descriptor-write-data',
    ]);
    expect(
      harness.timeline
        .snapshot()
        .filter(({ type }) => type === 'descriptor-event-rejected')
        .map(({ data }) => data),
    ).toEqual([
      { reason: 'unknown-descriptor-id', source: 'event' },
      { reason: 'invalid-descriptor-operation-type', source: 'event' },
      { reason: 'invalid-descriptor-write-data', source: 'event' },
      { reason: 'unexpected-descriptor-write-data', source: 'event' },
    ]);
  });

  it('cancels a registered operation when its listener throws', async () => {
    let attempts = 0;
    const delivered: DescriptorOperationEvent[] = [];
    const harness = await createHarness((event) => {
      attempts += 1;
      if (attempts === 1) throw new Error('listener failed');
      delivered.push(event);
    });

    emit(harness.session, { type: 'read' });
    expect(harness.errors).toEqual([new Error('listener failed')]);
    expect(harness.pendingOperations.size).toBe(0);
    expect(harness.timeline.snapshot().at(-1)).toMatchObject({
      type: 'operation-cancelled',
      data: { cancellationReason: 'listener-failed' },
    });

    emit(harness.session, { type: 'read' });
    expect(delivered).toHaveLength(1);
    expect(harness.pendingOperations.size).toBe(1);
    expect(harness.pendingOperations.cancelAll('test cleanup')).toBe(1);
  });

  it('routes same-key concurrency through the registry once', async () => {
    const harness = await createHarness();
    emit(harness.session, { type: 'write', data: 'AQ==' });
    emit(harness.session, { type: 'write', data: 'Ag==' });

    expect(harness.events).toHaveLength(1);
    expect(harness.errors).toEqual([
      expect.objectContaining({ code: 'BLUETOOTH_CONCURRENT_OPERATION' }),
    ]);
    expect(harness.pendingOperations.size).toBe(1);
    expect(
      harness.timeline
        .snapshot()
        .filter(({ type }) => type === 'operation-concurrency-rejected'),
    ).toHaveLength(1);
    expect(
      harness.timeline
        .snapshot()
        .filter(({ type }) => type === 'descriptor-event-rejected'),
    ).toHaveLength(0);
    expect(harness.pendingOperations.cancelAll('test cleanup')).toBe(1);
  });

  it('validates runtime responses before registry settlement or protocol mutation', async () => {
    const harness = await createHarness();
    emit(harness.session, { type: 'read' });
    const event = harness.events[0];
    if (event === undefined) throw new Error('Expected a read event.');

    await expect(
      harness.handler.respond({
        operationId: event.operationId,
        type: 'read',
        result: 'error',
        error: 'not-an-att-name' as never,
      }),
    ).rejects.toMatchObject({
      context: { reason: 'unknown-att-error-name' },
    });
    await expect(
      harness.handler.respond({
        operationId: event.operationId,
        type: 'read',
        result: 'success',
        data: [256] as never,
      }),
    ).rejects.toMatchObject({
      context: { reason: 'invalid-descriptor-read-data' },
    });

    expect(harness.session.calls).toEqual([]);
    expect(harness.pendingOperations.size).toBe(1);
    expect(harness.pendingOperations.cancelAll('test cleanup')).toBe(1);
  });

  it('validates response correlation and duplicate settlement before commands', async () => {
    const harness = await createHarness();
    await expect(
      harness.handler.respond({
        operationId: 'unknown',
        type: 'read',
        result: 'success',
        data: [1],
      }),
    ).rejects.toMatchObject({
      context: { reason: 'unknown-operation-id' },
    });

    emit(harness.session, { type: 'read' });
    const event = harness.events[0];
    if (event === undefined) throw new Error('Expected a read event.');
    await expect(
      harness.handler.respond({
        operationId: event.operationId,
        type: 'write',
        result: 'success',
      }),
    ).rejects.toMatchObject({
      context: { reason: 'operation-type-mismatch' },
    });
    expect(harness.session.calls).toEqual([]);

    await harness.handler.respond({
      operationId: event.operationId,
      type: 'read',
      result: 'success',
      data: [1],
    });
    await expect(
      harness.handler.respond({
        operationId: event.operationId,
        type: 'read',
        result: 'success',
        data: [1],
      }),
    ).rejects.toMatchObject({
      context: { reason: 'settled-operation-id' },
    });
    expect(harness.session.calls).toHaveLength(1);
  });

  it('rejects a response after entity invalidation removes its descriptor index', async () => {
    const harness = await createHarness();
    emit(harness.session, { type: 'read' });
    const event = harness.events[0];
    if (event === undefined) throw new Error('Expected a read event.');

    harness.session.failMethod = 'BluetoothEmulation.simulateAdvertisement';
    await expect(
      harness.entities.simulateAdvertisement(address),
    ).rejects.toThrow('BluetoothEmulation.simulateAdvertisement failed');
    expect(harness.entities.requiresReset).toBe(true);
    harness.session.calls.length = 0;

    await expect(
      harness.handler.respond({
        operationId: event.operationId,
        type: 'read',
        result: 'success',
        data: [1],
      }),
    ).rejects.toMatchObject({
      context: { reason: 'stale-descriptor-reference' },
    });

    expect(harness.session.calls).toEqual([]);
    expect(harness.pendingOperations.size).toBe(0);
    expect(harness.timeline.snapshot().at(-1)).toMatchObject({
      type: 'operation-response',
      status: 'failed',
    });
  });
});
