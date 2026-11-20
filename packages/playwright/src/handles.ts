import {
  attErrorNames,
  BluetoothBackendStoppedError,
  BluetoothCancelledError,
  BluetoothPeripheralAlreadyRegisteredError,
  BluetoothTimeoutError,
  BluetoothValidationError,
  bytes,
  copyBackendBluetoothEvent,
  hciErrorNames,
  normalizeBluetoothUuid,
  validatePeripheralDefinition,
  type AttErrorName,
  type BackendBluetoothEvent,
  type BackendCallOptions,
  type BluetoothAddress,
  type BluetoothUuid,
  type ByteSource,
  type CharacteristicOperationEvent,
  type CharacteristicOperationResponse,
  type CharacteristicWriteType,
  type DescriptorOperationEvent,
  type DescriptorOperationResponse,
  type GattOperationEvent,
  type GattOperationResponse,
  type GattOperationType,
  type HciErrorName,
  type NormalizedCharacteristic,
  type NormalizedDescriptor,
  type NormalizedPeripheral,
  type PeripheralDefinition,
} from '@gattlab/core';

import type { CdpBluetoothBackend, CdpLabInvalidation } from '@gattlab/cdp';

export type OperationResponseSource = 'queued' | 'default';
export type OperationResponseDelivery = 'succeeded' | 'failed';

export interface GattResponseQueue {
  /** Queue one successful response for the next matching operation. */
  queueSuccess(): void;
  /** Queue one named HCI failure for the next matching operation. */
  queueError(error: HciErrorName): void;
}

export interface ConnectionResponseQueue extends GattResponseQueue {
  /** Hold the response to one connection request in FIFO order. */
  holdNext(): HeldConnection;
}

export interface HeldConnection {
  /** Wait for the matching request without changing the queue on timeout. */
  waitForRequest(): Promise<void>;
  /** Release the successful response after the request arrives. */
  resume(): Promise<void>;
  /** Remove this hold if a request has not claimed it yet. */
  cancel(): boolean;
}

export interface ReadResponseQueue {
  /** Queue copied bytes for the next matching read. */
  queue(data: ByteSource): void;
  /** Queue one named ATT failure for the next matching read. */
  queueError(error: AttErrorName): void;
}

export interface AttributeResponseQueue {
  /** Queue one successful response for the next matching operation. */
  queueSuccess(): void;
  /** Queue one named ATT failure for the next matching operation. */
  queueError(error: AttErrorName): void;
}

export type PeripheralOperationRequest = Readonly<{
  type: GattOperationType;
}>;

export type PeripheralOperationResponse =
  | Readonly<{ result: 'success' }>
  | Readonly<{ result: 'error'; error: HciErrorName }>;

export interface PeripheralOperationRecord {
  readonly sequence: number;
  readonly request: PeripheralOperationRequest;
  readonly response: PeripheralOperationResponse;
  readonly responseSource: OperationResponseSource;
  readonly responseDelivery: OperationResponseDelivery;
}

const defaultGattResponses: Readonly<
  Record<'success', PeripheralOperationResponse>
> = Object.freeze({
  success: Object.freeze({ result: 'success' }),
});

export type CharacteristicOperationRequest =
  | Readonly<{
      type:
        | 'read'
        | 'subscribe-to-notifications'
        | 'unsubscribe-from-notifications';
    }>
  | Readonly<{
      type: 'write';
      writeType: CharacteristicWriteType;
      data: Uint8Array;
    }>;

export type CharacteristicOperationResponseSelection =
  | Readonly<{ type: 'read'; result: 'success'; data: Uint8Array }>
  | Readonly<{
      type:
        | 'write'
        | 'subscribe-to-notifications'
        | 'unsubscribe-from-notifications';
      result: 'success';
    }>
  | Readonly<{
      type:
        | 'read'
        | 'write'
        | 'subscribe-to-notifications'
        | 'unsubscribe-from-notifications';
      result: 'error';
      error: AttErrorName;
    }>;

export interface CharacteristicOperationRecord {
  readonly sequence: number;
  readonly request: CharacteristicOperationRequest;
  readonly response: CharacteristicOperationResponseSelection;
  readonly responseSource: OperationResponseSource;
  readonly responseDelivery: OperationResponseDelivery;
}

export interface CharacteristicWrite {
  readonly data: Uint8Array;
  readonly writeType: CharacteristicWriteType;
}

export type DescriptorOperationRequest =
  Readonly<{ type: 'read' }> | Readonly<{ type: 'write'; data: Uint8Array }>;

export type DescriptorOperationResponseSelection =
  | Readonly<{ type: 'read'; result: 'success'; data: Uint8Array }>
  | Readonly<{ type: 'write'; result: 'success' }>
  | Readonly<{
      type: 'read' | 'write';
      result: 'error';
      error: AttErrorName;
    }>;

export interface DescriptorOperationRecord {
  readonly sequence: number;
  readonly request: DescriptorOperationRequest;
  readonly response: DescriptorOperationResponseSelection;
  readonly responseSource: OperationResponseSource;
  readonly responseDelivery: OperationResponseDelivery;
}

export interface DescriptorWrite {
  readonly data: Uint8Array;
}

export interface DescriptorHandle {
  readonly uuid: BluetoothUuid;
  readonly reads: ReadResponseQueue;
  readonly writes: AttributeResponseQueue;
  /** Return a frozen snapshot of the newest descriptor operations. */
  operations(): readonly DescriptorOperationRecord[];
  /** Wait within `operationTimeoutMs` for the next descriptor write. */
  waitForWrite(): Promise<DescriptorWrite>;
}

export interface CharacteristicHandle {
  readonly uuid: BluetoothUuid;
  readonly serviceUuid: BluetoothUuid;
  readonly reads: ReadResponseQueue;
  readonly writes: AttributeResponseQueue;
  readonly subscriptions: AttributeResponseQueue;
  readonly unsubscriptions: AttributeResponseQueue;
  /** Resolve one descriptor by its normalized UUID. */
  descriptor(descriptorUuid: string): DescriptorHandle;
  /** Return a frozen snapshot of the newest characteristic operations. */
  operations(): readonly CharacteristicOperationRecord[];
  /** Assert that at least one successful read occurred in this fixture. */
  expectRead(): Promise<void>;
  /** Assert that at least one successful subscription occurred. */
  expectSubscription(): Promise<void>;
  /** Assert that at least one successful unsubscription occurred. */
  expectUnsubscription(): Promise<void>;
  /** Wait within `operationTimeoutMs` for the next characteristic write. */
  waitForWrite(): Promise<CharacteristicWrite>;
}

export interface PeripheralHandle {
  readonly address: BluetoothAddress;
  readonly name: string;
  readonly connection: ConnectionResponseQueue;
  readonly discovery: GattResponseQueue;
  /** Send the separately defined advertisement scan data. */
  advertise(): Promise<void>;
  /** Simulate native GATT disconnection for this address. */
  disconnect(): Promise<void>;
  /** Resolve a characteristic by normalized service and characteristic UUID. */
  characteristic(
    serviceUuid: string,
    characteristicUuid: string,
  ): CharacteristicHandle;
  /** Return a frozen snapshot of the newest connection/discovery operations. */
  operations(): readonly PeripheralOperationRecord[];
}

/** @internal */
export interface BluetoothHandleBackend extends Pick<
  CdpBluetoothBackend,
  | 'assertUsable'
  | 'withCommandBudget'
  | 'checkLiveness'
  | 'diagnoseTimeout'
  | 'onGattOperationInterrupted'
