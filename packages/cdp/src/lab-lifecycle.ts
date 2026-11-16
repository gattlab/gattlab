import {
  BluetoothBackendStoppedError,
  BluetoothCancelledError,
  BluetoothTimeoutError,
  type BackendCallOptions,
  type BluetoothTimeline,
  type CentralState,
  type MonotonicClock,
} from '@gattlab/core';
import type { OperationDeadlineScheduler } from './pending-operation-registry.js';
import { CdpTransportError, type CdpTransport } from './transport.js';

export type CdpOperationLayer = 'cdp' | 'playwright';

/** Immutable first terminal evidence; cause is retained separately from payload-free diagnostic fields. */
export interface CdpLabInvalidation {
  readonly reason:
    'adapter-lost' | 'fixture-page-closed' | 'model-outcome-unknown';
  readonly lifecycleState: 'invalidated';
  readonly operation: string;
  readonly operationLayer: CdpOperationLayer;
  readonly detectedBy:
    | 'command-rejection'
    | 'liveness-check'
    | 'fixture-page-close'
    | 'model-operation-aborted';
  readonly boundary:
    'fixture-document-changed' | 'fixture-page-closed' | 'unobserved';
  readonly remediation: 'new-test-fixture';
  readonly cause?: unknown;
}

// The default watchdog retains the conservative floor above the measured allowance.
export const defaultCommandDeadlineMs = 30000;

/** Bounded secondary health-check evidence; the primary timeout retains its original cause. */
export interface CdpDeadlineCheckEvidence {
  readonly timeoutPhase: 'deadline-check';
  readonly deadlineKind: 'command';
  readonly deadlineMs: number;
  readonly detection: 'check-failed' | 'check-timed-out' | 'unconfirmed';
  readonly cause: unknown;
}

/** Structural timeout enrichment produced by started-backend checks, without a new error class. */
export type CdpCommandTimeout = BluetoothTimeoutError & {
  readonly deadlineCheck?: CdpDeadlineCheckEvidence;
};

type Detection =
  'not-checked' | 'live' | 'check-failed' | 'check-timed-out' | 'unconfirmed';
type Phase = 'operation' | 'entry-check';
const consumerOperations = Object.freeze([
  'createPeripheral',
  'createPreconnectedPeripheral',
  'setState',
  'waitForDevicePrompt',
  'advertise',
  'disconnect',
  'characteristic',
  'descriptor',
  'expectRead',
  'expectSubscription',
  'expectUnsubscription',
  'waitForWrite',
  'queue',
  'queueSuccess',
  'queueError',
  'select',
  'selectById',
  'cancel',
  'setCentralState',
  'addPeripheral',
  'simulateAdvertisement',
  'respondToGattOperation',
  'respondToCharacteristicOperation',
  'respondToDescriptorOperation',
  'onEvent',
]);
function assertConsumerOperation(operation: string): void {
  if (!consumerOperations.includes(operation))
    throw new TypeError(
      'CDP integration requires an exact public consumer operation name.',
    );
}

/** Instance-owned usability, command budgets and underlying state-command serialization. */
export class CdpLabLifecycle {
  readonly #transport: CdpTransport<'browser'>;
  readonly #scheduler: OperationDeadlineScheduler;
  readonly #clock: MonotonicClock;
  readonly #timeline: BluetoothTimeline;
  readonly #invalidate: () => void;
  readonly #getState: () => string;
  readonly #listeners = new Set<(record: CdpLabInvalidation) => void>();
  readonly #scopes = new WeakMap<BackendCallOptions, CdpCommandScope>();
  readonly #active = new Set<CdpCommandScope>();
  readonly commandDeadlineMs: number;
  #terminal: CdpLabInvalidation | undefined;
  #stopped = false;
  #documentChanged = false;
  #state: CentralState;
  #stateTail: Promise<void> = Promise.resolve();
  #statePending = 0;

