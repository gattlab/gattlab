import type { NormalizedPeripheral } from './device-model.js';
import {
  BluetoothBackendStoppedError,
  BluetoothCancelledError,
  BluetoothPeripheralAlreadyRegisteredError,
  type AttErrorName,
  type HciErrorName,
} from './errors.js';
import type {
  BluetoothAddress,
  BluetoothUuid,
  ByteSource,
} from './primitives.js';

export const centralStates: readonly ['absent', 'powered-off', 'powered-on'] =
  Object.freeze(['absent', 'powered-off', 'powered-on'] as const);

export type CentralState = (typeof centralStates)[number];

export interface CancellationSignal {
  /** True after the controller's first cancellation request. */
  readonly cancelled: boolean;

  /**
   * Throw a stable cancellation error when cancellation has already occurred.
   */
  throwIfCancelled(): void;

  /**
   * Register a listener for the one-shot cancellation transition.
   *
   * Registration after cancellation invokes the listener synchronously.
   * The returned unsubscribe function is idempotent and becomes a no-op after
   * cancellation.
   */
  onCancelled(listener: () => void): () => void;
}

export interface CancellationController {
  readonly signal: CancellationSignal;

  /** Cancel once; later calls do not notify listeners again. */
  cancel(): void;
}

/** Creates a one-shot cancellation controller for backend operations. */
export function createCancellationController(): CancellationController {
  let cancelled = false;
  const listeners = new Set<() => void>();
  const signal: CancellationSignal = Object.freeze({
    get cancelled() {
      return cancelled;
    },
    throwIfCancelled() {
      if (cancelled) {
        throw new BluetoothCancelledError('Bluetooth operation was cancelled.');
      }
    },
    onCancelled(listener: () => void) {
      if (typeof listener !== 'function') {
        throw new TypeError('Cancellation listener must be a function.');
      }
      if (cancelled) {
        listener();
        return () => undefined;
      }

      let subscribed = true;
      listeners.add(listener);
      return () => {
        if (!subscribed) return;
        subscribed = false;
        listeners.delete(listener);
      };
    },
  });

  return Object.freeze({
    signal,
    cancel() {
      if (cancelled) return;
      cancelled = true;
      const pendingListeners = [...listeners];
      listeners.clear();
      for (const listener of pendingListeners) listener();
    },
  });
}

export interface BackendCallOptions {
  cancellation?: CancellationSignal;
}

export interface BackendStartOptions extends BackendCallOptions {
  centralState: CentralState;
}

export interface BluetoothCapabilityDomains {
  readonly bluetoothEmulation: boolean;
  readonly deviceAccess: boolean;
}

export interface BluetoothCapabilityOperations {
  readonly centralState: boolean;
  readonly advertisement: boolean;
  readonly preconnectedPeripheral: boolean;
  readonly services: boolean;
  readonly secondaryServices: boolean;
  readonly characteristics: boolean;
  readonly descriptors: boolean;
  readonly connectionResponse: boolean;
  readonly discoveryResponse: boolean;
  readonly characteristicReadWrite: boolean;
  readonly descriptorReadWrite: boolean;
  readonly subscriptionResponse: boolean;
  readonly gattDisconnect: boolean;
  readonly nativeNotificationPayload: boolean;
}

export interface BluetoothCapabilities {
  readonly browserName: 'chromium';
  readonly browserProduct: string;
  readonly browserVersion: string;
  readonly protocolVersion?: string;
  readonly domains: BluetoothCapabilityDomains;
  readonly operations: BluetoothCapabilityOperations;
}

/** Copies and freezes a capability result at the package boundary. */
export function snapshotBluetoothCapabilities(
  capabilities: BluetoothCapabilities,
): BluetoothCapabilities {
  const domains = Object.freeze({ ...capabilities.domains });
  const operations = Object.freeze({ ...capabilities.operations });
  return Object.freeze({
    browserName: capabilities.browserName,
    browserProduct: capabilities.browserProduct,
    browserVersion: capabilities.browserVersion,
    ...(capabilities.protocolVersion === undefined
      ? {}
      : { protocolVersion: capabilities.protocolVersion }),
    domains,
    operations,
  });
}