> {
  addPeripheral(
    peripheral: NormalizedPeripheral,
    options?: BackendCallOptions,
  ): Promise<void>;
  simulateAdvertisement(
    peripheral: NormalizedPeripheral,
    options?: BackendCallOptions,
  ): Promise<void>;
  createPreconnectedPeripheral(
    peripheral: NormalizedPeripheral,
    options?: BackendCallOptions,
  ): Promise<void>;
  disconnect(
    address: BluetoothAddress,
    options?: BackendCallOptions,
  ): Promise<void>;
  respondToGattOperation(
    response: GattOperationResponse,
    options?: BackendCallOptions,
  ): Promise<void>;
  respondToCharacteristicOperation(
    response: CharacteristicOperationResponse,
    options?: BackendCallOptions,
  ): Promise<void>;
  respondToDescriptorOperation(
    response: DescriptorOperationResponse,
    options?: BackendCallOptions,
  ): Promise<void>;
  onEvent(listener: (event: BackendBluetoothEvent) => void): () => void;
}

/** @internal */
export interface BluetoothHandleRuntime {
  readonly options: Readonly<{
    operationTimeoutMs: number;
    operationHistoryLimit: number;
  }>;
  withBackend<T>(
    operation: (backend: BluetoothHandleBackend) => Promise<T>,
    operationName?: string,
  ): Promise<T>;
  capturePeripheralDiagnostics(peripheral: NormalizedPeripheral): void;
  assertUsable(operation: string): void;
  onInvalidated(listener: (record: CdpLabInvalidation) => void): () => void;
}

/** @internal */
export interface HandleDeadline {
  cancel(): void;
}

/** @internal */
export interface HandleDeadlineScheduler {
  schedule(deadlineMs: number, onDeadline: () => void): HandleDeadline;
}

interface SelectedResponse<T> {
  readonly response: T;
  readonly source: OperationResponseSource;
}

interface PendingWait<T> {
  deadline?: HandleDeadline;
  readonly resolve: (value: T) => void;
  readonly reject: (cause: unknown) => void;
}

type PreparedOperation = ((
  options: BackendCallOptions,
  assertCommit: () => void,
) => Promise<void>) & { abort(): void };

class ResponseQueue<T> {
  readonly #responses: T[] = [];

  push(response: T): void {
    this.#responses.push(response);
  }

  remove(response: T): boolean {
    const index = this.#responses.indexOf(response);
    if (index < 0) return false;
    this.#responses.splice(index, 1);
    return true;
  }

  clear(): void {
    this.#responses.length = 0;
  }

  select(defaultResponse: () => T): SelectedResponse<T> {
    const queued = this.#responses.shift();
    return queued === undefined
      ? { response: defaultResponse(), source: 'default' }
      : { response: queued, source: 'queued' };
  }
}

class BoundedJournal<T> {
  readonly #limit: number;
  readonly #clone: (record: T) => T;
  readonly #records: T[] = [];

  constructor(limit: number, clone: (record: T) => T) {
    this.#limit = limit;
    this.#clone = clone;
  }

  append(record: T): void {
    if (this.#records.length === this.#limit) this.#records.shift();
    this.#records.push(record);
  }

  snapshot(): readonly T[] {
    return Object.freeze(this.#records.map((record) => this.#clone(record)));
  }
}

type WaitFailure = unknown;

class WaitGroup<T> {
  readonly #scheduler: HandleDeadlineScheduler;
  readonly #copy: (value: T) => T;
  readonly #waiters = new Set<PendingWait<T> & { operation: string }>();

  constructor(scheduler: HandleDeadlineScheduler, copy: (value: T) => T) {
    this.#scheduler = scheduler;
    this.#copy = copy;
  }

  wait(
    operation: string,
    deadlineMs: number,
    timeoutError: () => BluetoothTimeoutError,
    entry: () => Promise<void>,
    diagnose: (timeout: BluetoothTimeoutError) => Promise<never>,
    initial?: { value: T },
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let phase: 'entry' | 'application' | 'diagnostic' | 'settled' = 'entry';
      let retained = initial;
      const finish = (cause?: { value: unknown }): void => {
        if (phase === 'settled') return;
        phase = 'settled';
        this.#waiters.delete(pending);
        pending.deadline?.cancel();
        if (cause !== undefined) {
          const failure = cause.value;
          // Preserve the exact failure supplied by the lifecycle owner.
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
          reject(failure);
        } else if (retained !== undefined) resolve(this.#copy(retained.value));
      };
      const pending: PendingWait<T> & { operation: string } = {
        operation,
        resolve: (value) => {
          if (phase === 'settled' || phase === 'diagnostic') return;
          retained ??= { value: this.#copy(value) };
          if (phase === 'application') finish();
        },
        reject: (cause) => {
          finish({ value: cause });
        },
      };
      this.#waiters.add(pending);
      let check: Promise<void>;
      try {
        check = entry();
      } catch (cause) {
        finish({ value: cause });
        return;
      }
      void check.then(
        () => {
          if (phase !== 'entry') return;
          phase = 'application';
          if (retained !== undefined) {
            finish();
            return;
          }
          pending.deadline = this.#scheduler.schedule(deadlineMs, () => {
            if (phase !== 'application') return;
            phase = 'diagnostic';
            void Promise.resolve()
              .then(() => diagnose(timeoutError()))
              .then(
                () => undefined,
                (cause: unknown) => {
                  finish({ value: cause });
                },
              );
          });
        },
        (cause: unknown) => {
          finish({ value: cause });
        },
      );
    });
  }

  resolve(value: T): void {
    for (const waiter of [...this.#waiters]) waiter.resolve(this.#copy(value));
  }

  reject(cause: WaitFailure): void {
    for (const waiter of [...this.#waiters]) {
      waiter.reject(
        typeof cause === 'function'
          ? (cause as (operation: string) => unknown)(waiter.operation)
          : cause,
      );
    }
  }
}

class StickyExpectation {
  readonly #waits: WaitGroup<void>;
  #count = 0;
  constructor(scheduler: HandleDeadlineScheduler) {
    this.#waits = new WaitGroup<void>(scheduler, () => undefined);
  }
  observe(): void {
    this.#count += 1;
    this.#waits.resolve(undefined);
  }
  expect(
    operation: string,
    deadlineMs: number,
    timeoutError: () => BluetoothTimeoutError,
    entry: () => Promise<void>,
    diagnose: (timeout: BluetoothTimeoutError) => Promise<never>,
  ): Promise<void> {
    return this.#waits.wait(
      operation,
      deadlineMs,
      timeoutError,
      entry,
      diagnose,
      this.#count > 0 ? { value: undefined } : undefined,
    );
  }
  dispose(cause: WaitFailure): void {
    this.#waits.reject(cause);
  }
}

interface HandleOwner {
  assertActive(operation: string): void;
  withBackend<T>(
    operation: (backend: BluetoothHandleBackend) => Promise<T>,
    operationName?: string,
  ): Promise<T>;
}

class HeldConnectionState {
  readonly handle: HeldConnection;
  readonly #forget: () => void;
  readonly #waits: WaitGroup<void>;
  #release: (() => Promise<void>) | undefined;
  #prepared: PreparedOperation | undefined;
  #unsubscribe: (() => void) | undefined;
  #interruptDelivery: ((cause: unknown) => void) | undefined;
  #delivery: Promise<void> | undefined;
  #failure: { cause: unknown } | undefined;
  #assigned = false;
  #finished = false;

  constructor(
    owner: HandleOwner,
    scheduler: HandleDeadlineScheduler,
    timeoutMs: number,
    address: BluetoothAddress,
    remove: () => boolean,
    forget: () => void,
  ) {
    this.#forget = forget;
    this.#waits = new WaitGroup<void>(scheduler, () => undefined);
    this.handle = Object.freeze({
      waitForRequest: () => {
        owner.assertActive('waitForRequest');
        return this.#waitForRequest(address, timeoutMs);
      },
      resume: () => {
        owner.assertActive('resume');
        return this.#resume();
      },
      cancel: () => {
        owner.assertActive('cancel');
        if (!remove()) return false;
        this.abort(
          new BluetoothCancelledError(
            'The queued connection hold was cancelled.',
            {
              context: {
                address,
                operation: 'cancel',
                operationLayer: 'playwright',
              },
            },
          ),
        );
        return true;
      },
    });
  }

  bind(
    backend: BluetoothHandleBackend,
    id: string,
    prepared: PreparedOperation,
    release: () => Promise<void>,
  ): void {
    this.#prepared = prepared;
    this.#release = release;
    try {
      this.#unsubscribe = backend.onGattOperationInterrupted(id, (error) => {
        this.abort(error);
      });
    } catch (cause) {
      this.abort(cause);
      throw cause;
    }
    this.#assigned = true;
    this.#waits.resolve(undefined);
  }

