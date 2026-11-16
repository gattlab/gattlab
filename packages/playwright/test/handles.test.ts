import {
  BluetoothBackendStoppedError,
  BluetoothCancelledError,
  BluetoothTimeoutError,
  normalizeBluetoothAddress,
  normalizeBluetoothUuid,
  type BackendBluetoothEvent,
  type CharacteristicOperationResponse,
  type DescriptorOperationResponse,
  type GattOperationResponse,
} from '@gattlab/core';
import { describe, expect, it, vi } from 'vitest';
import type { CdpLabInvalidation } from '@gattlab/cdp';

import {
  createBluetoothLab,
  type GattLabRuntime,
} from '../src/bluetooth-lab.js';
import type {
  BluetoothHandleBackend,
  HandleDeadline,
  HandleDeadlineScheduler,
} from '../src/handles.js';

interface HandleHarness {
  readonly backend: BluetoothHandleBackend;
  readonly checkLiveness: ReturnType<typeof vi.fn>;
  readonly withCommandBudget: ReturnType<
    typeof vi.fn<BluetoothHandleBackend['withCommandBudget']>
  >;
  invalidate(record: CdpLabInvalidation): void;
  readonly addPeripheral: ReturnType<typeof vi.fn>;
  readonly createPreconnectedPeripheral: ReturnType<typeof vi.fn>;
  readonly capturePeripheralDiagnostics: ReturnType<typeof vi.fn>;
  readonly disconnect: ReturnType<typeof vi.fn>;
  readonly respondToCharacteristicOperation: ReturnType<typeof vi.fn>;
  readonly respondToDescriptorOperation: ReturnType<typeof vi.fn>;
  readonly respondToGattOperation: ReturnType<typeof vi.fn>;
  readonly runtime: GattLabRuntime;
  readonly scheduler: ManualScheduler;
  readonly simulateAdvertisement: ReturnType<typeof vi.fn>;
  readonly stop: ReturnType<typeof vi.fn>;
  readonly withBackend: ReturnType<typeof vi.fn>;
  emit(event: BackendBluetoothEvent): void;
}

interface ManualEntry {
  active: boolean;
  readonly onDeadline: () => void;
  readonly deadlineMs: number;
  readonly dueAt: number;
}

class ManualScheduler implements HandleDeadlineScheduler {
  readonly #entries: ManualEntry[] = [];
  #now = 0;

  get activeCount(): number {
    return this.#entries.filter(({ active }) => active).length;
  }

  schedule(deadlineMs: number, onDeadline: () => void): HandleDeadline {
    const entry: ManualEntry = {
      active: true,
      onDeadline,
      deadlineMs,
      dueAt: this.#now + deadlineMs,
    };
    this.#entries.push(entry);
    return Object.freeze({
      cancel(): void {
        entry.active = false;
      },
    });
  }

  get activeBudgets(): readonly number[] {
    return this.#entries
      .filter(({ active }) => active)
      .map(({ deadlineMs }) => deadlineMs);
  }

