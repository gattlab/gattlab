import {
  BluetoothValidationError,
  type BackendCallOptions,
  centralStates,
  normalizeBluetoothAddress,
  type BluetoothAddress,
  type CentralState,
  type PeripheralDefinition,
} from '@gattlab/core';

import {
  BluetoothHandleController,
  type BluetoothHandleBackend,
  type BluetoothHandleRuntime,
  type HandleDeadlineScheduler,
  type PeripheralHandle,
} from './handles.js';
import { createPlaywrightDeadlineScheduler } from './time.js';

export interface BluetoothAdapter {
  /** Validate and set adapter state through lazy startup; invalid state rejects with BluetoothValidationError. The independent command deadline bounds the state command. */
  setState(state: CentralState): Promise<void>;
}

export interface DevicePromptCandidate {
  readonly id: string;
  readonly name: string;
}

export interface DevicePrompt {
  readonly devices: readonly DevicePromptCandidate[];
  readonly settled: boolean;
  /** Select the one candidate matching a normalized peripheral address; missing candidates reject with PromptDeviceNotFoundError. Names are ignored. */
  select(peripheral: { readonly address: BluetoothAddress }): Promise<void>;
  /** Select one current candidate id explicitly; malformed ids reject with BluetoothValidationError, absent ids with PromptDeviceNotFoundError. */
  selectById(deviceId: string): Promise<void>;
  /** Cancel this open chooser; stale/concurrent actions or transport failures reject. Prompt arrival and settlement use separate wait and command deadlines. */
  cancel(): Promise<void>;
}

const fixtureConstructionToken = Symbol('gattlab-fixture-construction');

/**
 * Fixture-owned public control surface for one simulated Bluetooth adapter.
 *
 * Consumers receive this value from the `bluetooth` fixture. Construction,
 * manual attachment, and explicit startup are intentionally not public.
 */
export abstract class BluetoothLab {
  protected constructor(constructionToken: symbol) {
    if (constructionToken !== fixtureConstructionToken) {
      throw new BluetoothValidationError(
        'BluetoothLab is created by the Playwright bluetooth fixture and cannot be constructed manually.',
        { context: { reason: 'fixture-owned-construction' } },
      );
    }
  }

  abstract readonly adapter: BluetoothAdapter;
  /** Validate and register one peripheral hierarchy through the lazy runtime. */
  abstract createPeripheral(
    definition: PeripheralDefinition,
  ): Promise<PeripheralHandle>;
  /** Register one peripheral hierarchy with explicit preconnection intent. */
  abstract createPreconnectedPeripheral(
    definition: PeripheralDefinition,
  ): Promise<PeripheralHandle>;
  /** Arm and wait for the next real Chromium device chooser prompt. */
  abstract waitForDevicePrompt(): Promise<DevicePrompt>;
  /** Idempotently stop this fixture-owned lab and cancel pending handle waits. */
  abstract dispose(): Promise<void>;
}

interface BackendDevicePrompt {
  readonly devices: readonly DevicePromptCandidate[];
  readonly settled: boolean;
  select(
    address: BluetoothAddress,
    options?: BackendCallOptions,
  ): Promise<void>;
  selectById(deviceId: string, options?: BackendCallOptions): Promise<void>;
  cancel(options?: BackendCallOptions): Promise<void>;
}

interface BluetoothLabBackend extends BluetoothHandleBackend {
  setCentralState(
    state: CentralState,
    options?: BackendCallOptions,
  ): Promise<void>;
  waitForDevicePrompt(options?: {
    operationLayer: 'playwright';
  }): Promise<BackendDevicePrompt>;
}

/** @internal */
export interface GattLabRuntime extends BluetoothHandleRuntime {
  withBackend<T>(
    operation: (backend: BluetoothLabBackend) => Promise<T>,
    operationName?: string,
  ): Promise<T>;
  stop(): Promise<void>;
}

class FixtureBluetoothAdapter implements BluetoothAdapter {
  readonly #runtime: GattLabRuntime;

  constructor(runtime: GattLabRuntime) {
    this.#runtime = runtime;
    Object.freeze(this);
  }

  async setState(state: CentralState): Promise<void> {
    assertCentralState(state);
    await this.#runtime.withBackend(
      (backend) =>
        backend.withCommandBudget('setState', 'playwright', (options) =>
          backend.setCentralState(state, options),
        ),
      'setState',
    );
  }
}

class FixtureDevicePrompt implements DevicePrompt {
  readonly #prompt: BackendDevicePrompt;
  readonly #runtime: GattLabRuntime;