  assertUninterrupted(): void {
    if (this.#failure !== undefined) throw this.#failure.cause;
  }

  abort(cause: unknown): void {
    if (this.#finished) return;
    const deliveryCause =
      typeof cause === 'function'
        ? (cause as (operation: string) => unknown)('resume')
        : cause;
    this.#failure = { cause: deliveryCause };
    this.#waits.reject(cause);
    this.#prepared?.abort();
    this.#interruptDelivery?.(deliveryCause);
    this.#finish();
  }

  async #waitForRequest(
    address: BluetoothAddress,
    timeoutMs: number,
  ): Promise<void> {
    this.assertUninterrupted();
    if (this.#assigned) return;
    return this.#waits.wait(
      'waitForRequest',
      timeoutMs,
      () =>
        new BluetoothTimeoutError(
          'The held connection did not receive a request.',
          {
            context: {
              address,
              deadlineMs: timeoutMs,
              deadlineKind: 'application-operation',
              timeoutPhase: 'operation',
              operation: 'waitForRequest',
              operationLayer: 'playwright',
            },
          },
        ),
      () => Promise.resolve(),
      (timeout) => Promise.reject(timeout),
    );
  }

  async #resume(): Promise<void> {
    this.assertUninterrupted();
    if (this.#delivery !== undefined) return this.#delivery;
    const release = this.#release;
    if (release === undefined) {
      throw new BluetoothValidationError(
        'The held connection has not received a request.',
        {
          context: {
            operation: 'resume',
            operationLayer: 'playwright',
            reason: 'connection-request-not-received',
          },
        },
      );
    }
    const interruption = new Promise<never>((_resolve, reject) => {
      this.#interruptDelivery = reject;
    });
    this.#delivery = Promise.race([interruption, release()]).then(
      () => {
        this.#finish();
      },
      (cause: unknown) => {
        this.abort(cause);
        throw cause;
      },
    );
    return this.#delivery;
  }

  #finish(): void {
    this.#finished = true;
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#release = undefined;
    this.#prepared = undefined;
    this.#interruptDelivery = undefined;
    this.#forget();
  }
}

class GattResponseQueueFacade implements GattResponseQueue {
  readonly #owner: HandleOwner;
  readonly #queue: Pick<ResponseQueue<PeripheralOperationResponse>, 'push'>;

  constructor(
    owner: HandleOwner,
    queue: Pick<ResponseQueue<PeripheralOperationResponse>, 'push'>,
  ) {
    this.#owner = owner;
    this.#queue = queue;
    Object.freeze(this);
  }

  queueSuccess(): void {
    this.#owner.assertActive('queueSuccess');
    this.#queue.push(Object.freeze({ result: 'success' }));
  }

  queueError(error: HciErrorName): void {
    assertHciError(error);
    this.#owner.assertActive('queueError');
    this.#queue.push(Object.freeze({ result: 'error', error }));
  }
}

class ReadResponseQueueFacade implements ReadResponseQueue {
  readonly #owner: HandleOwner;
  readonly #queue: ResponseQueue<CharacteristicOperationResponseSelection>;

  constructor(
    owner: HandleOwner,
    queue: ResponseQueue<CharacteristicOperationResponseSelection>,
  ) {
    this.#owner = owner;
    this.#queue = queue;
    Object.freeze(this);
  }

  queue(data: ByteSource): void {
    const copied = copyBytes(data);
    this.#owner.assertActive('queue');
    this.#queue.push(
      Object.freeze({ type: 'read', result: 'success', data: copied }),
    );
  }

  queueError(error: AttErrorName): void {
    assertAttError(error);
    this.#owner.assertActive('queueError');
    this.#queue.push(Object.freeze({ type: 'read', result: 'error', error }));
  }
}

class AttributeResponseQueueFacade implements AttributeResponseQueue {
  readonly #owner: HandleOwner;
  readonly #type:
    'write' | 'subscribe-to-notifications' | 'unsubscribe-from-notifications';
  readonly #queue: ResponseQueue<CharacteristicOperationResponseSelection>;

  constructor(
    owner: HandleOwner,
    type:
      'write' | 'subscribe-to-notifications' | 'unsubscribe-from-notifications',
    queue: ResponseQueue<CharacteristicOperationResponseSelection>,
  ) {
    this.#owner = owner;
    this.#type = type;
    this.#queue = queue;
    Object.freeze(this);
  }

  queueSuccess(): void {
    this.#owner.assertActive('queueSuccess');
    this.#queue.push(Object.freeze({ type: this.#type, result: 'success' }));
  }

  queueError(error: AttErrorName): void {
    assertAttError(error);
    this.#owner.assertActive('queueError');
    this.#queue.push(
      Object.freeze({ type: this.#type, result: 'error', error }),
    );
  }
}

class DescriptorReadResponseQueueFacade implements ReadResponseQueue {
  readonly #owner: HandleOwner;
  readonly #queue: ResponseQueue<DescriptorOperationResponseSelection>;

  constructor(
    owner: HandleOwner,
    queue: ResponseQueue<DescriptorOperationResponseSelection>,
  ) {
    this.#owner = owner;
    this.#queue = queue;
    Object.freeze(this);
  }

  queue(data: ByteSource): void {
    const copied = copyBytes(data);
    this.#owner.assertActive('queue');
    this.#queue.push(
      Object.freeze({ type: 'read', result: 'success', data: copied }),
    );
  }

  queueError(error: AttErrorName): void {
    assertAttError(error);
    this.#owner.assertActive('queueError');
    this.#queue.push(Object.freeze({ type: 'read', result: 'error', error }));
  }
}

class DescriptorWriteResponseQueueFacade implements AttributeResponseQueue {
  readonly #owner: HandleOwner;
  readonly #queue: ResponseQueue<DescriptorOperationResponseSelection>;

  constructor(
    owner: HandleOwner,
    queue: ResponseQueue<DescriptorOperationResponseSelection>,
  ) {
    this.#owner = owner;
    this.#queue = queue;
    Object.freeze(this);
  }

  queueSuccess(): void {
    this.#owner.assertActive('queueSuccess');
    this.#queue.push(Object.freeze({ type: 'write', result: 'success' }));
  }

  queueError(error: AttErrorName): void {
    assertAttError(error);
    this.#owner.assertActive('queueError');
    this.#queue.push(Object.freeze({ type: 'write', result: 'error', error }));
  }
}

class PeripheralHandleState {
  readonly definition: NormalizedPeripheral;
  readonly handle: PeripheralHandle;
  readonly #owner: HandleOwner;
  readonly #connectionResponses = new ResponseQueue<
    PeripheralOperationResponse | HeldConnectionState
  >();
  readonly #discoveryResponses =
    new ResponseQueue<PeripheralOperationResponse>();
  readonly #heldConnections = new Set<HeldConnectionState>();
  readonly #journal: BoundedJournal<PeripheralOperationRecord>;
  readonly #characteristics = new Map<string, CharacteristicHandleState>();
  readonly #counters = createGattCounters();

