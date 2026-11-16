import {
  BluetoothValidationError,
  BluetoothBackendStoppedError,
  normalizeBluetoothAddress,
} from '@gattlab/core';
import type {
  CdpBluetoothBackend,
  CdpDevicePrompt,
  CdpLabInvalidation,
} from '@gattlab/cdp';
import { describe, expect, it, vi } from 'vitest';

import {
  BluetoothLab,
  createBluetoothLab,
  type GattLabRuntime,
} from '../src/bluetooth-lab.js';

interface FacadeHarness {
  readonly backend: CdpBluetoothBackend;
  invalidate(record: CdpLabInvalidation): void;
  readonly cancel: ReturnType<typeof vi.fn<() => Promise<void>>>;
  readonly prompt: CdpDevicePrompt;
  readonly runtime: GattLabRuntime;
  readonly select: ReturnType<
    typeof vi.fn<
      (address: ReturnType<typeof normalizeBluetoothAddress>) => Promise<void>
    >
  >;
  readonly selectById: ReturnType<
    typeof vi.fn<(deviceId: string) => Promise<void>>
  >;
  readonly setCentralState: ReturnType<typeof vi.fn>;
  readonly stop: ReturnType<typeof vi.fn<() => Promise<void>>>;
  readonly withBackend: ReturnType<typeof vi.fn<GattLabRuntime['withBackend']>>;
  readonly waitForDevicePrompt: ReturnType<
    typeof vi.fn<() => Promise<CdpDevicePrompt>>
  >;
  replaceDevices(
    devices: readonly { readonly id: string; readonly name: string }[],
  ): void;
  settlePrompt(): void;
}

function createHarness(): FacadeHarness {
  let terminal: CdpLabInvalidation | undefined;
  const listeners = new Set<(record: CdpLabInvalidation) => void>();
  const assertUsable = (operation: string): void => {
    if (terminal === undefined) return;
    const { cause, ...context } = terminal;
    throw new BluetoothBackendStoppedError('Lab invalidated.', {
      cause,
      context: { ...context, operation, operationLayer: 'playwright' },
    });
  };
  let devices: readonly { readonly id: string; readonly name: string }[] = [
    { id: '10:20:30:40:50:60', name: '' },
  ];
  let settled = false;
  const select = vi.fn(async () => undefined);
  const selectById = vi.fn(async () => undefined);
  const cancel = vi.fn(async () => undefined);
  const prompt = {
    get devices() {
      return devices;
    },
    get settled() {
      return settled;
    },
    select,
    selectById,
    cancel,
  } as unknown as CdpDevicePrompt;
  const setCentralState = vi.fn(async () => undefined);
  const waitForDevicePrompt = vi.fn(async () => prompt);
  const backend = {
    withCommandBudget: vi.fn<CdpBluetoothBackend['withCommandBudget']>(
      async (operation, layer, work) => {
        expect(layer).toBe('playwright');
        assertUsable(operation);
        return work({}, () => assertUsable(operation));
      },
    ),
    setCentralState,
    waitForDevicePrompt,
  } as unknown as CdpBluetoothBackend;
  const withBackendImplementation: GattLabRuntime['withBackend'] = (
    operation,
    operationName = 'onEvent',
  ) => {
    assertUsable(operationName);
    return operation(backend);
  };
  const withBackend = vi.fn(withBackendImplementation);
  const stop = vi.fn(async () => undefined);

  return {
    backend,
    invalidate(record) {
      if (terminal !== undefined) return;
      terminal = Object.freeze({ ...record });
      for (const listener of listeners) listener(terminal);
    },
    cancel,
    prompt,
    runtime: {
      options: { operationTimeoutMs: 5_000, operationHistoryLimit: 1_000 },
      withBackend: withBackend as GattLabRuntime['withBackend'],
      assertUsable,
      onInvalidated(listener) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      capturePeripheralDiagnostics: () => undefined,
      stop,
    },
    select,
    selectById,
    setCentralState,
    stop,
    withBackend,
    waitForDevicePrompt,
    replaceDevices(nextDevices) {
      devices = nextDevices;
    },
    settlePrompt() {
      settled = true;
    },
  };
}