  advance(elapsedMs: number): void {
    this.#now += elapsedMs;
    for (const entry of this.#entries) {
      if (!entry.active || entry.dueAt > this.#now) continue;
      entry.active = false;
      entry.onDeadline();
    }
  }

  expireAll(): void {
    for (const entry of this.#entries) {
      if (!entry.active) continue;
      entry.active = false;
      entry.onDeadline();
    }
  }
}

function createHarness(
  overrides: Readonly<{
    operationHistoryLimit?: number;
    operationTimeoutMs?: number;
    respondToGattOperation?: (response: GattOperationResponse) => Promise<void>;
  }> = {},
): HandleHarness {
  let listener: ((event: BackendBluetoothEvent) => void) | undefined;
  const addPeripheral = vi.fn(async () => undefined);
  const simulateAdvertisement = vi.fn(async () => undefined);
  const createPreconnectedPeripheral = vi.fn(async () => undefined);
  const disconnect = vi.fn(async () => undefined);
  const respondToGattOperation = vi.fn(
    overrides.respondToGattOperation ?? (async () => undefined),
  );
  const respondToCharacteristicOperation = vi.fn<
    (response: CharacteristicOperationResponse) => Promise<void>
  >(async () => undefined);
  const respondToDescriptorOperation = vi.fn<
    (response: DescriptorOperationResponse) => Promise<void>
  >(async () => undefined);
  const invalidationListeners = new Set<(record: CdpLabInvalidation) => void>();
  let invalidation: CdpLabInvalidation | undefined;
  const assertUsable = (operation: string): void => {
    if (invalidation === undefined) return;
    const { cause, ...context } = invalidation;
    throw new BluetoothBackendStoppedError('Lab invalidated.', {
      cause,
      context: { ...context, operation, operationLayer: 'playwright' },
    });
  };
  const checkLiveness = vi.fn(async () => undefined);
  const withCommandBudget = vi.fn<BluetoothHandleBackend['withCommandBudget']>(
    async (operation, _layer, work) => work({}, () => assertUsable(operation)),
  );
  const backend: BluetoothHandleBackend = {
    assertUsable,
    checkLiveness,
    withCommandBudget:
      withCommandBudget as BluetoothHandleBackend['withCommandBudget'],
    async diagnoseTimeout(operation, _layer, timeout) {
      throw new BluetoothTimeoutError(timeout.message, {
        cause: timeout.cause,
        context: {
          ...timeout.context,
          operation,
          operationLayer: 'playwright',
          deadlineKind: 'application-operation',
          timeoutPhase: 'operation',
          checkDeadlineMs: 30000,
          detection: 'live',
          centralStateBlocked: false,
          remediation: 'inspect-operation',
        },
      });
    },
    addPeripheral,
    simulateAdvertisement,
    createPreconnectedPeripheral,
    disconnect,
    respondToGattOperation,
    respondToCharacteristicOperation,
    respondToDescriptorOperation,
    onEvent(nextListener) {
      listener = nextListener;
      return () => {
        if (listener === nextListener) listener = undefined;
      };
    },
  };
  const withBackendImplementation: GattLabRuntime['withBackend'] = (
    operation,
  ) => operation(backend as Parameters<typeof operation>[0]);
  const withBackend = vi.fn(withBackendImplementation);
  const stop = vi.fn(async () => undefined);
  const capturePeripheralDiagnostics = vi.fn();
  const runtime = {
    options: {
      operationTimeoutMs: overrides.operationTimeoutMs ?? 25,
      operationHistoryLimit: overrides.operationHistoryLimit ?? 1_000,
    },
    withBackend,
    assertUsable,
    onInvalidated(listener: (record: CdpLabInvalidation) => void) {
      invalidationListeners.add(listener);
      return () => {
        invalidationListeners.delete(listener);
      };
    },
    capturePeripheralDiagnostics,
    stop,
  } as GattLabRuntime;
  const scheduler = new ManualScheduler();
  return {
    backend,
    checkLiveness,
    withCommandBudget,
    invalidate(record) {
      if (invalidation !== undefined) return;
      invalidation = record;
      for (const listener of invalidationListeners) listener(record);
    },
    addPeripheral,
    capturePeripheralDiagnostics,
    createPreconnectedPeripheral,
    disconnect,
    respondToCharacteristicOperation,
    respondToDescriptorOperation,
    respondToGattOperation,
    runtime,
    scheduler,
    simulateAdvertisement,
    stop,
    withBackend,
    emit(event) {
      listener?.(event);
    },
  };
}

function peripheralDefinition() {
  return {
    address: '09:09:09:09:09:09',
    name: 'Battery Sensor',
    advertisement: { rssi: -45 },
    services: [
      {
        uuid: '180f',
        characteristics: [
          {
            uuid: '2a19',
            properties: ['read', 'write', 'notify'] as const,
            initialValue: [5],
            descriptors: [
              { uuid: '2901', initialValue: [65] },
              { uuid: '2902', initialValue: [0, 0] },
            ],
          },
        ],
      },
      {
        uuid: '1810',
        characteristics: [
          { uuid: '2a19', properties: ['read'] as const, initialValue: [9] },
        ],
      },
    ],
  };
}

function characteristicEvent(
  operationId: string,
  type:
    'read' | 'subscribe-to-notifications' | 'unsubscribe-from-notifications',
): BackendBluetoothEvent {
  return {
    kind: 'characteristic-operation',
    operationId,
    characteristic: {
      kind: 'characteristic',
      address: normalizeBluetoothAddress('09:09:09:09:09:09'),
      serviceUuid: normalizeBluetoothUuid('180f'),
      characteristicUuid: normalizeBluetoothUuid('2a19'),
    },
    type,
  };
}

async function flushOperations(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await Promise.resolve(undefined);
}

describe('Bluetooth public handles', () => {
  it('validates before lazy start and rejects normalized duplicate addresses', async () => {
    const harness = createHarness();
    const bluetooth = createBluetoothLab(harness.runtime, harness.scheduler);

    await expect(
      bluetooth.createPeripheral({ address: 'bad', name: 'broken' }),
    ).rejects.toMatchObject({ code: 'BLUETOOTH_VALIDATION_FAILED' });
    expect(harness.withBackend).not.toHaveBeenCalled();

    await bluetooth.createPeripheral(peripheralDefinition());
    expect(harness.capturePeripheralDiagnostics).toHaveBeenCalledOnce();
    await expect(
      bluetooth.createPeripheral({
        ...peripheralDefinition(),
        address: '09:09:09:09:09:09'.toLowerCase(),
      }),
    ).rejects.toMatchObject({
      code: 'BLUETOOTH_PERIPHERAL_ALREADY_REGISTERED',
    });
    expect(harness.addPeripheral).toHaveBeenCalledOnce();
  });

  it('reserves normalized addresses before a concurrent backend mutation settles', async () => {
    const harness = createHarness();
    let releaseRegistration: (() => void) | undefined;
    const heldRegistration = new Promise<void>((resolve) => {
      releaseRegistration = resolve;
    });
    harness.addPeripheral.mockImplementationOnce(() => heldRegistration);
    const bluetooth = createBluetoothLab(harness.runtime, harness.scheduler);

    const firstRegistration = bluetooth.createPeripheral(
      peripheralDefinition(),
    );
    const duplicateRegistration = bluetooth.createPeripheral({
      ...peripheralDefinition(),
      address: '09:09:09:09:09:09'.toLowerCase(),
    });

    await expect(duplicateRegistration).rejects.toMatchObject({
      code: 'BLUETOOTH_PERIPHERAL_ALREADY_REGISTERED',
    });
    expect(harness.addPeripheral).toHaveBeenCalledOnce();
    releaseRegistration?.();
    await expect(firstRegistration).resolves.toMatchObject({
      address: normalizeBluetoothAddress('09:09:09:09:09:09'),
    });
  });

  it('uses service plus characteristic UUID identity and normalized lookup', async () => {
    const harness = createHarness();
    const bluetooth = createBluetoothLab(harness.runtime, harness.scheduler);
    const peripheral = await bluetooth.createPeripheral(peripheralDefinition());

    const battery = peripheral.characteristic('180F', '2A19');
    const bloodPressure = peripheral.characteristic('1810', '2a19');

    expect(battery).not.toBe(bloodPressure);
    expect(battery.serviceUuid).toBe(normalizeBluetoothUuid('180f'));
    expect(bloodPressure.serviceUuid).toBe(normalizeBluetoothUuid('1810'));
    expect(() => peripheral.characteristic('180d', '2a19')).toThrowError(
      expect.objectContaining({
        code: 'BLUETOOTH_VALIDATION_FAILED',
        context: expect.objectContaining({
          reason: 'characteristic-not-found',
        }),
      }),
    );
  });

  it('serializes GATT responses and consumes queued overrides once', async () => {
    let releaseFirst: (() => void) | undefined;
    const firstResponse = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const order: string[] = [];
    const harness = createHarness({
      respondToGattOperation: async (response) => {
        order.push(response.operationId);
        if (response.operationId === 'gatt-1') await firstResponse;
      },
    });
    const bluetooth = createBluetoothLab(harness.runtime, harness.scheduler);
    const peripheral = await bluetooth.createPeripheral(peripheralDefinition());
    peripheral.connection.queueError('connection-timeout');
    peripheral.connection.queueSuccess();

    harness.emit({
      kind: 'gatt-operation',
      operationId: 'gatt-1',
      peripheral: { kind: 'peripheral', address: peripheral.address },
      type: 'connection',
    });
    harness.emit({
      kind: 'gatt-operation',
      operationId: 'gatt-2',
      peripheral: { kind: 'peripheral', address: peripheral.address },
      type: 'connection',
    });
    harness.emit({
      kind: 'gatt-operation',
      operationId: 'gatt-3',
      peripheral: { kind: 'peripheral', address: peripheral.address },
      type: 'connection',
    });
    harness.emit({
      kind: 'gatt-operation',
      operationId: 'gatt-4',
      peripheral: { kind: 'peripheral', address: peripheral.address },
      type: 'discovery',
    });
    harness.emit({
      kind: 'gatt-operation',
      operationId: 'gatt-5',
      peripheral: { kind: 'peripheral', address: peripheral.address },
      type: 'discovery',
    });
    await flushOperations();

    expect(order).toEqual(['gatt-1']);
    releaseFirst?.();
    await flushOperations();
    expect(order).toEqual(['gatt-1', 'gatt-2', 'gatt-3', 'gatt-4', 'gatt-5']);
    expect(peripheral.operations()).toMatchObject([
      {
        sequence: 1,
        response: { result: 'error', error: 'connection-timeout' },
        responseSource: 'queued',
        responseDelivery: 'succeeded',
      },
      {
        sequence: 2,
        response: { result: 'success' },
        responseSource: 'queued',
        responseDelivery: 'succeeded',
      },
      {
        sequence: 3,
        request: { type: 'connection' },
        response: { result: 'success' },
        responseSource: 'default',
      },
      {
        sequence: 4,
        request: { type: 'discovery' },
        response: { result: 'success' },
        responseSource: 'default',
      },
      {
        sequence: 5,
        request: { type: 'discovery' },
        response: { result: 'success' },
        responseSource: 'default',
      },
    ]);
  });

  it('copies queued reads, bounds journals, and keeps expectRead sticky after eviction', async () => {
    const harness = createHarness({ operationHistoryLimit: 2 });
    const bluetooth = createBluetoothLab(harness.runtime, harness.scheduler);
    const peripheral = await bluetooth.createPeripheral(peripheralDefinition());
    const characteristic = peripheral.characteristic('180f', '2a19');
    const queued = new Uint8Array([87]);
    characteristic.reads.queue(queued);
    characteristic.reads.queue(new Uint8Array([88]));
    queued[0] = 1;

    const expectedRead = characteristic.expectRead();
    expect(harness.respondToCharacteristicOperation).not.toHaveBeenCalled();
    harness.emit(characteristicEvent('read-1', 'read'));
    await expect(expectedRead).resolves.toBeUndefined();
    expect(harness.respondToCharacteristicOperation).toHaveBeenLastCalledWith(
      {
        operationId: 'read-1',
        type: 'read',
        result: 'success',
        data: new Uint8Array([87]),
      },
      {},
    );

    harness.emit(characteristicEvent('read-2', 'read'));
    harness.emit(characteristicEvent('read-3', 'read'));
    await flushOperations();
    expect(harness.respondToCharacteristicOperation).toHaveBeenNthCalledWith(
      2,
      {
        operationId: 'read-2',
        type: 'read',
        result: 'success',
        data: new Uint8Array([88]),
      },
      {},
    );
    expect(harness.respondToCharacteristicOperation).toHaveBeenNthCalledWith(
      3,
      {
        operationId: 'read-3',
        type: 'read',
        result: 'success',
        data: new Uint8Array([5]),
      },
      {},
    );
    expect(characteristic.operations()).toHaveLength(2);
    await expect(characteristic.expectRead()).resolves.toBeUndefined();

    const firstSnapshot = characteristic.operations();
    const response = firstSnapshot[0]?.response;
    if (response?.type !== 'read' || response.result !== 'success') {
      throw new Error('Expected a successful read snapshot.');
    }
    response.data[0] = 99;
    const secondSnapshot = characteristic.operations();
    const copiedResponse = secondSnapshot[0]?.response;
    expect(
      copiedResponse?.type === 'read' && copiedResponse.result === 'success'
        ? [...copiedResponse.data]
        : undefined,
    ).toEqual([88]);
    expect(Object.isFrozen(secondSnapshot)).toBe(true);
    expect(Object.isFrozen(secondSnapshot[0])).toBe(true);
  });

  it('scripts writes and descriptor operations while returning copied write requests', async () => {
    const harness = createHarness();
    const bluetooth = createBluetoothLab(harness.runtime, harness.scheduler);
    const peripheral = await bluetooth.createPeripheral(peripheralDefinition());
    const characteristic = peripheral.characteristic('180f', '2a19');
    const descriptor = characteristic.descriptor('2901');
    characteristic.writes.queueError('write-not-permitted');
    const characteristicWrite = characteristic.waitForWrite();

    const writeData = new Uint8Array([1, 2]);
    harness.emit({
      kind: 'characteristic-operation',
      operationId: 'write-1',
      characteristic: {
        kind: 'characteristic',
        address: peripheral.address,
        serviceUuid: characteristic.serviceUuid,
        characteristicUuid: characteristic.uuid,
      },
      type: 'write',
      writeType: 'with-response',
      data: writeData,
    });
    writeData[0] = 9;
    await expect(characteristicWrite).resolves.toEqual({
      data: new Uint8Array([1, 2]),
      writeType: 'with-response',
    });
    expect(harness.respondToCharacteristicOperation).toHaveBeenLastCalledWith(
      {
        operationId: 'write-1',
        type: 'write',
        result: 'error',
        error: 'write-not-permitted',
      },
      {},
    );

    harness.emit({
      kind: 'descriptor-operation',
      operationId: 'descriptor-read-1',
      descriptor: {
        kind: 'descriptor',
        address: peripheral.address,
        serviceUuid: characteristic.serviceUuid,
        characteristicUuid: characteristic.uuid,
        descriptorUuid: descriptor.uuid,
      },
      type: 'read',
    });
    await flushOperations();
    expect(harness.respondToDescriptorOperation).toHaveBeenLastCalledWith(
      {
        operationId: 'descriptor-read-1',
        type: 'read',
        result: 'success',
        data: new Uint8Array([65]),
      },
      {},
    );

    const descriptorWrite = descriptor.waitForWrite();
    harness.emit({
      kind: 'descriptor-operation',
      operationId: 'descriptor-write-1',
      descriptor: {
        kind: 'descriptor',
        address: peripheral.address,
        serviceUuid: characteristic.serviceUuid,
        characteristicUuid: characteristic.uuid,
        descriptorUuid: descriptor.uuid,
      },
      type: 'write',
      data: new Uint8Array([66]),
    });
    await expect(descriptorWrite).resolves.toEqual({
      data: new Uint8Array([66]),
    });
  });

  it('scripts subscription errors and keeps successful expectations sticky', async () => {
    const harness = createHarness();
    const bluetooth = createBluetoothLab(harness.runtime, harness.scheduler);
    const peripheral = await bluetooth.createPeripheral(peripheralDefinition());
    const characteristic = peripheral.characteristic('180f', '2a19');
    characteristic.subscriptions.queueError('unlikely-error');
    const expectedSubscription = characteristic.expectSubscription();

    harness.emit(
      characteristicEvent('subscribe-1', 'subscribe-to-notifications'),
    );
    await flushOperations();
    expect(harness.respondToCharacteristicOperation).toHaveBeenLastCalledWith(
      {
        operationId: 'subscribe-1',
        type: 'subscribe-to-notifications',
        result: 'error',
        error: 'unlikely-error',
      },
      {},
    );

    harness.emit(
      characteristicEvent('subscribe-2', 'subscribe-to-notifications'),
    );
    await expect(expectedSubscription).resolves.toBeUndefined();
    await expect(characteristic.expectSubscription()).resolves.toBeUndefined();

    const expectedUnsubscription = characteristic.expectUnsubscription();
    harness.emit(
      characteristicEvent('unsubscribe-1', 'unsubscribe-from-notifications'),
    );
    await expect(expectedUnsubscription).resolves.toBeUndefined();
  });

  it('times out bounded expectations and cancels pending waits on disposal', async () => {
    const harness = createHarness();
    const bluetooth = createBluetoothLab(harness.runtime, harness.scheduler);
    const peripheral = await bluetooth.createPeripheral(peripheralDefinition());
    const characteristic = peripheral.characteristic('180f', '2a19');

    const timedOut = characteristic.expectRead();
    await flushOperations();
    expect(harness.scheduler.activeCount).toBe(1);
    harness.scheduler.expireAll();
    await expect(timedOut).rejects.toMatchObject({
      code: 'BLUETOOTH_TIMEOUT',
      context: expect.objectContaining({
        deadlineMs: 25,
        operation: 'expectRead',
      }),
    });

    const pendingWrite = characteristic.waitForWrite();
    await flushOperations();
    expect(harness.scheduler.activeCount).toBe(1);
    await bluetooth.dispose();
    await expect(pendingWrite).rejects.toMatchObject({
      code: 'BLUETOOTH_BACKEND_STOPPED',
    });
    expect(harness.scheduler.activeCount).toBe(0);
    expect(harness.stop).toHaveBeenCalledOnce();
  });

  it('delegates advertisement, preconnection, and disconnection explicitly', async () => {
    const harness = createHarness();
    const bluetooth = createBluetoothLab(harness.runtime, harness.scheduler);
    const peripheral = await bluetooth.createPreconnectedPeripheral(
      peripheralDefinition(),
    );

    expect(harness.addPeripheral).toHaveBeenCalledOnce();
    expect(harness.createPreconnectedPeripheral).toHaveBeenCalledOnce();
    await peripheral.advertise();
    await peripheral.disconnect();
    expect(harness.simulateAdvertisement).toHaveBeenCalledOnce();
    expect(harness.disconnect).toHaveBeenCalledWith(peripheral.address, {});
  });
});

function deferredOperation<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function invalidationRecord(cause: unknown): CdpLabInvalidation {
  return {
    reason: 'adapter-lost',
    lifecycleState: 'invalidated',
    operation: 'setCentralState',
    operationLayer: 'cdp',
    detectedBy: 'command-rejection',
    boundary: 'unobserved',
    remediation: 'new-test-fixture',
    cause,
  };
}

describe('public handle lifecycle', () => {
  it.each([
    ['read', 'expectRead'],
    ['subscribe-to-notifications', 'expectSubscription'],
    ['unsubscribe-from-notifications', 'expectUnsubscription'],
  ] as const)(
    'fences sticky %s success before resolving %s',
    async (type, operation) => {
      const harness = createHarness();
      const bluetooth = createBluetoothLab(harness.runtime, harness.scheduler);
      const peripheral = await bluetooth.createPeripheral(
        peripheralDefinition(),
      );
      const characteristic = peripheral.characteristic('180f', '2a19');
      harness.emit(characteristicEvent('prior-success', type));
      await flushOperations();
      const fence = deferredOperation<undefined>();
      harness.checkLiveness.mockImplementationOnce(() => fence.promise);
      const waiting = characteristic[operation]();
      let resolved = false;
      void waiting.then(
        () => {
          resolved = true;
        },
        () => undefined,
      );
      await flushOperations();
      expect(harness.checkLiveness).toHaveBeenLastCalledWith(
        operation,
        'playwright',
      );
      expect(resolved).toBe(false);
      expect(harness.scheduler.activeCount).toBe(0);
      const primary = new Error('entry liveness failed');
      const rejection = expect(waiting).rejects.toBe(primary);
      fence.reject(primary);
      await rejection;
      expect(resolved).toBe(false);
      expect(characteristic.operations()).toHaveLength(1);
    },
  );

  it('retains the first copied characteristic write when two arrive during the entry fence', async () => {
    const harness = createHarness();
    const bluetooth = createBluetoothLab(harness.runtime, harness.scheduler);
    const peripheral = await bluetooth.createPeripheral(peripheralDefinition());
    const characteristic = peripheral.characteristic('180f', '2a19');
    const fence = deferredOperation<undefined>();
    harness.checkLiveness.mockImplementationOnce(() => fence.promise);
    const waiting = characteristic.waitForWrite();
    let settled = false;
    void waiting.then(
      () => {
        settled = true;
      },
      () => undefined,
    );
    const data = new Uint8Array([31, 32]);
    harness.emit({
      kind: 'characteristic-operation',
      operationId: 'write-during-entry',
      type: 'write',
      characteristic: {
        kind: 'characteristic',
        address: peripheral.address,
        serviceUuid: characteristic.serviceUuid,
        characteristicUuid: characteristic.uuid,
      },
      writeType: 'with-response',
      data,
    });
    data[0] = 99;
    harness.emit({
      kind: 'characteristic-operation',
      operationId: 'second-write-during-entry',
      type: 'write',
      characteristic: {
        kind: 'characteristic',
        address: peripheral.address,
        serviceUuid: characteristic.serviceUuid,
        characteristicUuid: characteristic.uuid,
      },
      writeType: 'with-response',
      data: new Uint8Array([41, 42]),
    });
    await flushOperations();
    expect(harness.respondToCharacteristicOperation).toHaveBeenCalledTimes(2);
    expect(settled).toBe(false);
    expect(harness.scheduler.activeCount).toBe(0);
    fence.resolve(undefined);
    await expect(waiting).resolves.toEqual({
      data: new Uint8Array([31, 32]),
      writeType: 'with-response',
    });
    expect(harness.scheduler.activeCount).toBe(0);
  });

  it('retains the first descriptor write when two arrive during the entry fence', async () => {
    const harness = createHarness();
    const bluetooth = createBluetoothLab(harness.runtime, harness.scheduler);
    const peripheral = await bluetooth.createPeripheral(peripheralDefinition());
    const characteristic = peripheral.characteristic('180f', '2a19');
    const descriptor = characteristic.descriptor('2901');
    const fence = deferredOperation<undefined>();
    harness.checkLiveness.mockImplementationOnce(() => fence.promise);
    const waiting = descriptor.waitForWrite();
    harness.emit({
      kind: 'descriptor-operation',
      operationId: 'descriptor-entry',
      type: 'write',
      descriptor: {
        kind: 'descriptor',
        address: peripheral.address,
        serviceUuid: characteristic.serviceUuid,
        characteristicUuid: characteristic.uuid,
        descriptorUuid: descriptor.uuid,
      },
      data: new Uint8Array([42]),
    });
    harness.emit({
      kind: 'descriptor-operation',
      operationId: 'second-descriptor-entry',
      type: 'write',
      descriptor: {
        kind: 'descriptor',
        address: peripheral.address,
        serviceUuid: characteristic.serviceUuid,
        characteristicUuid: characteristic.uuid,
        descriptorUuid: descriptor.uuid,
      },
      data: new Uint8Array([43]),
    });
    await flushOperations();
    expect(harness.scheduler.activeCount).toBe(0);
    fence.resolve(undefined);
    await expect(waiting).resolves.toEqual({ data: new Uint8Array([42]) });
    expect(harness.respondToDescriptorOperation).toHaveBeenCalledTimes(2);
  });

  it('starts the full application budget only after a delayed entry fence', async () => {
    const harness = createHarness();
    const bluetooth = createBluetoothLab(harness.runtime, harness.scheduler);
    const peripheral = await bluetooth.createPeripheral(peripheralDefinition());
    const characteristic = peripheral.characteristic('180f', '2a19');
    const fence = deferredOperation<undefined>();
    harness.checkLiveness.mockImplementationOnce(() => fence.promise);
    const waiting = characteristic.expectRead();
    let settled = false;
    void waiting.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await flushOperations();
    expect(harness.scheduler.activeBudgets).toEqual([]);
    harness.scheduler.expireAll();
    await flushOperations();
    expect(settled).toBe(false);
    fence.resolve(undefined);
    await flushOperations();
    expect(harness.scheduler.activeBudgets).toEqual([25]);
    const rejection = expect(waiting).rejects.toMatchObject({
      code: 'BLUETOOTH_TIMEOUT',
      context: {
        operation: 'expectRead',
        operationLayer: 'playwright',
        deadlineKind: 'application-operation',
        deadlineMs: 25,
        checkDeadlineMs: 30000,
        timeoutPhase: 'operation',
        detection: 'live',
        centralStateBlocked: false,
        remediation: 'inspect-operation',
      },
    });
    harness.scheduler.expireAll();
    await rejection;
    expect(harness.scheduler.activeCount).toBe(0);
  });

  it('rejects each pending waiter immediately with its own literal name and keeps the first reason after disposal', async () => {
    const harness = createHarness();
    const bluetooth = createBluetoothLab(harness.runtime, harness.scheduler);
    const peripheral = await bluetooth.createPeripheral(peripheralDefinition());
    const characteristic = peripheral.characteristic('180f', '2a19');
    const descriptor = characteristic.descriptor('2901');
    const waits = [
      ['expectRead', characteristic.expectRead()],
      ['expectSubscription', characteristic.expectSubscription()],
      ['expectUnsubscription', characteristic.expectUnsubscription()],
      ['waitForWrite', characteristic.waitForWrite()],
      ['waitForWrite', descriptor.waitForWrite()],
    ] as const;
    const cause = new Error('original owned adapter rejection');
    const checks = waits.map(([operation, promise]) =>
      expect(promise).rejects.toMatchObject({
        code: 'BLUETOOTH_BACKEND_STOPPED',
        cause,
        context: {
          reason: 'adapter-lost',
          lifecycleState: 'invalidated',
          operation,
          operationLayer: 'playwright',
          detectedBy: 'command-rejection',
          boundary: 'unobserved',
          remediation: 'new-test-fixture',
        },
      }),
    );
    await flushOperations();
    expect(harness.scheduler.activeCount).toBe(5);
    const record = invalidationRecord(cause);
    harness.invalidate(record);
    // A mutable notification cannot rewrite the retained reason.
    Object.assign(record, { reason: 'fixture-page-closed' });
    harness.invalidate(invalidationRecord(new Error('second failure')));
    await Promise.all(checks);
    expect(harness.scheduler.activeCount).toBe(0);
    await bluetooth.dispose();
    for (const [operation, invoke] of [
      ['queue', () => characteristic.reads.queue(new Uint8Array([5]))],
      ['queueSuccess', () => peripheral.connection.queueSuccess()],
      ['queueError', () => descriptor.writes.queueError('unlikely-error')],
      ['characteristic', () => peripheral.characteristic('180f', '2a19')],
      ['descriptor', () => characteristic.descriptor('2901')],
      ['expectRead', () => characteristic.expectRead()],
    ] as const) {
      expect(invoke).toThrowError(
        expect.objectContaining({
          cause,
          context: {
            reason: 'adapter-lost',
            lifecycleState: 'invalidated',
            operation,
            operationLayer: 'playwright',
            detectedBy: 'command-rejection',
            boundary: 'unobserved',
            remediation: 'new-test-fixture',
          },
        }),
      );
    }
    expect(peripheral.address).toBe(
      normalizeBluetoothAddress('09:09:09:09:09:09'),
    );
    expect(characteristic.uuid).toBe(normalizeBluetoothUuid('2a19'));
    expect(descriptor.uuid).toBe(normalizeBluetoothUuid('2901'));
    expect(characteristic.operations()).toEqual([]);
    harness.emit(characteristicEvent('late-event', 'read'));
    await flushOperations();
    expect(harness.respondToCharacteristicOperation).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'does not publish a late %s registration after terminal invalidation',
    async (preconnected) => {
      const harness = createHarness();
      const bluetooth = createBluetoothLab(harness.runtime, harness.scheduler);
      const registration = deferredOperation<undefined>();
      harness.addPeripheral.mockImplementationOnce(() => registration.promise);
      const waiting = preconnected
        ? bluetooth.createPreconnectedPeripheral(peripheralDefinition())
        : bluetooth.createPeripheral(peripheralDefinition());
      const cause = new Error('model outcome unknown');
      const record: CdpLabInvalidation = {
        ...invalidationRecord(cause),
        reason: 'model-outcome-unknown',
        detectedBy: 'model-operation-aborted',
      };
      const rejection = expect(waiting).rejects.toMatchObject({
        cause,
        context: {
          reason: 'model-outcome-unknown',
          operation: preconnected
            ? 'createPreconnectedPeripheral'
            : 'createPeripheral',
          operationLayer: 'playwright',
        },
      });
      harness.invalidate(record);
      registration.resolve(undefined);
      await rejection;
      expect(harness.capturePeripheralDiagnostics).not.toHaveBeenCalled();
      await expect(
        bluetooth.createPeripheral(peripheralDefinition()),
      ).rejects.toMatchObject({
        code: 'BLUETOOTH_BACKEND_STOPPED',
        context: {
          reason: 'model-outcome-unknown',
          operation: 'createPeripheral',
        },
      });
      expect(harness.addPeripheral).toHaveBeenCalledOnce();
      harness.emit(characteristicEvent('aborted-model', 'read'));
      await flushOperations();
      expect(harness.respondToCharacteristicOperation).not.toHaveBeenCalled();
    },
  );

  it('keeps cancellation primary when a model budget closes before handle publication', async () => {
    const harness = createHarness();
    const bluetooth = createBluetoothLab(harness.runtime, harness.scheduler);
    const cancel = new BluetoothCancelledError('explicit model cancellation');
    harness.withCommandBudget.mockImplementationOnce(
      async (_operation, _layer, work) =>
        work({}, () => {
          harness.invalidate({
            ...invalidationRecord(cancel),
            reason: 'model-outcome-unknown',
            detectedBy: 'model-operation-aborted',
          });
          throw cancel;
        }),
    );
    await expect(
      bluetooth.createPeripheral(peripheralDefinition()),
    ).rejects.toBe(cancel);
    expect(harness.capturePeripheralDiagnostics).not.toHaveBeenCalled();
    expect(harness.addPeripheral).toHaveBeenCalledOnce();
    await expect(
      bluetooth.createPeripheral(peripheralDefinition()),
    ).rejects.toMatchObject({
      context: {
        reason: 'model-outcome-unknown',
        operation: 'createPeripheral',
      },
    });
  });

  it('includes response queue wait in one command budget and never records late success', async () => {
    const harness = createHarness();
    const bluetooth = createBluetoothLab(harness.runtime, harness.scheduler);
    const peripheral = await bluetooth.createPeripheral(peripheralDefinition());
    const characteristic = peripheral.characteristic('180f', '2a19');
    const firstSend = deferredOperation<undefined>();
    harness.respondToCharacteristicOperation.mockImplementationOnce(
      () => firstSend.promise,
    );
    characteristic.reads.queue(new Uint8Array([71]));
    characteristic.reads.queue(new Uint8Array([72]));
    const commandScheduler = new ManualScheduler();
    harness.withCommandBudget.mockImplementation(
      async (operation, _layer, work) => {
        let expired = false;
        const deadline = deferredOperation<never>();
        const error = new BluetoothTimeoutError('command budget expired', {
          context: { operation, deadlineMs: 30, deadlineKind: 'command' },
        });
        const timer = commandScheduler.schedule(30, () => {
          expired = true;
          deadline.reject(error);
        });
        const working = work({}, () => {
          if (expired) throw error;
        });
        try {
          return await Promise.race([working, deadline.promise]);
        } finally {
          timer.cancel();
        }
      },
    );
    harness.emit(characteristicEvent('held-response', 'read'));
    harness.emit(characteristicEvent('queued-response', 'read'));
    await flushOperations();
    expect(commandScheduler.activeBudgets).toEqual([30, 30]);
    expect(harness.respondToCharacteristicOperation).toHaveBeenCalledOnce();
    commandScheduler.expireAll();
    await flushOperations();
    expect(characteristic.operations()).toHaveLength(2);
    expect(
      characteristic
        .operations()
        .every((record) => record.responseDelivery === 'failed'),
    ).toBe(true);
    firstSend.resolve(undefined);
    await flushOperations();
    expect(harness.respondToCharacteristicOperation).toHaveBeenCalledOnce();
    expect(characteristic.operations()).toMatchObject([
      {
        responseSource: 'queued',
        responseDelivery: 'failed',
        response: { data: new Uint8Array([71]) },
      },
      {
        responseSource: 'queued',
        responseDelivery: 'failed',
        response: { data: new Uint8Array([72]) },
      },
    ]);
    const waiting = characteristic.expectRead();
    await flushOperations();
    const rejection = expect(waiting).rejects.toMatchObject({
      code: 'BLUETOOTH_TIMEOUT',
    });
    harness.scheduler.expireAll();
    await rejection;
    expect(characteristic.operations()).toHaveLength(2);
  });
});

describe('assertion/command separation', () => {
  it('short assertion budget does not truncate model commands', async () => {
    const harness = createHarness({ operationTimeoutMs: 1 });
    const bluetooth = createBluetoothLab(harness.runtime, harness.scheduler);
    const registration = deferredOperation<undefined>();
    harness.addPeripheral.mockImplementationOnce(() => registration.promise);
    const creating = bluetooth.createPeripheral(peripheralDefinition());
    let published = false;
    void creating.then(
      () => {
        published = true;
      },
      () => undefined,
    );
    await flushOperations();
    harness.scheduler.advance(2);
    await flushOperations();
    expect(published).toBe(false);
    expect(harness.scheduler.activeCount).toBe(0);
    registration.resolve(undefined);
    const peripheral = await creating;

    const preconnection = deferredOperation<undefined>();
    harness.createPreconnectedPeripheral.mockImplementationOnce(
      () => preconnection.promise,
    );
    const preconnecting = bluetooth.createPreconnectedPeripheral({
      ...peripheralDefinition(),
      address: '10:10:10:10:10:10',
    });
    await flushOperations();
    harness.scheduler.advance(2);
    expect(harness.scheduler.activeCount).toBe(0);
    preconnection.resolve(undefined);
    await expect(preconnecting).resolves.toMatchObject({
      address: normalizeBluetoothAddress('10:10:10:10:10:10'),
    });

    const disconnect = deferredOperation<undefined>();
    harness.disconnect.mockImplementationOnce(() => disconnect.promise);
    const disconnecting = peripheral.disconnect();
    harness.scheduler.advance(2);
    expect(harness.scheduler.activeCount).toBe(0);
    disconnect.resolve(undefined);
    await expect(disconnecting).resolves.toBeUndefined();

    const waiting = peripheral.characteristic('180f', '2a19').expectRead();
    await flushOperations();
    expect(harness.scheduler.activeBudgets).toEqual([1]);
    const rejection = expect(waiting).rejects.toMatchObject({
      code: 'BLUETOOTH_TIMEOUT',
      context: {
        operation: 'expectRead',
        deadlineMs: 1,
        deadlineKind: 'application-operation',
        checkDeadlineMs: 30000,
      },
    });
    harness.scheduler.advance(1);
    await rejection;
  });
});

describe('interrupted handle work', () => {
  it('before-effects cancellation permits retry without publishing the canceled registration', async () => {
    const harness = createHarness();
    const bluetooth = createBluetoothLab(harness.runtime, harness.scheduler);
    const primary = new BluetoothCancelledError('cancelled before command');
    harness.withCommandBudget.mockRejectedValueOnce(primary);
    await expect(
      bluetooth.createPeripheral(peripheralDefinition()),
    ).rejects.toBe(primary);
    expect(harness.addPeripheral).not.toHaveBeenCalled();
    expect(harness.capturePeripheralDiagnostics).not.toHaveBeenCalled();
    await expect(
      bluetooth.createPeripheral(peripheralDefinition()),
    ).resolves.toMatchObject({
      address: normalizeBluetoothAddress('09:09:09:09:09:09'),
    });
    expect(harness.addPeripheral).toHaveBeenCalledOnce();
    expect(harness.capturePeripheralDiagnostics).toHaveBeenCalledOnce();
  });

  it('ordinary disposal closes publication before a late registration reply', async () => {
    const harness = createHarness();
    const bluetooth = createBluetoothLab(harness.runtime, harness.scheduler);
    const held = deferredOperation<undefined>();
    harness.addPeripheral.mockImplementationOnce(() => held.promise);
    const creating = bluetooth.createPeripheral(peripheralDefinition());
    const rejection = expect(creating).rejects.toMatchObject({
      code: 'BLUETOOTH_BACKEND_STOPPED',
      context: { lifecycleState: 'disposed' },
    });
    await bluetooth.dispose();
    held.resolve(undefined);
    await rejection;
    expect(harness.capturePeripheralDiagnostics).not.toHaveBeenCalled();
  });

  it('terminal invalidation settles a waiter once while its timeout diagnostic is pending', async () => {
    const harness = createHarness();
    const bluetooth = createBluetoothLab(harness.runtime, harness.scheduler);
    const peripheral = await bluetooth.createPeripheral(peripheralDefinition());
    const characteristic = peripheral.characteristic('180f', '2a19');
    const diagnostic = deferredOperation<never>();
    const diagnose = vi
      .spyOn(harness.backend, 'diagnoseTimeout')
      .mockImplementationOnce(() => diagnostic.promise);
    const waiting = characteristic.expectRead();
    const settled = vi.fn();
    void waiting.then(settled, settled);
    await flushOperations();
    harness.scheduler.expireAll();
    await flushOperations();
    expect(diagnose).toHaveBeenCalledOnce();
    expect(settled).not.toHaveBeenCalled();
    const cause = new Error('adapter lost during diagnostic');
    const rejection = expect(waiting).rejects.toMatchObject({
      cause,
      context: {
        reason: 'adapter-lost',
        operation: 'expectRead',
        operationLayer: 'playwright',
      },
    });
    harness.invalidate(invalidationRecord(cause));
    await rejection;
    diagnostic.reject(new BluetoothTimeoutError('late diagnostic'));
    await flushOperations();
    expect(settled).toHaveBeenCalledOnce();
    expect(harness.scheduler.activeCount).toBe(0);
  });

  it('retains successful history while terminal invalidation rejects sticky success', async () => {
    const harness = createHarness();
    const bluetooth = createBluetoothLab(harness.runtime, harness.scheduler);
    const peripheral = await bluetooth.createPeripheral(peripheralDefinition());
    const characteristic = peripheral.characteristic('180f', '2a19');
    characteristic.reads.queue(new Uint8Array([87]));
    harness.emit(characteristicEvent('before-loss', 'read'));
    await flushOperations();
    await characteristic.expectRead();
    const before = characteristic.operations();
    harness.invalidate(invalidationRecord(new Error('adapter lost')));
    expect(() => characteristic.expectRead()).toThrowError(
      expect.objectContaining({
        context: expect.objectContaining({
          reason: 'adapter-lost',
          operation: 'expectRead',
        }),
      }),
    );
    await bluetooth.dispose();
    expect(characteristic.operations()).toEqual(before);
    expect(before).toMatchObject([
      {
        responseDelivery: 'succeeded',
        responseSource: 'queued',
        response: { data: new Uint8Array([87]) },
      },
    ]);
    const response = before[0]?.response;
    if (response?.type !== 'read' || response.result !== 'success')
      throw new Error('Expected read history');
    response.data[0] = 99;
    expect(characteristic.operations()).toMatchObject([
      { response: { data: new Uint8Array([87]) } },
    ]);
  });
});