  constructor(
    owner: HandleOwner,
    definition: NormalizedPeripheral,
    options: Readonly<{
      historyLimit: number;
      operationTimeoutMs: number;
      scheduler: HandleDeadlineScheduler;
    }>,
  ) {
    this.#owner = owner;
    this.definition = definition;
    this.#journal = new BoundedJournal(
      options.historyLimit,
      clonePeripheralOperationRecord,
    );
    for (const service of definition.services) {
      for (const characteristic of service.characteristics) {
        const state = new CharacteristicHandleState(
          owner,
          definition.address,
          service.uuid,
          characteristic,
          options,
        );
        this.#characteristics.set(
          characteristicKey(service.uuid, characteristic.uuid),
          state,
        );
      }
    }
    const connection = new GattResponseQueueFacade(
      owner,
      this.#connectionResponses,
    );
    this.handle = new FixturePeripheralHandle(
      this,
      Object.freeze({
        queueSuccess: () => {
          connection.queueSuccess();
        },
        queueError: (error: HciErrorName) => {
          connection.queueError(error);
        },
        holdNext: () => {
          owner.assertActive('holdNext');
          const held: HeldConnectionState = new HeldConnectionState(
            owner,
            options.scheduler,
            options.operationTimeoutMs,
            definition.address,
            () => this.#connectionResponses.remove(held),
            () => {
              this.#heldConnections.delete(held);
            },
          );
          this.#heldConnections.add(held);
          this.#connectionResponses.push(held);
          return held.handle;
        },
      }),
      new GattResponseQueueFacade(owner, this.#discoveryResponses),
    );
  }

  characteristic(
    serviceUuid: string,
    characteristicUuid: string,
  ): CharacteristicHandle {
    const normalizedServiceUuid = normalizeLookupUuid(
      serviceUuid,
      'serviceUuid',
    );
    const normalizedCharacteristicUuid = normalizeLookupUuid(
      characteristicUuid,
      'characteristicUuid',
    );
    this.#owner.assertActive('characteristic');
    const state = this.#characteristics.get(
      characteristicKey(normalizedServiceUuid, normalizedCharacteristicUuid),
    );
    if (state !== undefined) return state.handle;
    throw new BluetoothValidationError(
      'Bluetooth characteristic was not found on the peripheral.',
      {
        context: {
          reason: 'characteristic-not-found',
          address: this.definition.address,
          serviceUuid: normalizedServiceUuid,
          characteristicUuid: normalizedCharacteristicUuid,
        },
      },
    );
  }

  operations(): readonly PeripheralOperationRecord[] {
    return this.#journal.snapshot();
  }

  prepare(
    event: GattOperationEvent,
    backend: BluetoothHandleBackend,
    sequence: number,
    schedule: (prepared: PreparedOperation) => Promise<void>,
  ): PreparedOperation | undefined {
    const queue =
      event.type === 'connection'
        ? this.#connectionResponses
        : this.#discoveryResponses;
    const selected = queue.select(
      () => defaultGattResponses[this.definition.defaults[event.type]],
    );
    const held =
      selected.response instanceof HeldConnectionState
        ? selected.response
        : undefined;
    const response =
      selected.response instanceof HeldConnectionState
        ? defaultGattResponses.success
        : selected.response;
    const request = Object.freeze({ type: event.type });
    let recorded = false;
    const record = (delivery: OperationResponseDelivery): void => {
      if (recorded) return;
      recorded = true;
      this.#journal.append(
        Object.freeze({
          sequence,
          request,
          response,
          responseSource: selected.source,
          responseDelivery: delivery,
        }),
      );
    };
    const deliver = async (
      options: BackendCallOptions,
      assertCommit: () => void,
    ): Promise<void> => {
      let delivery: OperationResponseDelivery = 'succeeded';
      let failure: unknown;
      try {
        assertCommit();
        held?.assertUninterrupted();
        await backend.respondToGattOperation(
          {
            operationId: event.operationId,
            type: event.type,
            ...response,
          },
          options,
        );
        assertCommit();
        held?.assertUninterrupted();
        this.#counters[event.type][response.result] += 1;
      } catch (cause) {
        delivery = 'failed';
        failure = cause;
      }
      record(delivery);
      if (delivery === 'failed') throw failure;
    };
    const prepared = Object.assign(deliver, {
      abort: () => {
        record('failed');
      },
    });
    if (held === undefined) return prepared;
    held.bind(backend, event.operationId, prepared, () => schedule(prepared));
    return undefined;
  }

  prepareCharacteristic(
    event: CharacteristicOperationEvent,
    backend: BluetoothHandleBackend,
    sequence: number,
  ): PreparedOperation | undefined {
    return this.#characteristics
      .get(
        characteristicKey(
          event.characteristic.serviceUuid,
          event.characteristic.characteristicUuid,
        ),
      )
      ?.prepare(event, backend, sequence);
  }

  prepareDescriptor(
    event: DescriptorOperationEvent,
    backend: BluetoothHandleBackend,
    sequence: number,
  ): PreparedOperation | undefined {
    return this.#characteristics
      .get(
        characteristicKey(
          event.descriptor.serviceUuid,
          event.descriptor.characteristicUuid,
        ),
      )
      ?.prepareDescriptor(event, backend, sequence);
  }

  advertise(): Promise<void> {
    this.#owner.assertActive('advertise');
    if (this.definition.advertisement === undefined) {
      return Promise.reject(
        new BluetoothValidationError(
          'Bluetooth peripheral has no advertisement definition.',
          {
            context: {
              reason: 'advertisement-not-defined',
              address: this.definition.address,
            },
          },
        ),
      );
    }
    return this.#owner.withBackend(
      (backend) =>
        backend.withCommandBudget('advertise', 'playwright', (options) =>
          backend.simulateAdvertisement(this.definition, options),
        ),
      'advertise',
    );
  }

  disconnect(): Promise<void> {
    this.#owner.assertActive('disconnect');
    return this.#owner.withBackend(
      (backend) =>
        backend.withCommandBudget('disconnect', 'playwright', (options) =>
          backend.disconnect(this.definition.address, options),
        ),
      'disconnect',
    );
  }

  dispose(cause: unknown): void {
    this.#connectionResponses.clear();
    this.#discoveryResponses.clear();
    for (const held of this.#heldConnections) held.abort(cause);
    for (const characteristic of this.#characteristics.values()) {
      characteristic.dispose(cause);
    }
  }
}

class FixturePeripheralHandle implements PeripheralHandle {
  readonly connection: ConnectionResponseQueue;
  readonly discovery: GattResponseQueue;
  readonly #state: PeripheralHandleState;

  constructor(
    state: PeripheralHandleState,
    connection: ConnectionResponseQueue,
    discovery: GattResponseQueue,
  ) {
    this.#state = state;
    this.connection = connection;
    this.discovery = discovery;
    Object.freeze(this);
  }

  get address(): BluetoothAddress {
    return this.#state.definition.address;
  }

  get name(): string {
    return this.#state.definition.name;
  }

  advertise(): Promise<void> {
    return this.#state.advertise();
  }

  disconnect(): Promise<void> {
    return this.#state.disconnect();
  }

  characteristic(
    serviceUuid: string,
    characteristicUuid: string,
  ): CharacteristicHandle {
    return this.#state.characteristic(serviceUuid, characteristicUuid);
  }

