import { describe, expect, it } from 'vitest';

import {
  attErrorNames,
  createBluetoothTimeline,
  normalizeBluetoothAddress,
  normalizeBluetoothUuid,
  validatePeripheralDefinition,
  type AttErrorName,
  type BluetoothTimeline,
  type CharacteristicOperationEvent,
  type MonotonicClock,
} from '@gattlab/core';

import { CdpCharacteristicOperationHandler } from '../src/characteristic-operation-handler.js';
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

interface HandlerHarness {
  readonly entities: CdpEntityRegistry;
  readonly errors: unknown[];
  readonly events: CharacteristicOperationEvent[];
  readonly handler: CdpCharacteristicOperationHandler;
  readonly pendingOperations: PendingOperationRegistry;
  readonly session: FakeCdpSession;
  readonly timeline: BluetoothTimeline;
  readonly unsubscribe: () => void;
}

async function createHarness(
  listener?: (event: CharacteristicOperationEvent) => void,
): Promise<HandlerHarness> {
  const definition = validatePeripheralDefinition({
    address,
    name: 'Characteristic handler sensor',
    advertisement: {
      rssi: -45,
      name: 'Characteristic handler sensor',
    },
    services: [
      {
        uuid: serviceUuid,
        characteristics: [
          {
            uuid: characteristicUuid,
            properties: ['read', 'write', 'write-without-response', 'notify'],
            descriptors: [{ uuid: '2902' }],
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
    operationIdNamespace: 'characteristic-handler',
  });
  const handler = new CdpCharacteristicOperationHandler({
    transport,
    entities,
    pendingOperations,
    timeline,
  });
  const events: CharacteristicOperationEvent[] = [];
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
  session.emit('BluetoothEmulation.characteristicOperationReceived', {
    characteristicId: 'characteristic-1',
    ...payload,
  });
}

describe('CdpCharacteristicOperationHandler', () => {
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
      kind: 'characteristic-operation',
      characteristic: {
        kind: 'characteristic',
        address,
        serviceUuid,
        characteristicUuid,
      },
      type: 'read',
      operationId: 'characteristic-handler:1',
    });
    expect(Object.isFrozen(event)).toBe(true);
    expect(Object.isFrozen(event?.characteristic)).toBe(true);
    if (event === undefined) throw new Error('Expected a read event.');

    await harness.handler.respond({
      operationId: event.operationId,
      type: 'read',
      result: 'success',
      data: [0xde, 0xad, 0xbe, 0xef],
    });

    expect(harness.session.calls).toEqual([
      {
        method: 'BluetoothEmulation.simulateCharacteristicOperationResponse',
        parameters: {
          characteristicId: 'characteristic-1',
          type: 'read',
          code: 0x00,
          data: '3q2+7w==',
        },
      },
    ]);
    expect(harness.pendingOperations.size).toBe(0);

    harness.unsubscribe();
    harness.unsubscribe();
    emit(harness.session, { type: 'read' });
    expect(harness.events).toHaveLength(1);
  });

  it.each([
    ['write-default-deprecated', 'default-deprecated', 'AQ==', [1]],
    ['write-with-response', 'with-response', 'ECAw', [16, 32, 48]],
    ['write-without-response', 'without-response', 'QFA=', [64, 80]],
  ] as const)(
    'maps %s to stable %s semantics',
    async (writeType, stableWriteType, data, expectedData) => {
      const harness = await createHarness();
      emit(harness.session, { type: 'write', writeType, data });

      const event = harness.events[0];
      expect(event).toMatchObject({
        kind: 'characteristic-operation',
        characteristic: { address, serviceUuid, characteristicUuid },
        type: 'write',
        writeType: stableWriteType,
      });
      if (event?.type !== 'write') throw new Error('Expected a write event.');
      expect([...event.data]).toEqual(expectedData);

      await harness.handler.respond({
        operationId: event.operationId,
        type: 'write',
        result: 'success',
      });
      expect(harness.session.calls).toEqual([
        {
          method: 'BluetoothEmulation.simulateCharacteristicOperationResponse',
          parameters: {
            characteristicId: 'characteristic-1',
            type: 'write',
            code: 0x00,
          },
        },
      ]);
    },
  );

  it.each([
    'subscribe-to-notifications',
    'unsubscribe-from-notifications',
  ] as const)('maps the %s response handshake', async (type) => {
    const harness = await createHarness();
    emit(harness.session, { type });
    const event = harness.events[0];
    expect(event).toMatchObject({ type });
    if (event === undefined) throw new Error('Expected a subscription event.');

    await harness.handler.respond({
      operationId: event.operationId,
      type,
      result: 'success',
    });
    expect(harness.session.calls[0]).toEqual({
      method: 'BluetoothEmulation.simulateCharacteristicOperationResponse',
      parameters: {
        characteristicId: 'characteristic-1',
        type,
        code: 0x00,
      },
    });
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
        method: 'BluetoothEmulation.simulateCharacteristicOperationResponse',
        parameters: {
          characteristicId: 'characteristic-1',
          type: 'read',
          code,
        },
      },
    ]);
  });

  it('routes malformed inbound events to the sink and payload-free timeline entries', async () => {
    const harness = await createHarness();
    harness.session.emit('BluetoothEmulation.characteristicOperationReceived', {
      characteristicId: 'unknown',
      type: 'read',
    });
    emit(harness.session, { type: 'invalid' });
    emit(harness.session, {
      type: 'write',
      writeType: 'write-with-response',
      data: 'not base64',
    });
    emit(harness.session, {
      type: 'write',
      writeType: 'invalid',
      data: 'AQ==',
    });
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
      'unknown-characteristic-id',
      'invalid-characteristic-operation-type',
      'invalid-characteristic-write-data',
      'invalid-characteristic-write-type',
      'unexpected-characteristic-write-fields',
    ]);
    expect(
      harness.timeline
        .snapshot()
        .filter(({ type }) => type === 'characteristic-event-rejected')
        .map(({ data }) => data),
    ).toEqual([
      { reason: 'unknown-characteristic-id', source: 'event' },
      { reason: 'invalid-characteristic-operation-type', source: 'event' },
      { reason: 'invalid-characteristic-write-data', source: 'event' },
      { reason: 'invalid-characteristic-write-type', source: 'event' },
      { reason: 'unexpected-characteristic-write-fields', source: 'event' },
    ]);
  });

  it('cancels a registered operation when its listener throws', async () => {
    let attempts = 0;
    const delivered: CharacteristicOperationEvent[] = [];
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

  it('routes same-key concurrency through the registry without duplicate rejection diagnostics', async () => {
    const harness = await createHarness();
    emit(harness.session, { type: 'read' });
    emit(harness.session, { type: 'read' });

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
        .filter(({ type }) => type === 'characteristic-event-rejected'),
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
      context: { reason: 'invalid-characteristic-read-data' },
    });

    expect(harness.session.calls).toEqual([]);
    expect(harness.pendingOperations.size).toBe(1);
    expect(harness.pendingOperations.cancelAll('test cleanup')).toBe(1);
  });

  it('validates response correlation before sending a protocol command', async () => {
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
    expect(harness.pendingOperations.cancelAll('test cleanup')).toBe(1);
  });

  it('rejects a response when an entity-registry failure invalidates its characteristic', async () => {
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
      context: { reason: 'stale-characteristic-reference' },
    });

    expect(harness.session.calls).toEqual([]);
    expect(harness.pendingOperations.size).toBe(0);
    expect(harness.timeline.snapshot().at(-1)).toMatchObject({
      type: 'operation-response',
      status: 'failed',
    });
  });
});