export interface PeripheralReference {
  readonly kind: 'peripheral';
  readonly address: BluetoothAddress;
}

export interface ServiceReference {
  readonly kind: 'service';
  readonly address: BluetoothAddress;
  readonly serviceUuid: BluetoothUuid;
}

export interface CharacteristicReference {
  readonly kind: 'characteristic';
  readonly address: BluetoothAddress;
  readonly serviceUuid: BluetoothUuid;
  readonly characteristicUuid: BluetoothUuid;
}

export interface DescriptorReference {
  readonly kind: 'descriptor';
  readonly address: BluetoothAddress;
  readonly serviceUuid: BluetoothUuid;
  readonly characteristicUuid: BluetoothUuid;
  readonly descriptorUuid: BluetoothUuid;
}

export type BluetoothEntityReference =
  | PeripheralReference
  | ServiceReference
  | CharacteristicReference
  | DescriptorReference;

export type GattOperationType = 'connection' | 'discovery';
export type CharacteristicOperationType =
  | 'read'
  | 'write'
  | 'subscribe-to-notifications'
  | 'unsubscribe-from-notifications';
export type DescriptorOperationType = 'read' | 'write';
export type CharacteristicWriteType =
  'default-deprecated' | 'with-response' | 'without-response';

interface BackendOperationEvent {
  /**
   * Synthetic correlation token unique among pending operations in one backend
   * instance. It is not a transport id and becomes invalid after settlement or
   * backend stop.
   */
  readonly operationId: string;
}

export interface GattOperationEvent extends BackendOperationEvent {
  readonly kind: 'gatt-operation';
  readonly peripheral: PeripheralReference;
  readonly type: GattOperationType;
}

export type CharacteristicOperationEvent =
  | Readonly<
      BackendOperationEvent & {
        kind: 'characteristic-operation';
        characteristic: CharacteristicReference;
        type:
          | 'read'
          | 'subscribe-to-notifications'
          | 'unsubscribe-from-notifications';
      }
    >
  | Readonly<
      BackendOperationEvent & {
        kind: 'characteristic-operation';
        characteristic: CharacteristicReference;
        type: 'write';
        writeType: CharacteristicWriteType;
        data: Uint8Array;
      }
    >;

export type DescriptorOperationEvent =
  | Readonly<
      BackendOperationEvent & {
        kind: 'descriptor-operation';
        descriptor: DescriptorReference;
        type: 'read';
      }
    >
  | Readonly<
      BackendOperationEvent & {
        kind: 'descriptor-operation';
        descriptor: DescriptorReference;
        type: 'write';
        data: Uint8Array;
      }
    >;

export type BackendBluetoothEvent =
  GattOperationEvent | CharacteristicOperationEvent | DescriptorOperationEvent;

/**
 * Copy one event for delivery to one listener. Write payloads are defensive
 * copies owned by that listener and may be retained or mutated safely.
 */
export function copyBackendBluetoothEvent(
  event: BackendBluetoothEvent,
): BackendBluetoothEvent {
  if (event.kind === 'gatt-operation') {
    return Object.freeze({
      ...event,
      peripheral: Object.freeze({ ...event.peripheral }),
    });
  }

  if (event.kind === 'characteristic-operation') {
    return event.type === 'write'
      ? Object.freeze({
          ...event,
          characteristic: Object.freeze({ ...event.characteristic }),
          data: new Uint8Array(event.data),
        })
      : Object.freeze({
          ...event,
          characteristic: Object.freeze({ ...event.characteristic }),
        });
  }

  return event.type === 'write'
    ? Object.freeze({
        ...event,
        descriptor: Object.freeze({ ...event.descriptor }),
        data: new Uint8Array(event.data),
      })
    : Object.freeze({
        ...event,
        descriptor: Object.freeze({ ...event.descriptor }),
      });
}