  operations(): readonly PeripheralOperationRecord[] {
    return this.#state.operations();
  }
}

class CharacteristicHandleState {
  readonly handle: CharacteristicHandle;
  readonly #owner: HandleOwner;
  readonly #address: BluetoothAddress;
  readonly #definition: NormalizedCharacteristic;
  readonly #serviceUuid: BluetoothUuid;
  readonly #operationTimeoutMs: number;
  readonly #readResponses =
    new ResponseQueue<CharacteristicOperationResponseSelection>();
  readonly #writeResponses =
    new ResponseQueue<CharacteristicOperationResponseSelection>();
  readonly #subscriptionResponses =
    new ResponseQueue<CharacteristicOperationResponseSelection>();
  readonly #unsubscriptionResponses =
    new ResponseQueue<CharacteristicOperationResponseSelection>();
  readonly #journal: BoundedJournal<CharacteristicOperationRecord>;
  readonly #descriptors = new Map<BluetoothUuid, DescriptorHandleState>();
  readonly #successfulReads: StickyExpectation;
  readonly #successfulSubscriptions: StickyExpectation;
  readonly #successfulUnsubscriptions: StickyExpectation;
  readonly #writes: WaitGroup<CharacteristicWrite>;
  readonly #counters = createCharacteristicCounters();

  constructor(
    owner: HandleOwner,
    address: BluetoothAddress,
    serviceUuid: BluetoothUuid,
    definition: NormalizedCharacteristic,
    options: Readonly<{
      historyLimit: number;
      operationTimeoutMs: number;
      scheduler: HandleDeadlineScheduler;
    }>,
  ) {
    this.#owner = owner;
    this.#address = address;
    this.#serviceUuid = serviceUuid;
    this.#definition = definition;
    this.#operationTimeoutMs = options.operationTimeoutMs;
    this.#journal = new BoundedJournal(
      options.historyLimit,
      cloneCharacteristicOperationRecord,
    );
    this.#successfulReads = new StickyExpectation(options.scheduler);
    this.#successfulSubscriptions = new StickyExpectation(options.scheduler);
    this.#successfulUnsubscriptions = new StickyExpectation(options.scheduler);
    this.#writes = new WaitGroup(options.scheduler, cloneCharacteristicWrite);
    for (const descriptor of definition.descriptors) {
      const state = new DescriptorHandleState(
        owner,
        address,
        serviceUuid,
        definition.uuid,
        descriptor,
        options,
      );
      this.#descriptors.set(descriptor.uuid, state);
    }
    this.handle = new FixtureCharacteristicHandle(
      this,
      new ReadResponseQueueFacade(owner, this.#readResponses),
      new AttributeResponseQueueFacade(owner, 'write', this.#writeResponses),
      new AttributeResponseQueueFacade(
        owner,
        'subscribe-to-notifications',
        this.#subscriptionResponses,
      ),
      new AttributeResponseQueueFacade(
        owner,
        'unsubscribe-from-notifications',
        this.#unsubscriptionResponses,
      ),
    );
  }

  get uuid(): BluetoothUuid {
    return this.#definition.uuid;
  }

  get serviceUuid(): BluetoothUuid {
    return this.#serviceUuid;
  }

  descriptor(descriptorUuid: string): DescriptorHandle {
    const normalized = normalizeLookupUuid(descriptorUuid, 'descriptorUuid');
    this.#owner.assertActive('descriptor');
    const state = this.#descriptors.get(normalized);
    if (state !== undefined) return state.handle;
    throw new BluetoothValidationError(
      'Bluetooth descriptor was not found on the characteristic.',
      {
        context: {
          reason: 'descriptor-not-found',
          address: this.#address,
          serviceUuid: this.#serviceUuid,
          characteristicUuid: this.#definition.uuid,
          descriptorUuid: normalized,
        },
      },
    );
  }

  operations(): readonly CharacteristicOperationRecord[] {
    return this.#journal.snapshot();
  }

  expectRead(): Promise<void> {
    this.#owner.assertActive('expectRead');
    return this.#successfulReads.expect(
      'expectRead',
      this.#operationTimeoutMs,
      () => this.#timeout('read'),
      () =>
        this.#owner.withBackend(
          (backend) => backend.checkLiveness('expectRead', 'playwright'),
          'expectRead',
        ),
      (timeout) =>
        this.#owner.withBackend(
          (backend) =>
            backend.diagnoseTimeout('expectRead', 'playwright', timeout),
          'expectRead',
        ),
    );
  }

  expectSubscription(): Promise<void> {
    this.#owner.assertActive('expectSubscription');
    return this.#successfulSubscriptions.expect(
      'expectSubscription',
      this.#operationTimeoutMs,
      () => this.#timeout('subscribe-to-notifications'),
      () =>
        this.#owner.withBackend(
          (backend) =>
            backend.checkLiveness('expectSubscription', 'playwright'),
          'expectSubscription',
        ),
      (timeout) =>
        this.#owner.withBackend(
          (backend) =>
            backend.diagnoseTimeout(
              'expectSubscription',
              'playwright',
              timeout,
            ),
          'expectSubscription',
        ),
    );
  }

  expectUnsubscription(): Promise<void> {
    this.#owner.assertActive('expectUnsubscription');
    return this.#successfulUnsubscriptions.expect(
      'expectUnsubscription',
      this.#operationTimeoutMs,
      () => this.#timeout('unsubscribe-from-notifications'),
      () =>
        this.#owner.withBackend(
          (backend) =>
            backend.checkLiveness('expectUnsubscription', 'playwright'),
          'expectUnsubscription',
        ),
      (timeout) =>
        this.#owner.withBackend(
          (backend) =>
            backend.diagnoseTimeout(
              'expectUnsubscription',
              'playwright',
              timeout,
            ),
          'expectUnsubscription',
        ),
    );
  }

  waitForWrite(): Promise<CharacteristicWrite> {
    this.#owner.assertActive('waitForWrite');
    return this.#writes.wait(
      'waitForWrite',
      this.#operationTimeoutMs,
      () => this.#timeout('write'),
      () =>
        this.#owner.withBackend(
          (backend) => backend.checkLiveness('waitForWrite', 'playwright'),
          'waitForWrite',
        ),
      (timeout) =>
        this.#owner.withBackend(
          (backend) =>
            backend.diagnoseTimeout('waitForWrite', 'playwright', timeout),
          'waitForWrite',
        ),
    );
  }

  prepare(
    event: CharacteristicOperationEvent,
    backend: BluetoothHandleBackend,
    sequence: number,
  ): PreparedOperation {
    const selected = this.#selectResponse(event.type);
    const request = characteristicRequest(event);
    let recorded = false;
    const record = (delivery: OperationResponseDelivery): void => {
      if (recorded) return;
      recorded = true;
      this.#journal.append(
        Object.freeze({
          sequence,
          request,
          response: selected.response,
          responseSource: selected.source,
          responseDelivery: delivery,
        }),
      );
    };
    const deliver = async (
      options: BackendCallOptions,
      assertCommit: () => void,
    ): Promise<void> => {
      let delivery: OperationResponseDelivery = 'succeeded';
      let failure: unknown;
      try {
        assertCommit();
        await backend.respondToCharacteristicOperation(
          characteristicBackendResponse(event.operationId, selected.response),
          options,
        );
        assertCommit();
        this.#counters[event.type][selected.response.result] += 1;
        this.#observe(event, selected.response);
      } catch (cause) {
        delivery = 'failed';
        failure = cause;
      }
      record(delivery);
      if (delivery === 'failed') throw failure;
    };
    return Object.assign(deliver, {
      abort: () => {
        record('failed');
      },
    });
  }

  prepareDescriptor(
    event: DescriptorOperationEvent,
    backend: BluetoothHandleBackend,
    sequence: number,
  ): PreparedOperation | undefined {
    return this.#descriptors
      .get(event.descriptor.descriptorUuid)
      ?.prepare(event, backend, sequence);
  }

  dispose(cause: unknown): void {
    this.#readResponses.clear();
    this.#writeResponses.clear();
    this.#subscriptionResponses.clear();
    this.#unsubscriptionResponses.clear();
    this.#successfulReads.dispose(cause);
    this.#successfulSubscriptions.dispose(cause);
    this.#successfulUnsubscriptions.dispose(cause);
    this.#writes.reject(cause);
    for (const descriptor of this.#descriptors.values()) {
      descriptor.dispose(cause);
    }
  }

  #selectResponse(
    type: CharacteristicOperationEvent['type'],
  ): SelectedResponse<CharacteristicOperationResponseSelection> {
    if (type === 'read') {
      return this.#readResponses.select(() =>
        Object.freeze({
          type,
          result: 'success',
          data: this.#definition.initialValue ?? new Uint8Array(),
        }),
      );
    }
    if (type === 'write') {
      return this.#writeResponses.select(() =>
        Object.freeze({ type, result: 'success' }),
      );
    }
    if (type === 'subscribe-to-notifications') {
      return this.#subscriptionResponses.select(() =>
        Object.freeze({ type, result: 'success' }),
      );
    }
    return this.#unsubscriptionResponses.select(() =>
      Object.freeze({ type, result: 'success' }),
    );
  }

  #observe(
    event: CharacteristicOperationEvent,
    response: CharacteristicOperationResponseSelection,
  ): void {
    if (event.type === 'write') {
      this.#writes.resolve(
        Object.freeze({
          data: new Uint8Array(event.data),
          writeType: event.writeType,
        }),
      );
      return;
    }
    if (response.result !== 'success') return;
    if (event.type === 'read') {
      this.#successfulReads.observe();
    } else if (event.type === 'subscribe-to-notifications') {
      this.#successfulSubscriptions.observe();
    } else {
      this.#successfulUnsubscriptions.observe();
    }
  }

  #timeout(
    operation: CharacteristicOperationEvent['type'],
  ): BluetoothTimeoutError {
    return new BluetoothTimeoutError(
      `Timed out waiting for Bluetooth characteristic ${operation}.`,
      {
        context: {
          operation,
          deadlineMs: this.#operationTimeoutMs,
          address: this.#address,
          serviceUuid: this.#serviceUuid,
          characteristicUuid: this.#definition.uuid,
        },
      },
    );
  }
}