  constructor(prompt: BackendDevicePrompt, runtime: GattLabRuntime) {
    this.#prompt = prompt;
    this.#runtime = runtime;
    Object.freeze(this);
  }

  get devices(): readonly DevicePromptCandidate[] {
    return Object.freeze(
      this.#prompt.devices.map((device) =>
        Object.freeze({ id: device.id, name: device.name }),
      ),
    );
  }

  get settled(): boolean {
    return this.#prompt.settled;
  }

  async select(peripheral: {
    readonly address: BluetoothAddress;
  }): Promise<void> {
    const address = selectionAddress(peripheral);
    await this.#runtime.withBackend(
      (backend) =>
        backend.withCommandBudget('select', 'playwright', (options) =>
          this.#prompt.select(address, options),
        ),
      'select',
    );
  }

  async selectById(deviceId: string): Promise<void> {
    await this.#runtime.withBackend(
      (backend) =>
        backend.withCommandBudget('selectById', 'playwright', (options) =>
          this.#prompt.selectById(deviceId, options),
        ),
      'selectById',
    );
  }

  async cancel(): Promise<void> {
    await this.#runtime.withBackend(
      (backend) =>
        backend.withCommandBudget('cancel', 'playwright', (options) =>
          this.#prompt.cancel(options),
        ),
      'cancel',
    );
  }
}

class FixtureBluetoothLab extends BluetoothLab {
  readonly adapter: BluetoothAdapter;
  readonly #runtime: GattLabRuntime;
  readonly #handles: BluetoothHandleController;
  #disposePromise: Promise<void> | undefined;

  constructor(runtime: GattLabRuntime, scheduler: HandleDeadlineScheduler) {
    super(fixtureConstructionToken);
    this.#runtime = runtime;
    this.#handles = new BluetoothHandleController(runtime, scheduler);
    this.adapter = new FixtureBluetoothAdapter(runtime);
  }

  createPeripheral(
    definition: PeripheralDefinition,
  ): Promise<PeripheralHandle> {
    return this.#handles.createPeripheral(definition);
  }

  createPreconnectedPeripheral(
    definition: PeripheralDefinition,
  ): Promise<PeripheralHandle> {
    return this.#handles.createPreconnectedPeripheral(definition);
  }

  waitForDevicePrompt(): Promise<DevicePrompt> {
    return this.#runtime.withBackend(async (backend) => {
      const prompt = await backend.waitForDevicePrompt({
        operationLayer: 'playwright',
      });
      return new FixtureDevicePrompt(prompt, this.#runtime);
    }, 'waitForDevicePrompt');
  }

  dispose(): Promise<void> {
    if (this.#disposePromise === undefined) {
      this.#handles.dispose();
      this.#disposePromise = this.#runtime.stop();
    }
    return this.#disposePromise;
  }
}

/** @internal */
export function createBluetoothLab(
  runtime: GattLabRuntime,
  scheduler: HandleDeadlineScheduler = createPlaywrightDeadlineScheduler(),
): BluetoothLab {
  return new FixtureBluetoothLab(runtime, scheduler);
}

function assertCentralState(state: unknown): asserts state is CentralState {
  if (centralStates.includes(state as CentralState)) return;
  throw new BluetoothValidationError(
    'Bluetooth adapter state must be absent, powered-off, or powered-on.',
    {
      context: {
        expected: centralStates,
        received: describeValue(state),
      },
    },
  );
}

function selectionAddress(peripheral: unknown): BluetoothAddress {
  if (typeof peripheral !== 'object' || peripheral === null) {
    throw invalidSelectionTarget(peripheral);
  }
  const address = (peripheral as { readonly address?: unknown }).address;
  if (typeof address !== 'string') throw invalidSelectionTarget(peripheral);

  try {
    return normalizeBluetoothAddress(address);
  } catch (cause) {
    throw new BluetoothValidationError(
      'Device prompt selection requires a peripheral with a valid Bluetooth address.',
      {
        cause,
        context: {
          reason: 'invalid-peripheral-address',
          selectionMode: 'address',
        },
      },
    );
  }
}

function invalidSelectionTarget(peripheral: unknown): BluetoothValidationError {
  return new BluetoothValidationError(
    'Device prompt selection requires an address-bearing peripheral handle.',
    {
      context: {
        reason: 'invalid-peripheral-selection-target',
        received: describeValue(peripheral),
        selectionMode: 'address',
      },
    },
  );
}

function describeValue(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}
