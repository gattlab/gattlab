import {
  BluetoothBackendStoppedError,
  BluetoothCancelledError,
  BluetoothConcurrentOperationError,
  BluetoothTimeoutError,
  BluetoothValidationError,
  centralStates,
  normalizeBluetoothAddress,
  PromptDeviceNotFoundError,
  type BackendCallOptions,
  type BluetoothAddress,
  type BluetoothTimeline,
  type BluetoothTimelineEvent,
  type CentralState,
  type DiagnosticValue,
  type MonotonicClock,
  type PeripheralReference,
} from '@gattlab/core';

import type { CdpOperationLayer } from './lab-lifecycle.js';
import type { CdpTransport } from './transport.js';

export interface DevicePromptDeadline {
  cancel(): void;
}

export interface DevicePromptDeadlineScheduler {
  /** The callback must not run synchronously before `schedule()` returns. */
  schedule(deadlineMs: number, onDeadline: () => void): DevicePromptDeadline;
}

export interface DevicePromptDiagnosticState {
  readonly centralState: CentralState;
  readonly knownPeripherals: readonly BluetoothAddress[];
  readonly advertisementsSent: number;
}

export interface CdpDevicePromptControllerOptions {
  readonly transport: CdpTransport<'page'>;
  readonly timeline: BluetoothTimeline;
  readonly clock: MonotonicClock;
  readonly defaultDeadlineMs: number;
  readonly deadlineScheduler: DevicePromptDeadlineScheduler;
  readonly getDiagnosticState: () => DevicePromptDiagnosticState;
  readonly lifecycle?: {
    assertActive(operation: string, layer: CdpOperationLayer): void;
    beforeWait(layer: CdpOperationLayer): Promise<void>;
    settle(
      operation: string,
      layer: CdpOperationLayer,
      options: BackendCallOptions | undefined,
      send: (transport: Pick<CdpTransport<'page'>, 'send'>) => Promise<void>,
    ): Promise<void>;
    diagnoseTimeout(
      timeout: BluetoothTimeoutError,
      layer: CdpOperationLayer,
    ): Promise<never>;
  };
}

export interface WaitForDevicePromptOptions {
  /** Override the arrival deadline with positive safe-integer milliseconds; does not bound selection/cancellation after arrival. */
  readonly deadlineMs?: number;
  /** Integration boundary for emitted lifecycle diagnostics; omission retains the direct CDP boundary. */
  readonly operationLayer?: CdpOperationLayer;
}

export interface CdpDevicePromptCandidate {
  readonly id: string;
  readonly name: string;
}

type PromptState = 'open' | 'settling' | 'settled';
type PromptSelectionMode = 'address' | 'id';
type PromptAction = 'select' | 'cancel';

interface PromptSnapshot {
  readonly id: string;
  readonly devices: readonly CdpDevicePromptCandidate[];
}

interface PendingPromptWait {
  readonly startedAt: number;
  readonly deadlineMs: number;
  readonly promise: Promise<CdpDevicePrompt>;
  readonly resolve: (prompt: CdpDevicePrompt) => void;
  readonly reject: (cause: unknown) => void;
  unsubscribe: () => void;
  deadline: DevicePromptDeadline | undefined;
  phase: 'entry' | 'application' | 'diagnostic';
  readonly operationLayer: CdpOperationLayer;
  retainedPayload?: unknown;
}

interface PromptSelection {
  readonly deviceId: string;
  readonly mode: PromptSelectionMode;
  readonly peripheral?: PeripheralReference;
}

interface PromptInternalState {
  readonly controller: CdpDevicePromptController;
  readonly promptId: string;
  devices: readonly CdpDevicePromptCandidate[];
  state: PromptState;
  readonly operationLayer: CdpOperationLayer;
}

const userGestureReminder =
  'navigator.bluetooth.requestDevice() must be called from a user gesture. GattLab observes only the chooser opened by the fixture page; choosers from another page or BrowserContext are not controlled by this lab.';