class FixtureCharacteristicHandle implements CharacteristicHandle {
  readonly reads: ReadResponseQueue;
  readonly writes: AttributeResponseQueue;
  readonly subscriptions: AttributeResponseQueue;
  readonly unsubscriptions: AttributeResponseQueue;
  readonly #state: CharacteristicHandleState;

  constructor(
    state: CharacteristicHandleState,
    reads: ReadResponseQueue,
    writes: AttributeResponseQueue,
    subscriptions: AttributeResponseQueue,
    unsubscriptions: AttributeResponseQueue,
  ) {
    this.#state = state;
    this.reads = reads;
    this.writes = writes;
    this.subscriptions = subscriptions;
    this.unsubscriptions = unsubscriptions;
    Object.freeze(this);
  }

  get uuid(): BluetoothUuid {
    return this.#state.uuid;
  }

  get serviceUuid(): BluetoothUuid {
    return this.#state.serviceUuid;
  }

  descriptor(descriptorUuid: string): DescriptorHandle {
    return this.#state.descriptor(descriptorUuid);
  }

  operations(): readonly CharacteristicOperationRecord[] {
    return this.#state.operations();
  }

  expectRead(): Promise<void> {
    return this.#state.expectRead();
  }

  expectSubscription(): Promise<void> {
    return this.#state.expectSubscription();
  }

  expectUnsubscription(): Promise<void> {
    return this.#state.expectUnsubscription();
  }

  waitForWrite(): Promise<CharacteristicWrite> {
    return this.#state.waitForWrite();
  }
}

class DescriptorHandleState {
  readonly handle: DescriptorHandle;
  readonly #owner: HandleOwner;
  readonly #address: BluetoothAddress;
  readonly #serviceUuid: BluetoothUuid;
  readonly #characteristicUuid: BluetoothUuid;
  readonly #definition: NormalizedDescriptor;
  readonly #operationTimeoutMs: number;
  readonly #readResponses =
    new ResponseQueue<DescriptorOperationResponseSelection>();
  readonly #writeResponses =
    new ResponseQueue<DescriptorOperationResponseSelection>();
  readonly #journal: BoundedJournal<DescriptorOperationRecord>;
  readonly #writes: WaitGroup<DescriptorWrite>;
  readonly #counters = createDescriptorCounters();

  constructor(
    owner: HandleOwner,
    address: BluetoothAddress,
    serviceUuid: BluetoothUuid,
    characteristicUuid: BluetoothUuid,
    definition: NormalizedDescriptor,
    options: Readonly<{
      historyLimit: number;
      operationTimeoutMs: number;
      scheduler: HandleDeadlineScheduler;
    }>,
  ) {
    this.#owner = owner;
    this.#address = address;
    this.#serviceUuid = serviceUuid;
    this.#characteristicUuid = characteristicUuid;
    this.#definition = definition;
    this.#operationTimeoutMs = options.operationTimeoutMs;
    this.#journal = new BoundedJournal(
      options.historyLimit,
      cloneDescriptorOperationRecord,
    );
    this.#writes = new WaitGroup(options.scheduler, cloneDescriptorWrite);
    this.handle = new FixtureDescriptorHandle(
      this,
      new DescriptorReadResponseQueueFacade(owner, this.#readResponses),
      new DescriptorWriteResponseQueueFacade(owner, this.#writeResponses),
    );
  }

  get uuid(): BluetoothUuid {
    return this.#definition.uuid;
  }

  operations(): readonly DescriptorOperationRecord[] {
    return this.#journal.snapshot();
  }

  waitForWrite(): Promise<DescriptorWrite> {
    this.#owner.assertActive('waitForWrite');
    return this.#writes.wait(
      'waitForWrite',
      this.#operationTimeoutMs,
      () => this.#timeout('write'),
      () =>
        this.#owner.withBackend(
          (backend) => backend.checkLiveness('waitForWrite', 'playwright'),
          'waitForWrite',
        ),
      (timeout) =>
        this.#owner.withBackend(
          (backend) =>
            backend.diagnoseTimeout('waitForWrite', 'playwright', timeout),
          'waitForWrite',
        ),
    );
  }

  prepare(
    event: DescriptorOperationEvent,
    backend: BluetoothHandleBackend,
    sequence: number,
  ): PreparedOperation {
    const selected = this.#selectResponse(event.type);
    const request = descriptorRequest(event);
    let recorded = false;
    const record = (delivery: OperationResponseDelivery): void => {
      if (recorded) return;
      recorded = true;
      this.#journal.append(
        Object.freeze({
          sequence,
          request,
          response: selected.response,
          responseSource: selected.source,
          responseDelivery: delivery,
        }),
      );
    };
    const deliver = async (
      options: BackendCallOptions,
      assertCommit: () => void,
    ): Promise<void> => {
      let delivery: OperationResponseDelivery = 'succeeded';
      let failure: unknown;
      try {
        assertCommit();
        await backend.respondToDescriptorOperation(
          descriptorBackendResponse(event.operationId, selected.response),
          options,
        );
        assertCommit();
        this.#counters[event.type][selected.response.result] += 1;
        if (event.type === 'write') {
          this.#writes.resolve(
            Object.freeze({ data: new Uint8Array(event.data) }),
          );
        }
      } catch (cause) {
        delivery = 'failed';
        failure = cause;
      }
      record(delivery);
      if (delivery === 'failed') throw failure;
    };
    return Object.assign(deliver, {
      abort: () => {
        record('failed');
      },
    });
  }

  dispose(cause: unknown): void {
    this.#readResponses.clear();
    this.#writeResponses.clear();
    this.#writes.reject(cause);
  }

  #selectResponse(
    type: DescriptorOperationEvent['type'],
  ): SelectedResponse<DescriptorOperationResponseSelection> {
    if (type === 'read') {
      return this.#readResponses.select(() =>
        Object.freeze({
          type,
          result: 'success',
          data: this.#definition.initialValue ?? new Uint8Array(),
        }),
      );
    }
    return this.#writeResponses.select(() =>
      Object.freeze({ type, result: 'success' }),
    );
  }

  #timeout(operation: DescriptorOperationEvent['type']): BluetoothTimeoutError {
    return new BluetoothTimeoutError(
      `Timed out waiting for Bluetooth descriptor ${operation}.`,
      {
        context: {
          operation,
          deadlineMs: this.#operationTimeoutMs,
          address: this.#address,
          serviceUuid: this.#serviceUuid,
          characteristicUuid: this.#characteristicUuid,
          descriptorUuid: this.#definition.uuid,
        },
      },
    );
  }
}

