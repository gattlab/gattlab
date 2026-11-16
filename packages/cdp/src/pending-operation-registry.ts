import {
  BluetoothCancelledError,
  BluetoothConcurrentOperationError,
  BluetoothTimeoutError,
  BluetoothValidationError,
  copyBackendBluetoothEvent,
  type BackendBluetoothEvent,
  type BluetoothAddress,
  type BluetoothEntityReference,
  type BluetoothTimeline,
  type CharacteristicOperationEvent,
  type CharacteristicOperationResponse,
  type DescriptorOperationEvent,
  type DescriptorOperationResponse,
  type DiagnosticValue,
  type GattOperationEvent,
  type GattOperationResponse,
} from '@gattlab/core';

type WithoutOperationId<Event> = Event extends BackendBluetoothEvent
  ? Omit<Event, 'operationId'>
  : never;

export type PendingOperationEventInput =
  WithoutOperationId<BackendBluetoothEvent>;

export interface OperationDeadline {
  /** Cancel the owned deadline callback without settling the native operation. */
  cancel(): void;
}

export interface OperationDeadlineScheduler {
  /**
   * Schedules a diagnostic deadline.
   *
   * Implementations must not invoke `onDeadline` synchronously before this
   * method returns.
   */
  schedule(deadlineMs: number, onDeadline: () => void): OperationDeadline;
}

export interface PendingOperationRegistrationOptions {
  readonly deadlineMs?: number;
  readonly timeoutContext?: Readonly<
    Record<string, null | boolean | number | string>
  >;
}

export interface PendingOperationRegistryOptions {
  readonly timeline: BluetoothTimeline;
  readonly defaultDeadlineMs: number;
  readonly deadlineScheduler: OperationDeadlineScheduler;
  readonly operationIdNamespace?: string;
  readonly terminalRetentionLimit?: number;
}

type OperationFamily = 'gatt' | 'characteristic' | 'descriptor';
type OperationEventForFamily<Family extends OperationFamily> =
  Family extends 'gatt'
    ? GattOperationEvent
    : Family extends 'characteristic'
      ? CharacteristicOperationEvent
      : DescriptorOperationEvent;
type PendingOperationState = 'pending' | 'responding' | 'awaiting-deadline';
type TerminalOperationState =
  'completed' | 'failed' | 'timed-out' | 'cancelled';

interface OperationInterruption {
  readonly state: 'timed-out' | 'cancelled';
  readonly error: BluetoothTimeoutError | BluetoothCancelledError;
}

type MutationOutcome =
  | Readonly<{ state: 'completed' }>
  | Readonly<{ state: 'failed'; cause: unknown }>
  | Readonly<{ state: 'late' }>;

interface PendingOperationRecord {
  readonly operationId: string;
  readonly key: string;
  readonly event: BackendBluetoothEvent;
  readonly family: OperationFamily;
  readonly deadlineMs: number;
  timeoutContext: Readonly<Record<string, DiagnosticValue>>;
  readonly interruption: Promise<OperationInterruption>;
  readonly interrupt: (interruption: OperationInterruption) => void;
  state: PendingOperationState | TerminalOperationState;
  deadline: OperationDeadline | undefined;
}

interface TerminalOperationRecord {
  readonly operationId: string;
  readonly key: string;
  readonly event: BackendBluetoothEvent;
  readonly family: OperationFamily;
  readonly state: TerminalOperationState;
  readonly error?: BluetoothTimeoutError | BluetoothCancelledError;
}

/**
 * Correlates synthetic operation ids without relying on absent CDP request ids.
 *
 * The registry is intentionally internal to the CDP backend. Concrete protocol
 * event and response mappings are installed by the operation handlers.
 */
export class PendingOperationRegistry {
  readonly #timeline: BluetoothTimeline;
  readonly #defaultDeadlineMs: number;
  readonly #deadlineScheduler: OperationDeadlineScheduler;
  readonly #operationIdNamespace: string;
  readonly #terminalRetentionLimit: number;
  readonly #pendingById = new Map<string, PendingOperationRecord>();
  readonly #pendingByKey = new Map<string, PendingOperationRecord>();
  readonly #terminalById = new Map<string, TerminalOperationRecord>();
  readonly #inFlightMutations = new Set<Promise<void>>();
  #nextOperationSequence = 0;