interface OperationResponse {
  /**
   * Match one currently pending event from the same backend instance. Unknown,
   * settled, or operation-kind-mismatched ids must fail before transport
   * mutation. CDP backends synthesize this id while serializing per operation
   * key because the protocol supplies no request correlation id.
   */
  readonly operationId: string;
}

export type GattOperationResponse =
  | Readonly<
      OperationResponse & {
        type: GattOperationType;
        result: 'success';
      }
    >
  | Readonly<
      OperationResponse & {
        type: GattOperationType;
        result: 'error';
        error: HciErrorName;
      }
    >;

export type CharacteristicOperationResponse =
  | Readonly<
      OperationResponse & {
        type: 'read';
        result: 'success';
        data: ByteSource;
      }
    >
  | Readonly<
      OperationResponse & {
        type:
          | 'write'
          | 'subscribe-to-notifications'
          | 'unsubscribe-from-notifications';
        result: 'success';
      }
    >
  | Readonly<
      OperationResponse & {
        type: CharacteristicOperationType;
        result: 'error';
        error: AttErrorName;
      }
    >;

export type DescriptorOperationResponse =
  | Readonly<
      OperationResponse & {
        type: 'read';
        result: 'success';
        data: ByteSource;
      }
    >
  | Readonly<
      OperationResponse & {
        type: 'write';
        result: 'success';
      }
    >
  | Readonly<
      OperationResponse & {
        type: DescriptorOperationType;
        result: 'error';
        error: AttErrorName;
      }
    >;

export interface BluetoothAutomationBackendFactory {
  /** Start with the requested state and optional cancellation; implementation-specific failures reject. This interface adds no deadline. */
  start(options: BackendStartOptions): Promise<BluetoothAutomationBackend>;
}

export interface BluetoothAutomationBackend {
  readonly capabilities: BluetoothCapabilities;

  /** Idempotently stop the backend. This operation is not cancellable. */
  stop(): Promise<void>;
  /** Set adapter state; optional cancellation and error/deadline policy belong to the concrete backend. */
  setCentralState(
    state: CentralState,
    options?: BackendCallOptions,
  ): Promise<void>;
  /** Register the domain model without returning transport identifiers. */
  addPeripheral(
    definition: NormalizedPeripheral,
    options?: BackendCallOptions,
  ): Promise<void>;
  /** Send scan data for a registered definition; registration and preconnection are separate operations. */
  simulateAdvertisement(
    peripheral: NormalizedPeripheral,
    options?: BackendCallOptions,
  ): Promise<void>;
  /** Make a registered definition explicitly system-known; this does not establish an application GATT connection. */
  createPreconnectedPeripheral(
    peripheral: NormalizedPeripheral,
    options?: BackendCallOptions,
  ): Promise<void>;
  /** Script disconnection by normalized address; backend-specific hierarchy recovery finishes before resolution. */
  disconnect(
    address: BluetoothAddress,
    options?: BackendCallOptions,
  ): Promise<void>;
  /** Settle one pending connection/discovery id with a matching HCI response; stale, cancelled or mismatched ids reject. */
  respondToGattOperation(
    response: GattOperationResponse,
    options?: BackendCallOptions,
  ): Promise<void>;
  /** Settle one pending characteristic id with a matching ATT response; read payloads are copied, invalid or stale responses reject. */
  respondToCharacteristicOperation(
    response: CharacteristicOperationResponse,
    options?: BackendCallOptions,
  ): Promise<void>;
  /** Settle one pending descriptor id with a matching ATT response; read payloads are copied, invalid or stale responses reject. */
  respondToDescriptorOperation(
    response: DescriptorOperationResponse,
    options?: BackendCallOptions,
  ): Promise<void>;
  /** Subscribe while started and return an idempotent unsubscribe; low-level consumers must supply operation responses. */
  onEvent(listener: (event: BackendBluetoothEvent) => void): () => void;
}

/** Serializes address registration and rolls it back when mutation fails. */
export class PeripheralAddressRegistry {
  readonly #addresses = new Set<BluetoothAddress>();