class FixtureDescriptorHandle implements DescriptorHandle {
  readonly reads: ReadResponseQueue;
  readonly writes: AttributeResponseQueue;
  readonly #state: DescriptorHandleState;

  constructor(
    state: DescriptorHandleState,
    reads: ReadResponseQueue,
    writes: AttributeResponseQueue,
  ) {
    this.#state = state;
    this.reads = reads;
    this.writes = writes;
    Object.freeze(this);
  }

  get uuid(): BluetoothUuid {
    return this.#state.uuid;
  }

  operations(): readonly DescriptorOperationRecord[] {
    return this.#state.operations();
  }

  waitForWrite(): Promise<DescriptorWrite> {
    return this.#state.waitForWrite();
  }
}

/** @internal */
export class BluetoothHandleController implements HandleOwner {
  readonly #runtime: BluetoothHandleRuntime;
  readonly #scheduler: HandleDeadlineScheduler;
  readonly #peripherals = new Map<BluetoothAddress, PeripheralHandleState>();
  #backend: BluetoothHandleBackend | undefined;
  #unsubscribe: (() => void) | undefined;
  #responseChain: Promise<void> = Promise.resolve();
  #nextSequence = 1;
  #disposed = false;
  #invalidation: CdpLabInvalidation | undefined;
  readonly #unsubscribeInvalidation: () => void;

  constructor(
    runtime: BluetoothHandleRuntime,
    scheduler: HandleDeadlineScheduler,
  ) {
    this.#runtime = runtime;
    this.#scheduler = scheduler;
    this.#unsubscribeInvalidation = runtime.onInvalidated((record) => {
      if (this.#disposed || this.#invalidation !== undefined) return;
      this.#invalidation = Object.freeze({ ...record });
      this.#unsubscribe?.();
      this.#unsubscribe = undefined;
      for (const peripheral of this.#peripherals.values()) {
        peripheral.dispose((operation: string) =>
          this.#invalidatedError(operation),
        );
      }
    });
  }

  createPeripheral(
    definition: PeripheralDefinition,
  ): Promise<PeripheralHandle> {
    return this.#register(definition, false);
  }

  createPreconnectedPeripheral(
    definition: PeripheralDefinition,
  ): Promise<PeripheralHandle> {
    return this.#register(definition, true);
  }

  assertActive(operation: string): void {
    if (this.#invalidation !== undefined)
      throw this.#invalidatedError(operation);
    this.#runtime.assertUsable(operation);
    if (!this.#disposed) return;
    throw new BluetoothBackendStoppedError(
      'Bluetooth lab is disposed and cannot perform handle operations.',
      { context: { lifecycleState: 'disposed' } },
    );
  }

  withBackend<T>(
    operation: (backend: BluetoothHandleBackend) => Promise<T>,
    operationName = 'onEvent',
  ): Promise<T> {
    this.assertActive(operationName);
    return this.#runtime.withBackend(operation, operationName);
  }

  #invalidatedError(operation: string): BluetoothBackendStoppedError {
    const record = this.#invalidation;
    if (record === undefined)
      throw new Error('Missing lab invalidation record.');
    const { cause, ...context } = record;
    return new BluetoothBackendStoppedError(
      'Bluetooth lab is invalidated; use a new test fixture.',
      {
        cause,
        context: { ...context, operation, operationLayer: 'playwright' },
      },
    );
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#unsubscribeInvalidation();
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    const cause = new BluetoothBackendStoppedError(
      'Bluetooth lab was disposed while waiting for a handle operation.',
      { context: { lifecycleState: 'disposed' } },
    );
    for (const peripheral of this.#peripherals.values()) {
      peripheral.dispose(cause);
    }
  }

  async #register(
    definition: PeripheralDefinition,
    preconnected: boolean,
  ): Promise<PeripheralHandle> {
    const operation = preconnected
      ? 'createPreconnectedPeripheral'
      : 'createPeripheral';
    const normalized = normalizePeripheralDefinition(definition);
    this.assertActive(operation);
    if (this.#peripherals.has(normalized.address)) {
      throw new BluetoothPeripheralAlreadyRegisteredError(
        `Bluetooth peripheral ${normalized.address} is already registered.`,
        { context: { address: normalized.address } },
      );
    }

    const state = new PeripheralHandleState(this, normalized, {
      historyLimit: this.#runtime.options.operationHistoryLimit,
      operationTimeoutMs: this.#runtime.options.operationTimeoutMs,
      scheduler: this.#scheduler,
    });
    this.#peripherals.set(normalized.address, state);
    try {
      return await this.#runtime.withBackend(
        (backend) =>
          backend.withCommandBudget(
            operation,
            'playwright',
            async (options, assertCommit) => {
              this.#ensureEventSubscription(backend);
              await backend.addPeripheral(normalized, options);
              if (preconnected)
                await backend.createPreconnectedPeripheral(normalized, options);
              assertCommit();
              this.assertActive(operation);
              this.#runtime.capturePeripheralDiagnostics(normalized);
              return state.handle;
            },
          ),
        operation,
      );
    } catch (cause) {
      if (
        this.#invalidation === undefined &&
        this.#peripherals.get(normalized.address) === state
      ) {
        this.#peripherals.delete(normalized.address);
      }
      state.dispose(cause);
      throw cause;
    }
  }

  #ensureEventSubscription(backend: BluetoothHandleBackend): void {
    if (this.#backend === backend) return;
    if (this.#backend !== undefined) {
      throw new BluetoothValidationError(
        'Bluetooth handle controller cannot switch backend instances.',
        { context: { reason: 'backend-instance-changed' } },
      );
    }
    this.#backend = backend;
    this.#unsubscribe = backend.onEvent((event) => {
      this.#receive(event, backend);
    });
  }

  #receive(
    event: BackendBluetoothEvent,
    backend: BluetoothHandleBackend,
  ): void {
    if (this.#disposed || this.#invalidation !== undefined) return;
    const copiedEvent = copyBackendBluetoothEvent(event);
    const address = eventAddress(copiedEvent);
    const peripheral = this.#peripherals.get(address);
    if (peripheral === undefined) return;
    const sequence = this.#nextSequence;
    this.#nextSequence += 1;
    const operation =
      copiedEvent.kind === 'gatt-operation'
        ? 'respondToGattOperation'
        : copiedEvent.kind === 'characteristic-operation'
          ? 'respondToCharacteristicOperation'
          : 'respondToDescriptorOperation';
    const prepared =
      copiedEvent.kind === 'gatt-operation'
        ? peripheral.prepare(copiedEvent, backend, sequence, (response) =>
            this.#scheduleResponse(backend, operation, response),
          )
        : copiedEvent.kind === 'characteristic-operation'
          ? peripheral.prepareCharacteristic(copiedEvent, backend, sequence)
          : peripheral.prepareDescriptor(copiedEvent, backend, sequence);
    if (prepared !== undefined) {
      void this.#scheduleResponse(backend, operation, prepared).catch(
        () => undefined,
      );
    }
  }

  async #scheduleResponse(
    backend: BluetoothHandleBackend,
    operation: string,
    prepared: PreparedOperation,
  ): Promise<void> {
    const previous = this.#responseChain;
    const state = { callbackEntered: false, preparedStarted: false };
    let releaseQueue: () => void = () => undefined;
    this.#responseChain = new Promise<void>((resolve) => {
      releaseQueue = resolve;
    });
    try {
      await backend.withCommandBudget(
        operation,
        'playwright',
        async (options, assertCommit) => {
          state.callbackEntered = true;
          try {
            await previous;
            if (state.preparedStarted) return;
            state.preparedStarted = true;
            await prepared(options, () => {
              assertCommit();
              this.assertActive(operation);
            });
          } finally {
            releaseQueue();
          }
        },
      );
    } catch (cause) {
      prepared.abort();
      state.preparedStarted = true;
      if (!state.callbackEntered) void previous.then(releaseQueue);
      throw cause;
    }
  }
}