describe('BluetoothLab public facade', () => {
  it('rejects direct JavaScript construction outside the fixture', () => {
    const RuntimeBluetoothLab =
      BluetoothLab as unknown as new () => BluetoothLab;

    expect(() => new RuntimeBluetoothLab()).toThrowError(
      expect.objectContaining({
        code: 'BLUETOOTH_VALIDATION_FAILED',
        context: { reason: 'fixture-owned-construction' },
      }),
    );
  });

  it('constructs the facade and adapter without starting the runtime', () => {
    const harness = createHarness();
    const bluetooth = createBluetoothLab(harness.runtime);

    expect(bluetooth.adapter).toBeDefined();
    expect(harness.withBackend).not.toHaveBeenCalled();
    expect(harness.stop).not.toHaveBeenCalled();
  });

  it('validates adapter state before lazy start and delegates valid state', async () => {
    const harness = createHarness();
    const bluetooth = createBluetoothLab(harness.runtime);

    await expect(
      bluetooth.adapter.setState('sleeping' as 'powered-on'),
    ).rejects.toBeInstanceOf(BluetoothValidationError);
    expect(harness.withBackend).not.toHaveBeenCalled();

    await bluetooth.adapter.setState('powered-off');

    expect(harness.withBackend).toHaveBeenCalledOnce();
    expect(harness.setCentralState).toHaveBeenCalledWith('powered-off', {});
    expect(harness.backend.withCommandBudget).toHaveBeenCalledWith(
      'setState',
      'playwright',
      expect.any(Function),
    );
  });

  it('wraps chooser state without exposing mutable backend snapshots', async () => {
    const harness = createHarness();
    const bluetooth = createBluetoothLab(harness.runtime);

    const waiting = bluetooth.waitForDevicePrompt();

    expect(harness.waitForDevicePrompt).toHaveBeenCalledOnce();
    const prompt = await waiting;
    const firstSnapshot = prompt.devices;

    expect(harness.withBackend).toHaveBeenCalledOnce();
    expect(Object.isFrozen(firstSnapshot)).toBe(true);
    expect(Object.isFrozen(firstSnapshot[0])).toBe(true);

    harness.replaceDevices([
      { id: '10:20:30:40:50:60', name: '' },
      { id: '10:20:30:40:50:61', name: 'new candidate' },
    ]);
    expect(firstSnapshot).toHaveLength(1);
    expect(prompt.devices).toHaveLength(2);
    expect(prompt.settled).toBe(false);
    harness.settlePrompt();
    expect(prompt.settled).toBe(true);
  });

  it('normalizes peripheral selection and delegates advanced prompt actions', async () => {
    const harness = createHarness();
    const bluetooth = createBluetoothLab(harness.runtime);
    const prompt = await bluetooth.waitForDevicePrompt();

    await prompt.select({
      address: '10:20:30:40:50:60' as ReturnType<
        typeof normalizeBluetoothAddress
      >,
    });
    await prompt.selectById('advanced-candidate-id');
    await prompt.cancel();

    expect(harness.select).toHaveBeenCalledWith(
      normalizeBluetoothAddress('10:20:30:40:50:60'),
      {},
    );
    expect(harness.selectById).toHaveBeenCalledWith(
      'advanced-candidate-id',
      {},
    );
    expect(harness.cancel).toHaveBeenCalledOnce();
    expect(harness.cancel).toHaveBeenCalledWith({});
    expect(harness.backend.withCommandBudget).toHaveBeenNthCalledWith(
      1,
      'select',
      'playwright',
      expect.any(Function),
    );
    expect(harness.backend.withCommandBudget).toHaveBeenNthCalledWith(
      2,
      'selectById',
      'playwright',
      expect.any(Function),
    );
    expect(harness.backend.withCommandBudget).toHaveBeenNthCalledWith(
      3,
      'cancel',
      'playwright',
      expect.any(Function),
    );
  });

  it('rejects malformed selection targets before delegating to the prompt', async () => {
    const harness = createHarness();
    const bluetooth = createBluetoothLab(harness.runtime);
    const prompt = await bluetooth.waitForDevicePrompt();

    await expect(
      prompt.select({ address: 'not-an-address' } as never),
    ).rejects.toMatchObject({
      code: 'BLUETOOTH_VALIDATION_FAILED',
      context: {
        reason: 'invalid-peripheral-address',
        selectionMode: 'address',
      },
    });
    expect(harness.select).not.toHaveBeenCalled();
  });

  it('shares one public disposal promise and delegates cleanup once', async () => {
    const harness = createHarness();
    const bluetooth = createBluetoothLab(harness.runtime);

    const firstDisposal = bluetooth.dispose();
    const secondDisposal = bluetooth.dispose();

    expect(secondDisposal).toBe(firstDisposal);
    await firstDisposal;
    expect(harness.stop).toHaveBeenCalledOnce();
  });
});

describe('facade terminal boundaries', () => {
  it('rejects old chooser actions and new facade work with their own names after cleanup', async () => {
    const harness = createHarness();
    const bluetooth = createBluetoothLab(harness.runtime);
    const prompt = await bluetooth.waitForDevicePrompt();
    const cause = new Error('first adapter failure');
    harness.invalidate({
      reason: 'adapter-lost',
      lifecycleState: 'invalidated',
      operation: 'setCentralState',
      operationLayer: 'cdp',
      detectedBy: 'command-rejection',
      boundary: 'fixture-document-changed',
      remediation: 'new-test-fixture',
      cause,
    });
    await bluetooth.dispose();
    for (const [operation, call] of [
      [
        'select',
        () =>
          prompt.select({
            address: normalizeBluetoothAddress('10:20:30:40:50:60'),
          }),
      ],
      ['selectById', () => prompt.selectById('advanced-candidate-id')],
      ['cancel', () => prompt.cancel()],
      ['setState', () => bluetooth.adapter.setState('powered-on')],
    ] as const) {
      await expect(call()).rejects.toMatchObject({
        cause,
        context: {
          reason: 'adapter-lost',
          lifecycleState: 'invalidated',
          operation,
          operationLayer: 'playwright',
          detectedBy: 'command-rejection',
          boundary: 'fixture-document-changed',
          remediation: 'new-test-fixture',
        },
      });
    }
    expect(() => bluetooth.waitForDevicePrompt()).toThrowError(
      expect.objectContaining({
        cause,
        context: expect.objectContaining({
          reason: 'adapter-lost',
          operation: 'waitForDevicePrompt',
          operationLayer: 'playwright',
        }),
      }),
    );
    await expect(
      bluetooth.createPeripheral({ address: '10:20:30:40:50:60', name: 'new' }),
    ).rejects.toMatchObject({
      cause,
      context: expect.objectContaining({
        reason: 'adapter-lost',
        operation: 'createPeripheral',
        operationLayer: 'playwright',
      }),
    });
    expect(harness.select).not.toHaveBeenCalled();
    expect(harness.selectById).not.toHaveBeenCalled();
    expect(harness.cancel).not.toHaveBeenCalled();
    expect(harness.setCentralState).not.toHaveBeenCalled();
    expect(prompt.devices).toEqual([{ id: '10:20:30:40:50:60', name: '' }]);
    expect(harness.stop).toHaveBeenCalledOnce();
  });
});