const promptInternals = new WeakMap<CdpDevicePrompt, PromptInternalState>();

/** Internal immutable prompt handle backed by the DeviceAccess page session. */
export class CdpDevicePrompt {
  constructor(
    controller: CdpDevicePromptController,
    snapshot: PromptSnapshot,
    operationLayer: CdpOperationLayer = 'cdp',
  ) {
    promptInternals.set(this, {
      controller,
      promptId: snapshot.id,
      devices: snapshot.devices,
      state: 'open',
      operationLayer,
    });
  }

  /** Latest immutable candidate snapshot; previously retrieved snapshots do not change. */
  get devices(): readonly CdpDevicePromptCandidate[] {
    return promptInternal(this).devices;
  }

  /** True after successful selection or cancellation; failed transport actions leave the prompt open. */
  get settled(): boolean {
    return promptInternal(this).state === 'settled';
  }

  /** Select exactly one address-derived candidate, ignoring names; invalid/missing/stale/concurrent selection rejects. Factory-issued prompts share the finite command budget; standalone controllers add no settlement deadline. */
  select(
    address: BluetoothAddress,
    options?: BackendCallOptions,
  ): Promise<void> {
    return promptInternal(this).controller.select(this, address, options);
  }

  /** Select one current candidate id explicitly; invalid or missing ids reject before protocol mutation. */
  selectById(deviceId: string, options?: BackendCallOptions): Promise<void> {
    return promptInternal(this).controller.selectById(this, deviceId, options);
  }

  /** Cancel the open prompt; stale/concurrent/transport failures reject, and a failed command permits another explicit attempt. */
  cancel(options?: BackendCallOptions): Promise<void> {
    return promptInternal(this).controller.cancel(this, options);
  }
}

/** Internal DeviceAccess prompt lifecycle and command mapping. */
export class CdpDevicePromptController {
  readonly #transport: CdpTransport<'page'>;
  readonly #timeline: BluetoothTimeline;
  readonly #clock: MonotonicClock;
  readonly #defaultDeadlineMs: number;
  readonly #deadlineScheduler: DevicePromptDeadlineScheduler;
  readonly #getDiagnosticState: () => DevicePromptDiagnosticState;
  readonly #lifecycle: CdpDevicePromptControllerOptions['lifecycle'];
  #pendingWait: PendingPromptWait | undefined;
  #activeSubscription: PendingPromptWait | undefined;
  #activePrompt: CdpDevicePrompt | undefined;
  #disposed = false;