  constructor(options: {
    transport: CdpTransport<'browser'>;
    scheduler: OperationDeadlineScheduler;
    clock: MonotonicClock;
    timeline: BluetoothTimeline;
    commandDeadlineMs: number;
    centralState: CentralState;
    invalidate: () => void;
    getState?: () => string;
  }) {
    this.#transport = options.transport;
    this.#scheduler = options.scheduler;
    this.#clock = options.clock;
    this.#timeline = options.timeline;
    this.#state = options.centralState;
    this.#invalidate = options.invalidate;
    this.#getState =
      options.getState ?? (() => (this.#stopped ? 'stopping' : 'started'));
    this.commandDeadlineMs = options.commandDeadlineMs;
  }

  get centralState(): CentralState {
    return this.#state;
  }
  get centralStateBlocked(): boolean {
    return this.#statePending > 0;
  }
  get stopped(): boolean {
    return this.#stopped;
  }
  get terminal(): CdpLabInvalidation | undefined {
    return this.#terminal;
  }

  assertUsable(
    operation: string,
    operationLayer: CdpOperationLayer = 'cdp',
  ): void {
    assertConsumerOperation(operation);
    if (this.#terminal)
      throw invalidationError(this.#terminal, operation, operationLayer);
    if (this.#stopped)
      throw new BluetoothBackendStoppedError(
        'The Bluetooth backend has stopped.',
        { context: { operation, state: this.#getState() } },
      );
  }

  onInvalidated(listener: (record: CdpLabInvalidation) => void): () => void {
    if (typeof listener !== 'function')
      throw new TypeError('Invalidation listener must be a function.');
    if (this.#terminal) listener(this.#terminal);
    else this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  noteFixtureDocumentChanged(): void {
    this.#documentChanged = true;
  }

  invalidateFixturePage(operationLayer: CdpOperationLayer = 'cdp'): void {
    this.invalidate(
      'fixture-page-closed',
      'waitForDevicePrompt',
      operationLayer,
      'fixture-page-close',
    );
  }

  invalidate(
    reason: CdpLabInvalidation['reason'],
    operation: string,
    operationLayer: CdpOperationLayer,
    detectedBy: CdpLabInvalidation['detectedBy'],
    cause?: unknown,
  ): void {
    if (this.#terminal || this.#stopped) return;
    const record: CdpLabInvalidation = Object.freeze({
      reason,
      lifecycleState: 'invalidated',
      operation,
      operationLayer,
      detectedBy,
      boundary:
        reason === 'fixture-page-closed'
          ? 'fixture-page-closed'
          : this.#documentChanged
            ? 'fixture-document-changed'
            : 'unobserved',
      remediation: 'new-test-fixture',
      ...(cause === undefined ? {} : { cause }),
    });
    this.#terminal = record;
    const { cause: firstCause, ...context } = record;
    this.diagnostic('lab-invalidated', {
      ...context,
      causeType: firstCause instanceof Error ? firstCause.name : 'none',
    });
    for (const scope of this.#active) scope.rejectTerminal(record);
    for (const listener of [...this.#listeners]) {
      try {
        listener(record);
      } catch {
        /* One observer cannot prevent terminal propagation. */
      }
    }
    this.#listeners.clear();
    this.#invalidate();
  }

  stop(): void {
    this.#stopped = true;
  }

  withBudget<T>(
    operation: string,
    layer: CdpOperationLayer,
    work: (options: BackendCallOptions, assertCommit: () => void) => Promise<T>,
    options?: BackendCallOptions,
  ): Promise<T> {
    this.assertUsable(operation, layer);
    options?.cancellation?.throwIfCancelled();
    const existing = options && this.#scopes.get(options);
    if (existing) {
      existing.assertCommittable();
      return work(options, () => {
        existing.assertCommittable();
      });
    }
    const scope = this.createScope(operation, layer, 'operation', options);
    const token: BackendCallOptions = Object.freeze({
      ...(options?.cancellation ? { cancellation: options.cancellation } : {}),
    });
    this.#scopes.set(token, scope);
    // Keep the expired token as an instance-owned weak tombstone. A late
    // continuation must find its original ended budget, never start a new one.
    return scope.run(() =>
      work(token, () => {
        scope.assertCommittable();
      }),
    );
  }

  scope(options: BackendCallOptions): CdpCommandScope {
    const scope = this.#scopes.get(options);
    if (!scope)
      throw new TypeError('Command budget is not owned by this backend.');
    return scope;
  }

  createScope(
    operation: string,
    layer: CdpOperationLayer,
    phase: Phase,
    options?: BackendCallOptions,
  ): CdpCommandScope {
    const scope = new CdpCommandScope(
      this,
      operation,
      layer,
      phase,
      this.#scheduler,
      this.#clock,
      options,
    );
    this.#active.add(scope);
    return scope;
  }

  release(scope: CdpCommandScope): void {
    this.#active.delete(scope);
  }

  async checkLiveness(
    operation: string,
    layer: CdpOperationLayer = 'cdp',
  ): Promise<void> {
    this.assertUsable(operation, layer);
    const scope = this.createScope(operation, layer, 'entry-check');
    await scope.run(() => this.stateCommand(scope));
  }

  async stateCommand(
    scope: CdpCommandScope,
    state?: CentralState,
  ): Promise<void> {
    scope.entryCheck = state === undefined;
    const previous = this.#stateTail;
    const command = previous.then(async () => {
      scope.assertCommittable();
      this.#statePending += 1;
      scope.checkIssued = state === undefined;
      try {
        const next = state ?? this.#state;
        await scope.send(
          this.#transport,
          'BluetoothEmulation.setSimulatedCentralState',
          { state: next },
        );
        // A late acknowledgement commits state only while the lab is usable.
        if (!this.#terminal && !this.#stopped) this.#state = next;
      } finally {
        this.#statePending -= 1;
      }
    });
    // Serialization tracks actual protocol settlement, never public timeout/cancellation.
    this.#stateTail = command.then(
      () => undefined,
      () => undefined,
    );
    await command;
  }

  async diagnoseTimeout(
    operation: string,
    layer: CdpOperationLayer,
    timeout: BluetoothTimeoutError,
    deadlineKind:
      'application-operation' | 'prompt' | 'command' = 'application-operation',
  ): Promise<never> {
    this.assertUsable(operation, layer);
    const originalDeadlineMs: unknown = timeout.context['deadlineMs'];
    if (
      typeof originalDeadlineMs !== 'number' ||
      !Number.isSafeInteger(originalDeadlineMs) ||
      originalDeadlineMs <= 0
    )
      throw new RangeError(
        'Timeout diagnostics require the original positive safe-integer deadline.',
      );
    this.diagnostic('operation-timeout', {
      operation,
      operationLayer: layer,
      timeoutPhase: 'operation',
      deadlineKind,
      deadlineMs: originalDeadlineMs,
      checkDeadlineMs: this.commandDeadlineMs,
      commandOutcome: 'unknown',
    });
    let detection: Detection = 'live';
    let blocked = false;
    let checkFailure: unknown;
    try {
      await this.checkLiveness(operation, layer);
    } catch (cause) {
      checkFailure = cause;
      this.assertUsable(operation, layer);
      if (cause instanceof BluetoothTimeoutError) {
        blocked = cause.context['centralStateBlocked'] === true;
        detection = blocked ? 'unconfirmed' : 'check-timed-out';
      } else detection = 'check-failed';
      this.diagnostic('deadline-check', {
        operation,
        operationLayer: layer,
        deadlineKind: 'command',
        deadlineMs: this.commandDeadlineMs,
        detection,
        centralStateBlocked: blocked,
        reason: cause instanceof Error ? cause.name : 'unknown-error',
      });
    }
    const result = this.timeout(
      operation,
      layer,
      Number(timeout.context['deadlineMs']),
      'operation',
      deadlineKind,
      detection,
      blocked,
      timeout,
    );
    if (checkFailure !== undefined)
      Object.defineProperty(result, 'deadlineCheck', {
        value: Object.freeze({
          timeoutPhase: 'deadline-check',
          deadlineKind: 'command',
          deadlineMs: this.commandDeadlineMs,
          detection,
          cause: checkFailure,
        }),
      });
    throw result;
  }

  timeout(
    operation: string,
    operationLayer: CdpOperationLayer,
    deadlineMs: number,
    timeoutPhase: Phase,
    deadlineKind: 'command' | 'application-operation' | 'prompt',
    detection: Detection = 'not-checked',
    centralStateBlocked = false,
    cause?: BluetoothTimeoutError,
  ): BluetoothTimeoutError {
    return new BluetoothTimeoutError(
      `Bluetooth ${operation} exceeded its ${deadlineKind} deadline (${String(deadlineMs)} ms). Its outcome may be unknown.`,
      {
        ...(cause ? { cause } : {}),
        context: {
          ...(cause?.context ?? {}),
          operation,
          operationLayer,
          deadlineMs,
          timeoutPhase,
          deadlineKind,
          checkDeadlineMs: this.commandDeadlineMs,
          detection,
          centralStateBlocked,
          remediation: centralStateBlocked
            ? 'dispose-lab'
            : 'inspect-operation',
        },
      },
    );
  }

  recognize(cause: unknown, scope: CdpCommandScope): void {
    if (this.#stopped || !isMissingBinding(cause)) return;
    this.invalidate(
      'adapter-lost',
      scope.operation,
      scope.layer,
      scope.entryCheck ? 'liveness-check' : 'command-rejection',
      cause,
    );
  }

  diagnostic(
    type: string,
    data: Readonly<Record<string, string | number | boolean>>,
  ): void {
    try {
      this.#timeline.append({
        category: 'diagnostic',
        type,
        status: 'failed',
        data,
      });
    } catch {
      /* Primary outcomes do not depend on diagnostics. */
    }
  }
}

/** Internal one-call budget, including queueing and all nested commands. */
export class CdpCommandScope {
  readonly #owner: CdpLabLifecycle;
  readonly operation: string;
  readonly layer: CdpOperationLayer;
  readonly #phase: Phase;
  readonly #scheduler: OperationDeadlineScheduler;
  readonly #clock: MonotonicClock;
  readonly #options: BackendCallOptions | undefined;
  readonly #startedAt: number;
  #expired = false;
  #finished = false;
  #modelEffects = false;
  #reject: ((cause: unknown) => void) | undefined;
  entryCheck = false;
  checkIssued = false;

  constructor(
    owner: CdpLabLifecycle,
    operation: string,
    layer: CdpOperationLayer,
    phase: Phase,
    scheduler: OperationDeadlineScheduler,
    clock: MonotonicClock,
    options?: BackendCallOptions,
  ) {
    this.#owner = owner;
    this.operation = operation;
    this.layer = layer;
    this.#phase = phase;
    this.#scheduler = scheduler;
    this.#clock = clock;
    this.#options = options;
    this.#startedAt = clock.now();
  }

  get model(): boolean {
    return [
      'addPeripheral',
      'createPeripheral',
      'createPreconnectedPeripheral',
      'disconnect',
    ].includes(this.operation);
  }
  markModelEffect(): void {
    this.assertCommittable();
    if (this.model) this.#modelEffects = true;
  }

  assertCommittable(): void {
    this.#options?.cancellation?.throwIfCancelled();
    this.#owner.assertUsable(this.operation, this.layer);
    if (
      this.#expired ||
      this.#clock.now() - this.#startedAt >= this.#owner.commandDeadlineMs
    ) {
      this.#expired = true;
      const timeout = this.#timeout();
      if (this.model && this.#modelEffects) {
        this.#owner.invalidate(
          'model-outcome-unknown',
          this.operation,
          this.layer,
          'model-operation-aborted',
          timeout,
        );
        this.#owner.assertUsable(this.operation, this.layer);
      }
      throw timeout;
    }
    if (this.#finished)
      throw new BluetoothCancelledError(
        'The Bluetooth command phase has ended.',
        { context: { operation: this.operation } },
      );
  }

  async send<
    Target extends 'browser' | 'page',
    Method extends Parameters<CdpTransport<Target>['send']>[0],
  >(
    transport: CdpTransport<Target>,
    method: Method,
    ...args: import('./transport.js').CdpCommandArguments<Method>
  ): Promise<import('./transport.js').CdpCommandResult<Method>> {
    this.assertCommittable();
    this.markModelEffect();
    const sent = transport.send(method, ...args);
    void sent.then(
      () => {
        if (this.#expired || this.#finished)
          this.#owner.diagnostic('command-late-completion', {
            operation: this.operation,
            operationLayer: this.layer,
            completion: 'protocol-success',
          });
      },
      (cause: unknown) => {
        if (this.#expired || this.#finished)
          this.#owner.diagnostic('command-late-completion', {
            operation: this.operation,
            operationLayer: this.layer,
            completion: 'protocol-failure',
            reason: cause instanceof Error ? cause.name : 'unknown-error',
          });
      },
    );
    try {
      return await sent;
    } catch (cause) {
      this.#owner.recognize(cause, this);
      if (this.#owner.terminal)
        this.#owner.assertUsable(this.operation, this.layer);
      throw cause;
    }
  }

  sender<Target extends 'browser' | 'page'>(
    transport: CdpTransport<Target>,
  ): Pick<CdpTransport<Target>, 'send'> {
    return {
      send: <
        Method extends import('./transport.js').BluetoothCdpCommand<Target>,
      >(
        method: Method,
        ...args: import('./transport.js').CdpCommandArguments<Method>
      ) => this.send(transport, method, ...args),
    };
  }

  async run<T>(work: () => Promise<T>): Promise<T> {
    let reject!: (cause: unknown) => void;
    const interruption = new Promise<never>((_resolve, rejectPromise) => {
      reject = rejectPromise;
    });
    this.#reject = reject;
    const unsubscribe =
      this.#options?.cancellation?.onCancelled(() => {
        let cause: unknown = new BluetoothCancelledError(
          'Bluetooth operation was cancelled.',
          { context: { operation: this.operation } },
        );
        try {
          this.#options?.cancellation?.throwIfCancelled();
        } catch (error) {
          const legacyOperation =
            this.operation === 'setCentralState'
              ? 'central-state'
              : this.operation;
          cause = new BluetoothCancelledError(
            'Bluetooth operation was cancelled.',
            {
              cause: error,
              context: {
                operation: legacyOperation,
                ...(this.operation.startsWith('respondTo')
                  ? { cancellationReason: 'caller-cancelled' }
                  : {}),
              },
            },
          );
        }
        reject(cause);
        if (this.model && this.#modelEffects)
          this.#owner.invalidate(
            'model-outcome-unknown',
            this.operation,
            this.layer,
            'model-operation-aborted',
            cause,
          );
      }) ?? (() => undefined);
    const deadline = this.#scheduler.schedule(
      this.#owner.commandDeadlineMs,
      () => {
        if (this.#finished) return;
        this.#expired = true;
        const timeout = this.#timeout();
        if (this.model && this.#modelEffects) {
          this.#owner.invalidate(
            'model-outcome-unknown',
            this.operation,
            this.layer,
            'model-operation-aborted',
            timeout,
          );
          try {
            this.#owner.assertUsable(this.operation, this.layer);
          } catch (cause) {
            reject(cause);
          }
        } else reject(timeout);
      },
    );
    const completion = (async () => {
      this.assertCommittable();
      const value = await work();
      if (!this.#owner.stopped || this.model || this.#owner.terminal)
        this.assertCommittable();
      else this.#options?.cancellation?.throwIfCancelled();
      return value;
    })();
    void completion.then(
      () => {
        if (this.#expired)
          this.#owner.diagnostic('backend-call-late-completion', {
            operation: this.operation,
            operationLayer: this.layer,
            completion: 'protocol-success',
          });
      },
      (cause: unknown) => {
        if (this.#expired || this.#finished)
          this.#owner.diagnostic('backend-call-late-completion', {
            operation: this.operation,
            operationLayer: this.layer,
            completion: 'operation-completion-rejected',
            reason: cause instanceof Error ? cause.name : 'unknown-error',
          });
      },
    );
    try {
      return await Promise.race([completion, interruption]);
    } catch (cause) {
      if (
        cause instanceof BluetoothTimeoutError &&
        (cause.context['detection'] === undefined ||
          cause.context['detection'] === 'not-checked') &&
        this.#phase === 'operation' &&
        !this.entryCheck &&
        !this.model
      )
        return await this.#owner.diagnoseTimeout(
          this.operation,
          this.layer,
          cause,
          this.#expired ? 'command' : 'application-operation',
        );
      throw cause;
    } finally {
      this.#finished = true;
      deadline.cancel();
      unsubscribe();
      this.#owner.release(this);
    }
  }

  rejectTerminal(record: CdpLabInvalidation): void {
    this.#reject?.(invalidationError(record, this.operation, this.layer));
  }
  rejectStopped(): void {
    try {
      this.#owner.assertUsable(this.operation, this.layer);
    } catch (cause) {
      this.#reject?.(cause);
    }
  }

  #timeout(): BluetoothTimeoutError {
    const blocked =
      this.entryCheck && !this.checkIssued && this.#owner.centralStateBlocked;
    return this.#owner.timeout(
      this.operation,
      this.layer,
      this.#owner.commandDeadlineMs,
      this.entryCheck ? 'entry-check' : this.#phase,
      'command',
      this.entryCheck
        ? blocked
          ? 'unconfirmed'
          : 'check-timed-out'
        : 'not-checked',
      blocked,
    );
  }
}

function invalidationError(
  record: CdpLabInvalidation,
  operation: string,
  operationLayer: CdpOperationLayer,
): BluetoothBackendStoppedError {
  const { cause, ...context } = record;
  return new BluetoothBackendStoppedError(
    'The Bluetooth lab is invalidated. Dispose it and begin the next journey in a new test fixture, navigating its page to a secure origin before first use.',
    {
      ...(cause === undefined ? {} : { cause }),
      context: { ...context, operation, operationLayer },
    },
  );
}

function isMissingBinding(cause: unknown): boolean {
  if (
    !(cause instanceof CdpTransportError) ||
    cause.kind !== 'command-failed' ||
    cause.target !== 'browser' ||
    !cause.method.startsWith('BluetoothEmulation.')
  )
    return false;
  const error = cause.cause;
  if (!(error instanceof Error)) return false;
  return (
    error.message ===
      `cdpSession.send: Protocol error (${cause.method}): BluetoothEmulation not enabled` ||
    error.message ===
      `Protocol error (${cause.method}): BluetoothEmulation not enabled`
  );
}