function normalizePeripheralDefinition(
  definition: PeripheralDefinition,
): NormalizedPeripheral {
  const result = validatePeripheralDefinition(definition);
  if (result.success) return result.value;
  throw new BluetoothValidationError(
    'Bluetooth peripheral definition is invalid.',
    {
      context: {
        issues: result.issues.map((issue) => ({
          path: issue.path,
          code: issue.code,
          message: issue.message,
        })),
      },
    },
  );
}

function normalizeLookupUuid(value: string, field: string): BluetoothUuid {
  try {
    return normalizeBluetoothUuid(value);
  } catch (cause) {
    throw new BluetoothValidationError(
      `Bluetooth ${field} must be a valid UUID.`,
      {
        cause,
        context: { reason: 'invalid-lookup-uuid', field },
      },
    );
  }
}

function characteristicKey(
  serviceUuid: BluetoothUuid,
  characteristicUuid: BluetoothUuid,
): string {
  return `${serviceUuid}\u0000${characteristicUuid}`;
}

function eventAddress(event: BackendBluetoothEvent): BluetoothAddress {
  if (event.kind === 'gatt-operation') return event.peripheral.address;
  if (event.kind === 'characteristic-operation') {
    return event.characteristic.address;
  }
  return event.descriptor.address;
}

function copyBytes(data: ByteSource): Uint8Array {
  try {
    return bytes(data);
  } catch (cause) {
    throw new BluetoothValidationError(
      'Bluetooth response data must be a valid byte source.',
      { cause, context: { reason: 'invalid-response-bytes' } },
    );
  }
}

function assertAttError(error: unknown): asserts error is AttErrorName {
  if (attErrorNames.includes(error as AttErrorName)) return;
  throw new BluetoothValidationError(
    'Bluetooth attribute response requires a supported ATT error name.',
    { context: { reason: 'invalid-att-error', received: typeof error } },
  );
}

function assertHciError(error: unknown): asserts error is HciErrorName {
  if (hciErrorNames.includes(error as HciErrorName)) return;
  throw new BluetoothValidationError(
    'Bluetooth GATT response requires a supported HCI error name.',
    { context: { reason: 'invalid-hci-error', received: typeof error } },
  );
}

function characteristicRequest(
  event: CharacteristicOperationEvent,
): CharacteristicOperationRequest {
  if (event.type !== 'write') return Object.freeze({ type: event.type });
  return Object.freeze({
    type: event.type,
    writeType: event.writeType,
    data: new Uint8Array(event.data),
  });
}

function descriptorRequest(
  event: DescriptorOperationEvent,
): DescriptorOperationRequest {
  return event.type === 'read'
    ? Object.freeze({ type: event.type })
    : Object.freeze({ type: event.type, data: new Uint8Array(event.data) });
}

function characteristicBackendResponse(
  operationId: string,
  response: CharacteristicOperationResponseSelection,
): CharacteristicOperationResponse {
  if (response.type === 'read' && response.result === 'success') {
    return {
      operationId,
      ...response,
      data: new Uint8Array(response.data),
    };
  }
  return { operationId, ...response };
}

function descriptorBackendResponse(
  operationId: string,
  response: DescriptorOperationResponseSelection,
): DescriptorOperationResponse {
  if (response.type === 'read' && response.result === 'success') {
    return {
      operationId,
      ...response,
      data: new Uint8Array(response.data),
    };
  }
  return { operationId, ...response };
}

function clonePeripheralOperationRecord(
  record: PeripheralOperationRecord,
): PeripheralOperationRecord {
  return Object.freeze({
    ...record,
    request: Object.freeze({ ...record.request }),
    response: Object.freeze({ ...record.response }),
  });
}

function cloneCharacteristicOperationRecord(
  record: CharacteristicOperationRecord,
): CharacteristicOperationRecord {
  const request =
    record.request.type === 'write'
      ? Object.freeze({
          ...record.request,
          data: new Uint8Array(record.request.data),
        })
      : Object.freeze({ ...record.request });
  const response =
    record.response.type === 'read' && record.response.result === 'success'
      ? Object.freeze({
          ...record.response,
          data: new Uint8Array(record.response.data),
        })
      : Object.freeze({ ...record.response });
  return Object.freeze({ ...record, request, response });
}

function cloneDescriptorOperationRecord(
  record: DescriptorOperationRecord,
): DescriptorOperationRecord {
  const request =
    record.request.type === 'write'
      ? Object.freeze({
          ...record.request,
          data: new Uint8Array(record.request.data),
        })
      : Object.freeze({ ...record.request });
  const response =
    record.response.type === 'read' && record.response.result === 'success'
      ? Object.freeze({
          ...record.response,
          data: new Uint8Array(record.response.data),
        })
      : Object.freeze({ ...record.response });
  return Object.freeze({ ...record, request, response });
}

function cloneCharacteristicWrite(
  write: CharacteristicWrite,
): CharacteristicWrite {
  return Object.freeze({
    data: new Uint8Array(write.data),
    writeType: write.writeType,
  });
}

function cloneDescriptorWrite(write: DescriptorWrite): DescriptorWrite {
  return Object.freeze({ data: new Uint8Array(write.data) });
}

function createOutcomeCounters(): { success: number; error: number } {
  return { success: 0, error: 0 };
}

function createGattCounters(): Record<
  GattOperationType,
  { success: number; error: number }
> {
  return {
    connection: createOutcomeCounters(),
    discovery: createOutcomeCounters(),
  };
}

function createCharacteristicCounters(): Record<
  CharacteristicOperationEvent['type'],
  { success: number; error: number }
> {
  return {
    read: createOutcomeCounters(),
    write: createOutcomeCounters(),
    'subscribe-to-notifications': createOutcomeCounters(),
    'unsubscribe-from-notifications': createOutcomeCounters(),
  };
}

function createDescriptorCounters(): Record<
  DescriptorOperationEvent['type'],
  { success: number; error: number }
> {
  return {
    read: createOutcomeCounters(),
    write: createOutcomeCounters(),
  };
}