  constructor(options: CdpDevicePromptControllerOptions) {
    assertClock(options.clock);
    assertPositiveSafeInteger(
      options.defaultDeadlineMs,
      'Device prompt defaultDeadlineMs',
    );
    assertDeadlineScheduler(options.deadlineScheduler);
    if (typeof options.getDiagnosticState !== 'function') {
      throw new TypeError(
        'Device prompt getDiagnosticState must be a function.',
      );
    }

    this.#lifecycle = options.lifecycle;
    this.#transport = options.transport;
    this.#timeline = options.timeline;
    this.#clock = options.clock;
    this.#defaultDeadlineMs = options.defaultDeadlineMs;
    this.#deadlineScheduler = options.deadlineScheduler;
    this.#getDiagnosticState = options.getDiagnosticState;
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  get activePrompt(): CdpDevicePrompt | undefined {
    return this.#activePrompt;
  }

  waitForDevicePrompt(
    options: WaitForDevicePromptOptions = {},
  ): Promise<CdpDevicePrompt> {
    this.#assertActive(
      'wait-for-device-prompt',
      options.operationLayer ?? 'cdp',
    );
    const deadlineMs = options.deadlineMs ?? this.#defaultDeadlineMs;
    assertPositiveSafeInteger(deadlineMs, 'Device prompt deadlineMs');

    if (this.#pendingWait !== undefined || this.#activePrompt !== undefined) {
      const reason =
        this.#pendingWait === undefined
          ? 'unsettled-device-prompt'
          : 'prompt-wait-already-pending';
      this.#timeline.append({
        category: 'prompt',
        type: 'device-prompt-wait-rejected',
        status: 'failed',
        data: { reason },
      });
      throw new BluetoothConcurrentOperationError(
        this.#pendingWait === undefined
          ? 'The previous device prompt has not been settled.'
          : 'A device prompt wait is already pending.',
        { context: { operation: 'wait-for-device-prompt', reason } },
      );
    }

    const startedAt = readClock(this.#clock);
    let resolvePrompt: ((prompt: CdpDevicePrompt) => void) | undefined;
    let rejectPrompt: ((cause: unknown) => void) | undefined;
    const promise = new Promise<CdpDevicePrompt>((resolve, reject) => {
      resolvePrompt = resolve;
      rejectPrompt = reject;
    });
    if (resolvePrompt === undefined || rejectPrompt === undefined) {
      throw new TypeError(
        'Device prompt deferred promise was not initialized.',
      );
    }
    const wait: PendingPromptWait = {
      startedAt,
      deadlineMs,
      promise,
      resolve: resolvePrompt,
      reject: rejectPrompt,
      unsubscribe: () => undefined,
      deadline: undefined,
      phase: this.#lifecycle ? 'entry' : 'application',
      operationLayer: options.operationLayer ?? 'cdp',
    };

    this.#timeline.append({
      category: 'prompt',
      type: 'device-prompt-wait',
      status: 'requested',
      data: { deadlineMs },
    });
    this.#pendingWait = wait;

    try {
      const unsubscribe = this.#transport.on(
        'DeviceAccess.deviceRequestPrompted',
        (payload) => {
          this.#receivePrompt(wait, payload);
        },
      );
      wait.unsubscribe = unsubscribe;
      if (this.#pendingWait !== wait) {
        unsubscribe();
        return promise;
      }

      const beginArrival = (): void => {
        if (this.#pendingWait !== wait || this.#disposed) return;
        wait.phase = 'application';
        if ('retainedPayload' in wait) {
          this.#receivePrompt(wait, wait.retainedPayload);
          return;
        }
        const deadline = this.#deadlineScheduler.schedule(deadlineMs, () => {
          this.#timeOut(wait);
        });
        assertDeadline(deadline);
        wait.deadline = deadline;
        if (this.#pendingWait !== wait) deadline.cancel();
      };
      if (this.#lifecycle) {
        void this.#lifecycle
          .beforeWait(wait.operationLayer)
          .then(beginArrival, (cause: unknown) => {
            if (this.#pendingWait !== wait) return;
            this.#finishWait(wait);
            wait.reject(cause);
          });
      } else {
        beginArrival();
        if (this.#pendingWait !== wait) return promise;
      }
    } catch (cause) {
      this.#finishWait(wait);
      this.#timeline.append({
        category: 'prompt',
        type: 'device-prompt-wait-registration-failed',
        status: 'failed',
        data: { reason: 'listener-or-deadline-registration-failed' },
      });
      wait.reject(cause);
      return promise;
    }

    this.#timeline.append({
      category: 'prompt',
      type: 'device-prompt-wait',
      status: 'pending',
      data: { deadlineMs },
    });
    return promise;
  }

  async select(
    prompt: CdpDevicePrompt,
    address: BluetoothAddress,
    options?: BackendCallOptions,
  ): Promise<void> {
    this.#assertOwnedOpenPrompt(prompt, 'select');
    const normalizedAddress = requireBluetoothAddress(address);
    const matchingDevices = prompt.devices.filter(
      (device) => device.id === normalizedAddress,
    );
    if (matchingDevices.length !== 1) {
      this.#timeline.append({
        category: 'prompt',
        type: 'device-prompt-selection-rejected',
        entity: peripheralReference(normalizedAddress),
        status: 'failed',
        data: {
          candidateCount: prompt.devices.length,
          matchingCandidateCount: matchingDevices.length,
          reason:
            matchingDevices.length === 0
              ? 'prompt-device-not-found'
              : 'multiple-address-matches',
          selectionMode: 'address',
        },
      });
      if (matchingDevices.length === 0) {
        throw new PromptDeviceNotFoundError(
          `The device prompt does not contain peripheral ${normalizedAddress}.`,
          {
            context: {
              address: normalizedAddress,
              candidateCount: prompt.devices.length,
              selectionMode: 'address',
            },
          },
        );
      }
      throw new BluetoothValidationError(
        'The device prompt contains the peripheral address more than once.',
        {
          context: {
            address: normalizedAddress,
            candidateCount: prompt.devices.length,
            matchingCandidateCount: matchingDevices.length,
            reason: 'multiple-address-matches',
            selectionMode: 'address',
          },
        },
      );
    }

    await this.#settlePrompt(
      prompt,
      'select',
      {
        deviceId: matchingDevices[0]?.id ?? normalizedAddress,
        mode: 'address',
        peripheral: peripheralReference(normalizedAddress),
      },
      'select',
      options,
    );
  }

  async selectById(
    prompt: CdpDevicePrompt,
    deviceId: string,
    options?: BackendCallOptions,
  ): Promise<void> {
    this.#assertOwnedOpenPrompt(prompt, 'select-by-id');
    if (typeof deviceId !== 'string' || deviceId.length === 0) {
      throw new BluetoothValidationError(
        'The prompt device id must be a non-empty string.',
        {
          context: {
            reason: 'invalid-prompt-device-id',
            receivedType: typeof deviceId,
            selectionMode: 'id',
          },
        },
      );
    }
    const matchingDevices = prompt.devices.filter(
      (device) => device.id === deviceId,
    );
    if (matchingDevices.length !== 1) {
      this.#timeline.append({
        category: 'prompt',
        type: 'device-prompt-selection-rejected',
        status: 'failed',
        data: {
          candidateCount: prompt.devices.length,
          matchingCandidateCount: matchingDevices.length,
          reason:
            matchingDevices.length === 0
              ? 'prompt-device-not-found'
              : 'multiple-id-matches',
          selectionMode: 'id',
        },
      });
      if (matchingDevices.length === 0) {
        throw new PromptDeviceNotFoundError(
          'The device prompt does not contain the requested candidate id.',
          {
            context: {
              candidateCount: prompt.devices.length,
              selectionMode: 'id',
            },
          },
        );
      }
      throw new BluetoothValidationError(
        'The device prompt contains the candidate id more than once.',
        {
          context: {
            candidateCount: prompt.devices.length,
            matchingCandidateCount: matchingDevices.length,
            reason: 'multiple-id-matches',
            selectionMode: 'id',
          },
        },
      );
    }

    await this.#settlePrompt(
      prompt,
      'select',
      {
        deviceId,
        mode: 'id',
      },
      'selectById',
      options,
    );
  }

  async cancel(
    prompt: CdpDevicePrompt,
    options?: BackendCallOptions,
  ): Promise<void> {
    this.#assertOwnedOpenPrompt(prompt, 'cancel');
    await this.#settlePrompt(prompt, 'cancel', undefined, 'cancel', options);
  }

  dispose(reason = 'controller-disposed', cause?: unknown): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#releaseActiveSubscription();
    this.#activePrompt = undefined;
    const wait = this.#pendingWait;
    if (wait === undefined) return;

    this.#finishWait(wait);
    const error = new BluetoothCancelledError(
      'The pending device prompt wait was cancelled during controller disposal.',
      {
        context: {
          operation: 'wait-for-device-prompt',
          reason,
        },
      },
    );
    this.#timeline.append({
      category: 'prompt',
      type: 'device-prompt-wait',
      status: 'cancelled',
      data: { reason },
    });
    wait.reject(cause ?? error);
  }

  #receivePrompt(wait: PendingPromptWait, payload: unknown): void {
    if (this.#disposed) return;
    if (this.#activeSubscription === wait) {
      this.#updatePrompt(payload);
      return;
    }
    if (this.#pendingWait !== wait) return;
    if (wait.phase === 'entry') {
      wait.retainedPayload = payload;
      return;
    }
    if (wait.phase === 'diagnostic') return;

    let snapshot: PromptSnapshot;
    try {
      snapshot = snapshotPrompt(payload);
    } catch (cause) {
      this.#finishWait(wait);
      this.#timeline.append({
        category: 'prompt',
        type: 'device-prompt-event-rejected',
        status: 'failed',
        data: { reason: promptEventRejectionReason(cause) },
      });
      wait.reject(cause);
      return;
    }

    this.#pendingWait = undefined;
    wait.deadline?.cancel();
    wait.deadline = undefined;
    const prompt = Object.freeze(
      new CdpDevicePrompt(this, snapshot, wait.operationLayer),
    );
    this.#activePrompt = prompt;
    this.#activeSubscription = wait;
    this.#timeline.append({
      category: 'prompt',
      type: 'device-prompt-received',
      status: 'succeeded',
      data: {
        candidateCount: snapshot.devices.length,
        emptyNameCount: snapshot.devices.filter(
          (device) => device.name.length === 0,
        ).length,
      },
    });
    wait.resolve(prompt);
  }

  #updatePrompt(payload: unknown): void {
    const prompt = this.#activePrompt;
    if (prompt === undefined) return;

    let snapshot: PromptSnapshot;
    try {
      snapshot = snapshotPrompt(payload);
    } catch (cause) {
      this.#timeline.append({
        category: 'prompt',
        type: 'device-prompt-event-rejected',
        status: 'failed',
        data: {
          phase: 'update',
          reason: promptEventRejectionReason(cause),
        },
      });
      return;
    }

    const internal = promptInternal(prompt);
    if (snapshot.id !== internal.promptId) {
      this.#timeline.append({
        category: 'prompt',
        type: 'device-prompt-event-rejected',
        status: 'failed',
        data: { phase: 'update', reason: 'unexpected-prompt-id' },
      });
      return;
    }
    internal.devices = snapshot.devices;
    this.#timeline.append({
      category: 'prompt',
      type: 'device-prompt-updated',
      status: 'succeeded',
      data: {
        candidateCount: snapshot.devices.length,
        emptyNameCount: snapshot.devices.filter(
          (device) => device.name.length === 0,
        ).length,
      },
    });
  }

  #timeOut(wait: PendingPromptWait): void {
    if (this.#pendingWait !== wait || this.#disposed) return;
    const unavailableReasons: string[] = [];
    let elapsedMs: number | null = null;
    let diagnostics: DevicePromptDiagnosticState | undefined;

    try {
      elapsedMs = elapsedSince(this.#clock, wait.startedAt);
    } catch {
      unavailableReasons.push('clock-read-failed');
    }

    let diagnosticState: DevicePromptDiagnosticState | undefined;
    try {
      diagnosticState = this.#getDiagnosticState();
    } catch {
      unavailableReasons.push('diagnostic-state-provider-failed');
    }
    if (diagnosticState !== undefined) {
      try {
        diagnostics = snapshotDiagnosticState(diagnosticState);
      } catch {
        unavailableReasons.push('diagnostic-state-invalid');
      }
    }

    try {
      if (this.#lifecycle) {
        wait.phase = 'diagnostic';
        wait.deadline?.cancel();
      } else this.#finishWait(wait);
    } catch {
      unavailableReasons.push('wait-cleanup-failed');
    }

    const timeoutTimelineData = {
      advertisementsSent: diagnostics?.advertisementsSent ?? null,
      deadlineMs: wait.deadlineMs,
      elapsedMs,
      knownPeripheralCount: diagnostics?.knownPeripherals.length ?? null,
      centralState: diagnostics?.centralState ?? null,
      userGestureRequired: true,
      ...(unavailableReasons.length === 0
        ? {}
        : {
            diagnosticsUnavailable: true,
            diagnosticsUnavailableReason: unavailableReasons.join(','),
          }),
    };
    try {
      this.#timeline.append({
        category: 'prompt',
        type: 'device-prompt-wait',
        status: 'timed-out',
        data: timeoutTimelineData,
      });
    } catch {
      unavailableReasons.push('timeline-append-failed');
    }

    let recentTimeline: readonly Readonly<Record<string, DiagnosticValue>>[] =
      [];
    try {
      recentTimeline = this.#timeline
        .snapshot()
        .slice(-10)
        .map(summarizeTimelineEvent);
    } catch {
      unavailableReasons.push('timeline-snapshot-failed');
    }

    const diagnosticsUnavailable = unavailableReasons.join(',');
    const elapsedDescription =
      elapsedMs === null
        ? `${String(wait.deadlineMs)} ms diagnostic deadline`
        : `${String(elapsedMs)} ms`;
    const timeout = new BluetoothTimeoutError(
      `Timed out after ${elapsedDescription} waiting for a Web Bluetooth device prompt. ${userGestureReminder}`,
      {
        context: {
          advertisementsSent: diagnostics?.advertisementsSent ?? null,
          centralState: diagnostics?.centralState ?? null,
          deadlineMs: wait.deadlineMs,
          elapsedMs,
          knownPeripherals: diagnostics?.knownPeripherals ?? [],
          operation: 'wait-for-device-prompt',
          recentTimeline,
          userGestureReminder,
          ...(diagnosticsUnavailable.length === 0
            ? {}
            : { diagnosticsUnavailable }),
        },
      },
    );
    if (this.#lifecycle) {
      void this.#lifecycle
        .diagnoseTimeout(timeout, wait.operationLayer)
        .catch((cause: unknown) => {
          if (this.#pendingWait !== wait) return;
          this.#finishWait(wait);
          wait.reject(cause);
        });
    } else wait.reject(timeout);
  }

  async #settlePrompt(
    prompt: CdpDevicePrompt,
    action: PromptAction,
    selection?: PromptSelection,
    operation: string = action,
    options?: BackendCallOptions,
  ): Promise<void> {
    const internal = promptInternal(prompt);
    internal.state = 'settling';
    const timelineInput = {
      category: 'prompt' as const,
      type:
        action === 'select'
          ? 'device-prompt-selection'
          : 'device-prompt-cancellation',
      ...(selection?.peripheral === undefined
        ? {}
        : { entity: selection.peripheral }),
      data: {
        action,
        candidateCount: prompt.devices.length,
        ...(selection === undefined ? {} : { selectionMode: selection.mode }),
      },
    };
    this.#timeline.append({ ...timelineInput, status: 'requested' });

    const send = async (
      transport: Pick<CdpTransport<'page'>, 'send'>,
    ): Promise<void> => {
      if (action === 'select' && selection !== undefined) {
        await transport.send('DeviceAccess.selectPrompt', {
          id: internal.promptId,
          deviceId: selection.deviceId,
        });
      } else {
        await transport.send('DeviceAccess.cancelPrompt', {
          id: internal.promptId,
        });
      }
    };
    try {
      if (this.#lifecycle)
        await this.#lifecycle.settle(
          operation,
          internal.operationLayer,
          options,
          send,
        );
      else await send(this.#transport);
    } catch (cause) {
      internal.state = 'open';
      this.#timeline.append({
        ...timelineInput,
        status: 'failed',
        data: {
          ...timelineInput.data,
          reason: 'protocol-command-failed',
        },
      });
      throw cause;
    }

    internal.state = 'settled';
    if (this.#activePrompt === prompt) this.#activePrompt = undefined;
    this.#releaseActiveSubscription();
    this.#timeline.append({ ...timelineInput, status: 'succeeded' });
  }

  #assertOwnedOpenPrompt(prompt: CdpDevicePrompt, operation: string): void {
    this.#assertActive(
      operation,
      promptInternals.get(prompt)?.operationLayer ?? 'cdp',
    );
    if (!(prompt instanceof CdpDevicePrompt) || this.#activePrompt !== prompt) {
      throw new BluetoothValidationError(
        'The device prompt does not belong to this active controller.',
        {
          context: {
            operation,
            reason:
              prompt instanceof CdpDevicePrompt && prompt.settled
                ? 'prompt-already-settled'
                : 'foreign-or-inactive-prompt',
          },
        },
      );
    }
    const internal = promptInternal(prompt);
    if (internal.state === 'settling') {
      throw new BluetoothConcurrentOperationError(
        'The device prompt is already being settled.',
        {
          context: {
            operation,
            reason: 'prompt-settlement-in-progress',
          },
        },
      );
    }
    if (internal.state === 'settled') {
      throw new BluetoothValidationError(
        'The device prompt has already been settled.',
        {
          context: { operation, reason: 'prompt-already-settled' },
        },
      );
    }
  }

  #assertActive(operation: string, layer: CdpOperationLayer = 'cdp'): void {
    this.#lifecycle?.assertActive(
      operation === 'wait-for-device-prompt'
        ? 'waitForDevicePrompt'
        : operation === 'select-by-id'
          ? 'selectById'
          : operation,
      layer,
    );
    if (!this.#disposed) return;
    throw new BluetoothBackendStoppedError(
      'The device prompt controller has been disposed.',
      {
        context: { operation, promptControllerDisposed: true },
      },
    );
  }

  #finishWait(wait: PendingPromptWait): void {
    if (this.#pendingWait !== wait) return;
    this.#pendingWait = undefined;
    wait.unsubscribe();
    wait.deadline?.cancel();
    wait.deadline = undefined;
  }

  #releaseActiveSubscription(): void {
    const subscription = this.#activeSubscription;
    if (subscription === undefined) return;
    this.#activeSubscription = undefined;
    subscription.unsubscribe();
    subscription.deadline?.cancel();
    subscription.deadline = undefined;
  }
}