  constructor(options: PendingOperationRegistryOptions) {
    assertPositiveSafeInteger(
      options.defaultDeadlineMs,
      'Pending operation defaultDeadlineMs',
    );
    const terminalRetentionLimit =
      options.terminalRetentionLimit ?? options.timeline.limit;
    assertPositiveSafeInteger(
      terminalRetentionLimit,
      'Pending operation terminalRetentionLimit',
    );
    const namespace = options.operationIdNamespace ?? 'operation';
    if (typeof namespace !== 'string' || namespace.trim() === '') {
      throw new TypeError(
        'Pending operation operationIdNamespace must be non-empty.',
      );
    }
    const scheduler: unknown = options.deadlineScheduler;
    if (
      typeof scheduler !== 'object' ||
      scheduler === null ||
      !('schedule' in scheduler) ||
      typeof scheduler.schedule !== 'function'
    ) {
      throw new TypeError(
        'Pending operation deadlineScheduler must provide schedule().',
      );
    }

    this.#timeline = options.timeline;
    this.#defaultDeadlineMs = options.defaultDeadlineMs;
    this.#deadlineScheduler = scheduler as OperationDeadlineScheduler;
    this.#operationIdNamespace = namespace;
    this.#terminalRetentionLimit = terminalRetentionLimit;
  }

  get size(): number {
    return this.#pendingById.size;
  }

  get terminalSize(): number {
    return this.#terminalById.size;
  }