  /** Number of reserved addresses, including registrations awaiting mutation. */
  get size(): number {
    return this.#addresses.size;
  }

  /** Reserve before awaiting mutation; duplicates reject with BluetoothPeripheralAlreadyRegisteredError, failed mutation rolls back and preserves its cause. */
  async register(
    address: BluetoothAddress,
    mutation: () => Promise<void>,
  ): Promise<void> {
    if (this.#addresses.has(address)) {
      throw new BluetoothPeripheralAlreadyRegisteredError(
        `Bluetooth peripheral ${address} is already registered.`,
        { context: { address } },
      );
    }

    this.#addresses.add(address);
    try {
      await mutation();
    } catch (error) {
      this.#addresses.delete(address);
      throw error;
    }
  }

  /** Clear address reservations synchronously; does not remove transport entities. */
  clear(): void {
    this.#addresses.clear();
  }
}

export type BackendLifecycleState = 'started' | 'stopping' | 'stopped';

/** Enforces the backend's started-to-stopped lifecycle and event boundary. */
export class BackendLifecycleController {
  #state: BackendLifecycleState = 'started';
  #stopPromise: Promise<void> | undefined;
  readonly #listeners = new Set<(event: BackendBluetoothEvent) => void>();

  /** Current lifecycle state; cleanup failure still transitions to stopped. */
  get state(): BackendLifecycleState {
    return this.#state;
  }

  /** Throw BluetoothBackendStoppedError synchronously unless started, naming the attempted operation. */
  assertStarted(operation: string): void {
    if (this.#state === 'started') return;
    throw new BluetoothBackendStoppedError(
      `Cannot ${operation}: the Bluetooth backend is ${this.#state}.`,
      { context: { operation, state: this.#state } },
    );
  }

  /** Register a callback while started; invalid callbacks throw TypeError and stopped controllers throw BluetoothBackendStoppedError. */
  onEvent(listener: (event: BackendBluetoothEvent) => void): () => void {
    this.assertStarted('subscribe to events');
    if (typeof listener !== 'function') {
      throw new TypeError('Backend event listener must be a function.');
    }

    let subscribed = true;
    this.#listeners.add(listener);
    return () => {
      if (!subscribed) return;
      subscribed = false;
      this.#listeners.delete(listener);
    };
  }

  /** Deliver a separate event/payload copy to each listener; return false after stopping, and propagate listener exceptions synchronously. */
  emit(event: BackendBluetoothEvent): boolean {
    if (this.#state !== 'started') return false;
    for (const listener of [...this.#listeners]) {
      listener(copyBackendBluetoothEvent(event));
    }
    return true;
  }

  /** Begin stopping immediately, clear listeners and await cleanup once; repeated calls share its promise, including rejection. No deadline is added. */
  stop(cleanup: () => Promise<void>): Promise<void> {
    if (this.#stopPromise !== undefined) return this.#stopPromise;
    if (typeof cleanup !== 'function') {
      throw new TypeError('Backend cleanup must be a function.');
    }

    this.#state = 'stopping';
    this.#listeners.clear();
    this.#stopPromise = Promise.resolve()
      .then(cleanup)
      .finally(() => {
        this.#state = 'stopped';
      });
    return this.#stopPromise;
  }
}

export interface BackendCleanupStep {
  readonly name: string;
  /** Perform one awaited cleanup action; failures are retained by runBestEffortBackendCleanup without skipping later steps. */
  run(): Promise<void>;
}

export interface BackendCleanupFailure {
  readonly name: string;
  readonly cause: unknown;
}

/** Attempt every cleanup step in order and return all observed failures. */
export async function runBestEffortBackendCleanup(
  steps: readonly BackendCleanupStep[],
): Promise<readonly BackendCleanupFailure[]> {
  const failures: BackendCleanupFailure[] = [];
  for (const step of steps) {
    try {
      await step.run();
    } catch (cause) {
      failures.push(Object.freeze({ name: step.name, cause }));
    }
  }
  return Object.freeze(failures);
}