function snapshotPrompt(payload: unknown): PromptSnapshot {
  if (!isPlainRecord(payload)) {
    throw promptEventError('invalid-prompt-payload');
  }
  if (!hasOnlyKeys(payload, ['devices', 'id'])) {
    throw promptEventError('unexpected-prompt-fields');
  }
  if (typeof payload['id'] !== 'string' || payload['id'].length === 0) {
    throw promptEventError('invalid-prompt-id');
  }
  const rawDevices = payload['devices'];
  if (!Array.isArray(rawDevices)) {
    throw promptEventError('invalid-prompt-devices');
  }
  const devices = rawDevices.map((device) => snapshotPromptCandidate(device));
  return Object.freeze({
    id: payload['id'],
    devices: Object.freeze(devices),
  });
}

function promptInternal(prompt: CdpDevicePrompt): PromptInternalState {
  const internal = promptInternals.get(prompt);
  if (internal === undefined) {
    throw new TypeError('Invalid device prompt handle.');
  }
  return internal;
}

function snapshotPromptCandidate(payload: unknown): CdpDevicePromptCandidate {
  if (!isPlainRecord(payload) || !hasOnlyKeys(payload, ['id', 'name'])) {
    throw promptEventError('invalid-prompt-device');
  }
  if (typeof payload['id'] !== 'string' || payload['id'].length === 0) {
    throw promptEventError('invalid-prompt-device-id');
  }
  if (typeof payload['name'] !== 'string') {
    throw promptEventError('invalid-prompt-device-name');
  }
  return Object.freeze({ id: payload['id'], name: payload['name'] });
}