  register(
    input: PendingOperationEventInput,
    options: PendingOperationRegistrationOptions = {},
  ): BackendBluetoothEvent {
    const deadlineMs = options.deadlineMs ?? this.#defaultDeadlineMs;
    assertPositiveSafeInteger(deadlineMs, 'Pending operation deadlineMs');
    const family = operationFamily(input);
    const key = operationKey(input);
    const entity = operationEntity(input);
    const existing = this.#pendingByKey.get(key);
    if (existing !== undefined) {
      this.#timeline.append({
        category: operationCategory(input),
        type: 'operation-concurrency-rejected',
        entity,
        status: 'failed',
        data: {
          operationKey: key,
          operationKind: family,
          operationType: input.type,
          pendingOperationId: existing.operationId,
        },
      });
      throw new BluetoothConcurrentOperationError(
        `A ${family} ${input.type} operation is already pending for this entity.`,
        {
          context: {
            ...operationEntityContext(entity),
            operationKey: key,
            operationKind: family,
            operationType: input.type,
            pendingOperationId: existing.operationId,
          },
        },
      );
    }

    const operationId = this.#nextOperationId();
    const event = copyBackendBluetoothEvent({ ...input, operationId });
    const timeoutContext = Object.freeze({ ...(options.timeoutContext ?? {}) });
    const interruption = createDeferred<OperationInterruption>();
    const record: PendingOperationRecord = {
      operationId,
      key,
      event,
      family,
      deadlineMs,
      timeoutContext,
      interruption: interruption.promise,
      interrupt: interruption.resolve,
      state: 'pending',
      deadline: undefined,
    };

    this.#timeline.append({
      category: operationCategory(event),
      type: 'operation-received',
      entity: operationEntity(event),
      operationId,
      status: 'requested',
      data: operationTimelineData(record),
    });
    this.#pendingById.set(operationId, record);
    this.#pendingByKey.set(key, record);

    try {
      const deadline: unknown = this.#deadlineScheduler.schedule(
        deadlineMs,
        () => {
          this.#timeOut(record);
        },
      );
      if (
        typeof deadline !== 'object' ||
        deadline === null ||
        !('cancel' in deadline) ||
        typeof deadline.cancel !== 'function'
      ) {
        throw new TypeError(
          'Pending operation deadlineScheduler.schedule() must return a cancellable deadline.',
        );
      }
      record.deadline = deadline as OperationDeadline;
    } catch (cause) {
      this.#pendingById.delete(operationId);
      this.#pendingByKey.delete(key);
      this.#timeline.append({
        category: operationCategory(event),
        type: 'operation-registration-failed',
        entity: operationEntity(event),
        operationId,
        status: 'failed',
        data: operationTimelineData(record),
      });
      throw cause;
    }

    if (!this.#pendingById.has(operationId)) return event;

    this.#timeline.append({
      category: operationCategory(event),
      type: 'operation-pending',
      entity: operationEntity(event),
      operationId,
      status: 'pending',
      data: operationTimelineData(record),
    });
    return event;
  }

  respondToGattOperation(
    response: GattOperationResponse,
    mutation: (event: GattOperationEvent) => Promise<void>,
  ): Promise<void> {
    return this.#respond('gatt', response, mutation);
  }

  respondToCharacteristicOperation(
    response: CharacteristicOperationResponse,
    mutation: (event: CharacteristicOperationEvent) => Promise<void>,
  ): Promise<void> {
    return this.#respond('characteristic', response, mutation);
  }

  respondToDescriptorOperation(
    response: DescriptorOperationResponse,
    mutation: (event: DescriptorOperationEvent) => Promise<void>,
  ): Promise<void> {
    return this.#respond('descriptor', response, mutation);
  }

  cancel(operationId: string, reason: string): boolean {
    assertCancellationReason(reason);
    const record = this.#pendingById.get(operationId);
    if (record === undefined) return false;
    this.#cancelRecord(record, reason);
    return true;
  }

  cancelForPeripheral(address: BluetoothAddress, reason: string): number {
    return this.#cancelMatching(
      (record) => operationEntity(record.event).address === address,
      reason,
    );
  }

  cancelAll(reason: string): number {
    return this.#cancelMatching(() => true, reason);
  }

  /** Waits until every currently in-flight protocol mutation has settled. */
  async settled(): Promise<void> {
    const mutations = [...this.#inFlightMutations];
    if (mutations.length === 0) return;
    await Promise.all(mutations);
    return this.settled();
  }

  async #respond<Family extends OperationFamily>(
    family: Family,
    response:
      | GattOperationResponse
      | CharacteristicOperationResponse
      | DescriptorOperationResponse,
    mutation: (event: OperationEventForFamily<Family>) => Promise<void>,
  ): Promise<void> {
    if (typeof mutation !== 'function') {
      throw new TypeError(
        'Pending operation response mutation must be a function.',
      );
    }
    const terminal = this.#terminalById.get(response.operationId);
    if (terminal !== undefined) {
      this.#recordLateResponseAttempt(terminal, family, response.type);
      if (terminal.error !== undefined) throw terminal.error;
      throw settledOperationError(terminal, family, response.type);
    }

    const record = this.#pendingById.get(response.operationId);
    if (record === undefined) {
      throw new BluetoothValidationError(
        `Bluetooth operation id ${response.operationId} is unknown.`,
        {
          context: {
            operationId: response.operationId,
            receivedOperationKind: family,
            receivedOperationType: response.type,
            reason: 'unknown-operation-id',
          },
        },
      );
    }
    if (record.state !== 'pending') {
      throw new BluetoothValidationError(
        `Bluetooth operation ${response.operationId} already has a response in flight.`,
        {
          context: {
            ...operationContext(record),
            receivedOperationKind: family,
            receivedOperationType: response.type,
            reason: 'response-in-flight',
          },
        },
      );
    }
    if (record.family !== family) {
      throw mismatchedOperationError(
        record,
        family,
        response.type,
        'operation-kind-mismatch',
      );
    }
    if (record.event.type !== response.type) {
      throw mismatchedOperationError(
        record,
        family,
        response.type,
        'operation-type-mismatch',
      );
    }

    record.state = 'responding';
    this.#timeline.append({
      category: operationCategory(record.event),
      type: 'operation-response',
      entity: operationEntity(record.event),
      operationId: record.operationId,
      status: 'requested',
      data: operationTimelineData(record),
    });

    const awaitDiagnosticDeadline = requiresDiagnosticDeadline(
      family,
      response,
    );
    const mutationOutcome = Promise.resolve()
      .then(() => mutation(record.event as OperationEventForFamily<Family>))
      .then<MutationOutcome | OperationInterruption, MutationOutcome>(
        () => this.#completeProtocolMutation(record, awaitDiagnosticDeadline),
        (cause: unknown) => this.#finishMutation(record, cause),
      );
    this.#trackMutation(mutationOutcome);
    const outcome = await Promise.race([mutationOutcome, record.interruption]);
    if ('error' in outcome) throw outcome.error;
    if (outcome.state === 'failed') throw outcome.cause;
  }

  #completeProtocolMutation(
    record: PendingOperationRecord,
    awaitDiagnosticDeadline: boolean,
  ): MutationOutcome | Promise<OperationInterruption> {
    if (!awaitDiagnosticDeadline || record.state !== 'responding') {
      return this.#finishMutation(record);
    }

    record.state = 'awaiting-deadline';
    record.timeoutContext = Object.freeze({
      ...record.timeoutContext,
      responseDelivered: true,
      responseResult: 'error',
      knownLimitation: 'unsuccessful-discovery-does-not-settle',
    });
    this.#timeline.append({
      category: operationCategory(record.event),
      type: 'operation-response',
      entity: operationEntity(record.event),
      operationId: record.operationId,
      status: 'succeeded',
      data: {
        ...operationTimelineData(record),
        awaitingDiagnosticDeadline: true,
      },
    });
    return record.interruption;
  }

  #finishMutation(
    record: PendingOperationRecord,
    ...failure: readonly [unknown?]
  ): MutationOutcome {
    if (record.state === 'timed-out' || record.state === 'cancelled') {
      this.#timeline.append({
        category: operationCategory(record.event),
        type: 'operation-late-completion',
        entity: operationEntity(record.event),
        operationId: record.operationId,
        status: record.state,
        data: {
          ...operationTimelineData(record),
          completion:
            failure.length === 0 ? 'protocol-success' : 'protocol-failure',
          terminalState: record.state,
        },
      });
      return Object.freeze({ state: 'late' });
    }

    record.deadline?.cancel();
    const failed = failure.length > 0;
    record.state = failed ? 'failed' : 'completed';
    this.#removePending(record);
    this.#rememberTerminal(record);
    this.#timeline.append({
      category: operationCategory(record.event),
      type: 'operation-response',
      entity: operationEntity(record.event),
      operationId: record.operationId,
      status: failed ? 'failed' : 'succeeded',
      data: operationTimelineData(record),
    });
    return failed
      ? Object.freeze({ state: 'failed', cause: failure[0] })
      : Object.freeze({ state: 'completed' });
  }

  #timeOut(record: PendingOperationRecord): void {
    if (
      record.state !== 'pending' &&
      record.state !== 'responding' &&
      record.state !== 'awaiting-deadline'
    ) {
      return;
    }
    const responseAwaitedApplicationSettlement =
      record.state === 'awaiting-deadline';
    const error = new BluetoothTimeoutError(
      responseAwaitedApplicationSettlement
        ? `Bluetooth ${record.family} ${record.event.type} response was accepted by Chromium, but the application promise did not settle within its ${String(record.deadlineMs)} ms diagnostic deadline.`
        : `Bluetooth ${record.family} ${record.event.type} operation exceeded its ${String(record.deadlineMs)} ms diagnostic deadline.`,
      { context: operationContext(record) },
    );
    record.state = 'timed-out';
    this.#removePending(record);
    this.#rememberTerminal(record, error);
    this.#timeline.append({
      category: operationCategory(record.event),
      type: 'operation-timeout',
      entity: operationEntity(record.event),
      operationId: record.operationId,
      status: 'timed-out',
      data: operationTimelineData(record),
    });
    record.interrupt(Object.freeze({ state: 'timed-out', error }));
  }

  #cancelRecord(record: PendingOperationRecord, reason: string): void {
    if (
      record.state !== 'pending' &&
      record.state !== 'responding' &&
      record.state !== 'awaiting-deadline'
    ) {
      return;
    }
    const error = new BluetoothCancelledError(
      `Bluetooth ${record.family} ${record.event.type} operation was cancelled: ${reason}.`,
      {
        context: {
          ...operationContext(record),
          cancellationReason: reason,
        },
      },
    );
    record.deadline?.cancel();
    record.state = 'cancelled';
    this.#removePending(record);
    this.#rememberTerminal(record, error);
    this.#timeline.append({
      category: operationCategory(record.event),
      type: 'operation-cancelled',
      entity: operationEntity(record.event),
      operationId: record.operationId,
      status: 'cancelled',
      data: {
        ...operationTimelineData(record),
        cancellationReason: reason,
      },
    });
    record.interrupt(Object.freeze({ state: 'cancelled', error }));
  }

  #cancelMatching(
    predicate: (record: PendingOperationRecord) => boolean,
    reason: string,
  ): number {
    assertCancellationReason(reason);
    const matches = [...this.#pendingById.values()].filter(predicate);
    for (const record of matches) this.#cancelRecord(record, reason);
    return matches.length;
  }

  #trackMutation(mutation: Promise<unknown>): void {
    const tracked = mutation.then(
      () => undefined,
      () => undefined,
    );
    this.#inFlightMutations.add(tracked);
    void tracked.then(() => {
      this.#inFlightMutations.delete(tracked);
    });
  }

  #recordLateResponseAttempt(
    terminal: TerminalOperationRecord,
    family: OperationFamily,
    type: string,
  ): void {
    if (terminal.state !== 'timed-out' && terminal.state !== 'cancelled')
      return;
    this.#timeline.append({
      category: operationCategory(terminal.event),
      type: 'operation-late-completion',
      entity: operationEntity(terminal.event),
      operationId: terminal.operationId,
      status: terminal.state,
      data: {
        operationKey: terminal.key,
        operationKind: terminal.family,
        operationType: terminal.event.type,
        completion: 'response-attempt',
        receivedOperationKind: family,
        receivedOperationType: type,
        terminalState: terminal.state,
      },
    });
  }

  #removePending(record: PendingOperationRecord): void {
    this.#pendingById.delete(record.operationId);
    this.#pendingByKey.delete(record.key);
  }

  #rememberTerminal(
    record: PendingOperationRecord,
    error?: BluetoothTimeoutError | BluetoothCancelledError,
  ): void {
    const terminal: TerminalOperationRecord = Object.freeze({
      operationId: record.operationId,
      key: record.key,
      event: record.event,
      family: record.family,
      state: record.state as TerminalOperationState,
      ...(error === undefined ? {} : { error }),
    });
    this.#terminalById.set(record.operationId, terminal);
    while (this.#terminalById.size > this.#terminalRetentionLimit) {
      const oldest = this.#terminalById.keys().next().value;
      if (oldest === undefined) break;
      this.#terminalById.delete(oldest);
    }
  }

  #nextOperationId(): string {
    if (this.#nextOperationSequence === Number.MAX_SAFE_INTEGER) {
      throw new RangeError('Pending operation id sequence is exhausted.');
    }
    this.#nextOperationSequence += 1;
    return `${this.#operationIdNamespace}:${String(this.#nextOperationSequence)}`;
  }
}

function assertPositiveSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer.`);
  }
}

function assertCancellationReason(reason: string): void {
  if (typeof reason !== 'string' || reason === '') {
    throw new TypeError(
      'Pending operation cancellation reason must be non-empty.',
    );
  }
}

function requiresDiagnosticDeadline(
  family: OperationFamily,
  response:
    | GattOperationResponse
    | CharacteristicOperationResponse
    | DescriptorOperationResponse,
): boolean {
  return (
    family === 'gatt' &&
    response.type === 'discovery' &&
    response.result === 'error'
  );
}

function operationFamily(
  event: PendingOperationEventInput | BackendBluetoothEvent,
): OperationFamily {
  switch (event.kind) {
    case 'gatt-operation':
      return 'gatt';
    case 'characteristic-operation':
      return 'characteristic';
    case 'descriptor-operation':
      return 'descriptor';
  }
}

function createDeferred<Value>(): Readonly<{
  promise: Promise<Value>;
  resolve: (value: Value) => void;
}> {
  let resolvePromise: (value: Value) => void = () => {
    throw new TypeError('Pending operation deferred was not initialized.');
  };
  const promise = new Promise<Value>((resolve) => {
    resolvePromise = resolve;
  });
  return Object.freeze({ promise, resolve: resolvePromise });
}

function operationCategory(
  event: PendingOperationEventInput | BackendBluetoothEvent,
): 'gatt' | 'characteristic' | 'descriptor' {
  return operationFamily(event);
}

function operationEntity(
  event: PendingOperationEventInput | BackendBluetoothEvent,
): BluetoothEntityReference {
  switch (event.kind) {
    case 'gatt-operation':
      return event.peripheral;
    case 'characteristic-operation':
      return event.characteristic;
    case 'descriptor-operation':
      return event.descriptor;
  }
}

function operationKey(
  event: PendingOperationEventInput | BackendBluetoothEvent,
): string {
  const entity = operationEntity(event);
  switch (entity.kind) {
    case 'peripheral':
      return `gatt:${entity.address}:${event.type}`;
    case 'characteristic':
      return `characteristic:${entity.address}:${entity.serviceUuid}:${entity.characteristicUuid}:${event.type}`;
    case 'descriptor':
      return `descriptor:${entity.address}:${entity.serviceUuid}:${entity.characteristicUuid}:${entity.descriptorUuid}:${event.type}`;
    case 'service':
      throw new TypeError('Services cannot own pending Bluetooth operations.');
  }
}

function operationEntityContext(
  entity: BluetoothEntityReference,
): Readonly<Record<string, DiagnosticValue>> {
  switch (entity.kind) {
    case 'peripheral':
      return { entityKind: entity.kind, address: entity.address };
    case 'service':
      return {
        entityKind: entity.kind,
        address: entity.address,
        serviceUuid: entity.serviceUuid,
      };
    case 'characteristic':
      return {
        entityKind: entity.kind,
        address: entity.address,
        serviceUuid: entity.serviceUuid,
        characteristicUuid: entity.characteristicUuid,
      };
    case 'descriptor':
      return {
        entityKind: entity.kind,
        address: entity.address,
        serviceUuid: entity.serviceUuid,
        characteristicUuid: entity.characteristicUuid,
        descriptorUuid: entity.descriptorUuid,
      };
  }
}

function operationTimelineData(
  record: PendingOperationRecord,
): Readonly<Record<string, DiagnosticValue>> {
  return {
    ...record.timeoutContext,
    operationKey: record.key,
    operationKind: record.family,
    operationType: record.event.type,
    deadlineMs: record.deadlineMs,
  };
}

function operationContext(
  record: PendingOperationRecord,
): Readonly<Record<string, DiagnosticValue>> {
  return {
    ...record.timeoutContext,
    ...operationEntityContext(operationEntity(record.event)),
    operationId: record.operationId,
    operationKey: record.key,
    operationKind: record.family,
    operationType: record.event.type,
    deadlineMs: record.deadlineMs,
  };
}

function mismatchedOperationError(
  record: PendingOperationRecord,
  receivedFamily: OperationFamily,
  receivedType: string,
  reason: 'operation-kind-mismatch' | 'operation-type-mismatch',
): BluetoothValidationError {
  return new BluetoothValidationError(
    `Bluetooth operation ${record.operationId} does not match the supplied response.`,
    {
      context: {
        ...operationContext(record),
        receivedOperationKind: receivedFamily,
        receivedOperationType: receivedType,
        reason,
      },
    },
  );
}

function settledOperationError(
  terminal: TerminalOperationRecord,
  receivedFamily: OperationFamily,
  receivedType: string,
): BluetoothValidationError {
  return new BluetoothValidationError(
    `Bluetooth operation ${terminal.operationId} is already settled.`,
    {
      context: {
        operationId: terminal.operationId,
        operationKey: terminal.key,
        operationKind: terminal.family,
        operationType: terminal.event.type,
        receivedOperationKind: receivedFamily,
        receivedOperationType: receivedType,
        terminalState: terminal.state,
        reason: 'settled-operation-id',
      },
    },
  );
}
