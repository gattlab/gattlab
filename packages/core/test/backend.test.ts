import { describe, expect, expectTypeOf, it, vi } from 'vitest';

import {
  BackendLifecycleController,
  centralStates,
  createCancellationController,
  PeripheralAddressRegistry,
  runBestEffortBackendCleanup,
  snapshotBluetoothCapabilities,
  type BackendBluetoothEvent,
  type BackendStartOptions,
  type BluetoothAutomationBackend,
  type BluetoothAutomationBackendFactory,
  type BluetoothCapabilities,
  type CancellationSignal,
  type CharacteristicWriteType,
  type CharacteristicOperationResponse,
  type CentralState,
  type DescriptorOperationResponse,
  type GattOperationResponse,
} from '../src/backend.js';
import {
  BluetoothBackendStoppedError,
  BluetoothCancelledError,
  BluetoothPeripheralAlreadyRegisteredError,
} from '../src/errors.js';
import {
  normalizeBluetoothAddress,
  normalizeBluetoothUuid,
} from '../src/primitives.js';

function createCapabilities(): BluetoothCapabilities {
  return {
    browserName: 'chromium',
    browserProduct: 'HeadlessChrome/151.0.7922.34',
    browserVersion: '151.0.7922.34',
    protocolVersion: '1.3',
    domains: {
      bluetoothEmulation: true,
      deviceAccess: true,
    },
    operations: {
      centralState: true,
      advertisement: true,
      preconnectedPeripheral: true,
      services: true,
      secondaryServices: false,
      characteristics: true,
      descriptors: true,
      connectionResponse: true,
      discoveryResponse: true,
      characteristicReadWrite: true,
      descriptorReadWrite: true,
      subscriptionResponse: true,
      gattDisconnect: true,
      nativeNotificationPayload: false,
    },
  };
}