function snapshotDiagnosticState(
  state: DevicePromptDiagnosticState,
): DevicePromptDiagnosticState {
  if (!isPlainRecord(state)) {
    throw new TypeError('Device prompt diagnostics must be a plain record.');
  }
  const centralState = state.centralState;
  if (
    typeof centralState !== 'string' ||
    !centralStates.includes(centralState)
  ) {
    throw new TypeError(
      'Device prompt diagnostics must contain a valid centralState.',
    );
  }
  const knownPeripherals = state.knownPeripherals;
  if (!Array.isArray(knownPeripherals)) {
    throw new TypeError(
      'Device prompt diagnostics must contain knownPeripherals.',
    );
  }
  const addresses = knownPeripherals.map((address) =>
    requireBluetoothAddress(address),
  );
  const advertisementsSent = state.advertisementsSent;
  if (
    typeof advertisementsSent !== 'number' ||
    !Number.isSafeInteger(advertisementsSent) ||
    advertisementsSent < 0
  ) {
    throw new TypeError(
      'Device prompt diagnostics advertisementsSent must be a non-negative safe integer.',
    );
  }
  return Object.freeze({
    centralState,
    knownPeripherals: Object.freeze(addresses),
    advertisementsSent,
  });
}

function summarizeTimelineEvent(
  event: BluetoothTimelineEvent,
): Readonly<Record<string, DiagnosticValue>> {
  return Object.freeze({
    category: event.category,
    elapsedMs: event.elapsedMs,
    sequence: event.sequence,
    ...(event.status === undefined ? {} : { status: event.status }),
    type: event.type,
  });
}

function peripheralReference(address: BluetoothAddress): PeripheralReference {
  return Object.freeze({ kind: 'peripheral', address });
}

function requireBluetoothAddress(value: unknown): BluetoothAddress {
  try {
    return normalizeBluetoothAddress(value as string);
  } catch (cause) {
    throw new BluetoothValidationError(
      'The device prompt operation has an invalid peripheral address.',
      {
        cause,
        context: { reason: 'invalid-peripheral-address' },
      },
    );
  }
}

function promptEventError(reason: string): BluetoothValidationError {
  return new BluetoothValidationError(
    'Chromium emitted a malformed device prompt event.',
    { context: { reason } },
  );
}

function promptEventRejectionReason(cause: unknown): string {
  if (cause instanceof BluetoothValidationError) {
    const reason = cause.context['reason'];
    if (typeof reason === 'string') return reason;
  }
  return 'event-processing-failed';
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function hasOnlyKeys(
  value: Readonly<Record<string, unknown>>,
  expectedKeys: readonly string[],
): boolean {
  const keys = Object.keys(value).sort();
  return (
    keys.length === expectedKeys.length &&
    keys.every((key, index) => key === expectedKeys[index])
  );
}

function assertPositiveSafeInteger(value: unknown, label: string): void {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new RangeError(`${label} must be a positive safe integer.`);
  }
}