describe('backend capability foundation', () => {
  it('defines exactly the supported central states', () => {
    expect(centralStates).toEqual(['absent', 'powered-off', 'powered-on']);
    expect(Object.isFrozen(centralStates)).toBe(true);
    expectTypeOf<
      (typeof centralStates)[number]
    >().toEqualTypeOf<CentralState>();
  });

  it('creates a detached deeply frozen capability snapshot', () => {
    const input = createCapabilities();
    const snapshot = snapshotBluetoothCapabilities(input);

    (input.domains as { bluetoothEmulation: boolean }).bluetoothEmulation =
      false;
    (input.operations as { advertisement: boolean }).advertisement = false;

    expect(snapshot.domains.bluetoothEmulation).toBe(true);
    expect(snapshot.operations.advertisement).toBe(true);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.domains)).toBe(true);
    expect(Object.isFrozen(snapshot.operations)).toBe(true);
  });

  it('keeps cancellation structural and unsubscribe explicit', () => {
    const listener = vi.fn();
    const unsubscribe = vi.fn();
    const signal: CancellationSignal = {
      cancelled: false,
      throwIfCancelled: vi.fn(),
      onCancelled(receivedListener) {
        expect(receivedListener).toBe(listener);
        return unsubscribe;
      },
    };
    const options: BackendStartOptions = {
      centralState: 'powered-on',
      cancellation: signal,
    };

    expect(options.cancellation?.onCancelled(listener)).toBe(unsubscribe);
    expectTypeOf(options.centralState).toEqualTypeOf<CentralState>();
  });

  it('cancels once and invokes late listeners synchronously', () => {
    const controller = createCancellationController();
    const firstListener = vi.fn();
    const removedListener = vi.fn();
    const unsubscribeFirst = controller.signal.onCancelled(firstListener);
    const unsubscribeRemoved = controller.signal.onCancelled(removedListener);
    unsubscribeRemoved();

    expect(controller.signal.cancelled).toBe(false);
    expect(() => controller.signal.throwIfCancelled()).not.toThrow();
    controller.cancel();
    controller.cancel();

    expect(controller.signal.cancelled).toBe(true);
    expect(firstListener).toHaveBeenCalledTimes(1);
    expect(removedListener).not.toHaveBeenCalled();
    expect(() => controller.signal.throwIfCancelled()).toThrow(
      BluetoothCancelledError,
    );

    const order: string[] = [];
    order.push('before');
    const unsubscribeLate = controller.signal.onCancelled(() => {
      order.push('listener');
    });
    order.push('after');
    expect(order).toEqual(['before', 'listener', 'after']);

    expect(() => unsubscribeFirst()).not.toThrow();
    expect(() => unsubscribeLate()).not.toThrow();
  });

  it('rejects invalid runtime cancellation listeners', () => {
    const { signal } = createCancellationController();
    expect(() => signal.onCancelled(null as never)).toThrow(TypeError);
  });

  it('keeps startup and backend mutations free of transport identifiers', () => {
    expectTypeOf<
      ReturnType<BluetoothAutomationBackendFactory['start']>
    >().toEqualTypeOf<Promise<BluetoothAutomationBackend>>();
    expectTypeOf<
      ReturnType<BluetoothAutomationBackend['addPeripheral']>
    >().toEqualTypeOf<Promise<void>>();
    expectTypeOf<
      ReturnType<BluetoothAutomationBackend['onEvent']>
    >().toEqualTypeOf<() => void>();
  });

  it('makes operation response payload combinations explicit', () => {
    expectTypeOf<CharacteristicWriteType>().toEqualTypeOf<
      'default-deprecated' | 'with-response' | 'without-response'
    >();
    expectTypeOf<{
      operationId: string;
      type: 'connection';
      result: 'error';
      error: 'connection-timeout';
    }>().toMatchTypeOf<GattOperationResponse>();
    expectTypeOf<{
      operationId: string;
      type: 'read';
      result: 'success';
      data: readonly number[];
    }>().toMatchTypeOf<CharacteristicOperationResponse>();
    expectTypeOf<{
      operationId: string;
      type: 'write';
      result: 'success';
    }>().toMatchTypeOf<DescriptorOperationResponse>();
    expectTypeOf<{
      operationId: string;
      type: 'read';
      result: 'success';
    }>().not.toMatchTypeOf<CharacteristicOperationResponse>();
    expectTypeOf<{
      operationId: string;
      type: 'write';
      result: 'success';
      data: readonly number[];
    }>().not.toMatchTypeOf<DescriptorOperationResponse>();
  });

  it('rejects duplicate addresses before backend mutation and rolls back failures', async () => {
    const registry = new PeripheralAddressRegistry();
    const firstAddress = normalizeBluetoothAddress('00:11:22:33:44:55');
    const secondAddress = normalizeBluetoothAddress('00:11:22:33:44:66');
    const firstMutation = vi.fn(async () => undefined);
    const duplicateMutation = vi.fn(async () => undefined);

    await registry.register(firstAddress, firstMutation);
    await expect(
      registry.register(firstAddress, duplicateMutation),
    ).rejects.toMatchObject({
      name: 'BluetoothPeripheralAlreadyRegisteredError',
      code: 'BLUETOOTH_PERIPHERAL_ALREADY_REGISTERED',
      context: { address: firstAddress },
    });
    expect(firstMutation).toHaveBeenCalledTimes(1);
    expect(duplicateMutation).not.toHaveBeenCalled();

    const mutationFailure = new Error('transport mutation failed');
    await expect(
      registry.register(secondAddress, async () => {
        throw mutationFailure;
      }),
    ).rejects.toBe(mutationFailure);
    await expect(
      registry.register(secondAddress, async () => undefined),
    ).resolves.toBeUndefined();
    expect(registry.size).toBe(2);

    registry.clear();
    expect(registry.size).toBe(0);
    expect(
      new BluetoothPeripheralAlreadyRegisteredError('duplicate'),
    ).toBeInstanceOf(BluetoothPeripheralAlreadyRegisteredError);
  });

  it('shares stop completion and blocks operations and events while stopping', async () => {
    const lifecycle = new BackendLifecycleController();
    const address = normalizeBluetoothAddress('00:11:22:33:44:55');
    const event: BackendBluetoothEvent = {
      kind: 'gatt-operation',
      operationId: 'operation-1',
      peripheral: { kind: 'peripheral', address },
      type: 'connection',
    };
    const listener = vi.fn();
    lifecycle.onEvent(listener);
    expect(lifecycle.emit(event)).toBe(true);
    expect(listener).toHaveBeenCalledOnce();

    let finishCleanup: (() => void) | undefined;
    const cleanup = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishCleanup = resolve;
        }),
    );
    const firstStop = lifecycle.stop(cleanup);
    const secondStop = lifecycle.stop(cleanup);

    expect(firstStop).toBe(secondStop);
    expect(lifecycle.state).toBe('stopping');
    expect(lifecycle.emit(event)).toBe(false);
    expect(listener).toHaveBeenCalledOnce();
    expect(() => lifecycle.assertStarted('add a peripheral')).toThrow(
      BluetoothBackendStoppedError,
    );
    expect(() => lifecycle.onEvent(vi.fn())).toThrow(
      BluetoothBackendStoppedError,
    );

    await Promise.resolve();
    expect(cleanup).toHaveBeenCalledOnce();
    if (finishCleanup === undefined) throw new Error('Cleanup did not start.');
    finishCleanup();
    await firstStop;

    expect(lifecycle.state).toBe('stopped');
    expect(lifecycle.stop(cleanup)).toBe(firstStop);
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('reaches stopped even when cleanup fails', async () => {
    const lifecycle = new BackendLifecycleController();
    const failure = new Error('cleanup failed');
    const completion = lifecycle.stop(async () => {
      throw failure;
    });

    await expect(completion).rejects.toBe(failure);
    expect(lifecycle.state).toBe('stopped');
    expect(lifecycle.stop(async () => undefined)).toBe(completion);
  });

  it('delivers an owned write payload copy to each event listener', () => {
    const lifecycle = new BackendLifecycleController();
    const address = normalizeBluetoothAddress('00:11:22:33:44:55');
    const sourceData = new Uint8Array([1, 2]);
    const event: BackendBluetoothEvent = {
      kind: 'characteristic-operation',
      operationId: 'operation-2',
      characteristic: {
        kind: 'characteristic',
        address,
        serviceUuid: normalizeBluetoothUuid('180f'),
        characteristicUuid: normalizeBluetoothUuid('2a19'),
      },
      type: 'write',
      writeType: 'with-response',
      data: sourceData,
    };
    const receivedData: Uint8Array[] = [];
    lifecycle.onEvent((received) => {
      if (received.kind !== 'characteristic-operation') return;
      if (received.type !== 'write') return;
      receivedData.push(received.data);
      received.data[0] = 99;
    });
    lifecycle.onEvent((received) => {
      if (received.kind !== 'characteristic-operation') return;
      if (received.type !== 'write') return;
      receivedData.push(received.data);
      expect([...received.data]).toEqual([1, 2]);
    });

    expect(lifecycle.emit(event)).toBe(true);
    sourceData[1] = 88;
    expect(receivedData).toHaveLength(2);
    expect(receivedData[0]).not.toBe(receivedData[1]);
    expect([...(receivedData[1] ?? [])]).toEqual([1, 2]);
  });

  it('attempts every cleanup step and reports failures in order', async () => {
    const calls: string[] = [];
    const firstFailure = new Error('device access disable failed');
    const secondFailure = new Error('session detach failed');
    const failures = await runBestEffortBackendCleanup([
      {
        name: 'device-access-disable',
        async run() {
          calls.push('device-access-disable');
          throw firstFailure;
        },
      },
      {
        name: 'bluetooth-emulation-disable',
        async run() {
          calls.push('bluetooth-emulation-disable');
        },
      },
      {
        name: 'session-detach',
        async run() {
          calls.push('session-detach');
          throw secondFailure;
        },
      },
    ]);

    expect(calls).toEqual([
      'device-access-disable',
      'bluetooth-emulation-disable',
      'session-detach',
    ]);
    expect(failures).toEqual([
      { name: 'device-access-disable', cause: firstFailure },
      { name: 'session-detach', cause: secondFailure },
    ]);
    expect(Object.isFrozen(failures)).toBe(true);
    expect(failures.every(Object.isFrozen)).toBe(true);
  });
});