function assertClock(clock: unknown): asserts clock is MonotonicClock {
  if (
    typeof clock !== 'object' ||
    clock === null ||
    !('now' in clock) ||
    typeof clock.now !== 'function'
  ) {
    throw new TypeError('Device prompt clock must provide now().');
  }
  readClock(clock as MonotonicClock);
}

function assertDeadlineScheduler(
  scheduler: unknown,
): asserts scheduler is DevicePromptDeadlineScheduler {
  if (
    typeof scheduler !== 'object' ||
    scheduler === null ||
    !('schedule' in scheduler) ||
    typeof scheduler.schedule !== 'function'
  ) {
    throw new TypeError(
      'Device prompt deadlineScheduler must provide schedule().',
    );
  }
}

function assertDeadline(
  deadline: unknown,
): asserts deadline is DevicePromptDeadline {
  if (
    typeof deadline !== 'object' ||
    deadline === null ||
    !('cancel' in deadline) ||
    typeof deadline.cancel !== 'function'
  ) {
    throw new TypeError(
      'Device prompt deadlineScheduler.schedule() must return a cancellable deadline.',
    );
  }
}

function readClock(clock: MonotonicClock): number {
  const value = clock.now();
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError('Device prompt clock must return a finite number.');
  }
  return value;
}

function elapsedSince(clock: MonotonicClock, startedAt: number): number {
  const current = readClock(clock);
  if (current < startedAt) {
    throw new RangeError('Device prompt clock must not move backwards.');
  }
  return current - startedAt;
}
