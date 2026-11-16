import {
  BluetoothBackendStoppedError,
  BluetoothCancelledError,
  BluetoothConcurrentOperationError,
  BluetoothTimeoutError,
  BluetoothValidationError,
  createBluetoothTimeline,
  normalizeBluetoothAddress,
  PromptDeviceNotFoundError,
  type BluetoothAddress,
  type BluetoothTimeline,
  type MonotonicClock,
} from '@gattlab/core';
import { describe, expect, it } from 'vitest';

import {
  CdpDevicePromptController,
  type CdpDevicePrompt,
  type DevicePromptDeadline,
  type DevicePromptDeadlineScheduler,
  type DevicePromptDiagnosticState,
} from '../src/device-prompt-controller.js';
import {
  CdpTransportError,
  createCdpTransport,
  type CdpSessionLike,
} from '../src/transport.js';

interface SentCommand {
  readonly method: string;
  readonly parameters?: object;
}

class FakeCdpSession implements CdpSessionLike {
  readonly calls: SentCommand[] = [];
  readonly listeners = new Map<string, Set<(payload: unknown) => void>>();
  readonly failures: unknown[] = [];
  pendingSend: Promise<unknown> | undefined;

  async send(method: string, parameters?: object): Promise<unknown> {
    this.calls.push({
      method,
      ...(parameters === undefined ? {} : { parameters }),
    });
    const failure = this.failures.shift();
    if (failure !== undefined) throw failure;
    if (this.pendingSend !== undefined) return this.pendingSend;
    return {};
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

  listenerCount(event: string): number {
    return this.listeners.get(event)?.size ?? 0;
  }
}

class FakeTime implements MonotonicClock, DevicePromptDeadlineScheduler {
  #now = 0;
  #nextId = 0;
  readonly #deadlines = new Map<
    number,
    Readonly<{ at: number; onDeadline: () => void }>
  >();

  get pendingDeadlineCount(): number {
    return this.#deadlines.size;
  }

  now(): number {
    return this.#now;
  }

  schedule(deadlineMs: number, onDeadline: () => void): DevicePromptDeadline {
    this.#nextId += 1;
    const id = this.#nextId;
    this.#deadlines.set(id, { at: this.#now + deadlineMs, onDeadline });
    return Object.freeze({
      cancel: () => {
        this.#deadlines.delete(id);
      },
    });
  }

  advanceBy(durationMs: number): void {
    const target = this.#now + durationMs;
    while (true) {
      const next = [...this.#deadlines.entries()]
        .filter(([, deadline]) => deadline.at <= target)
        .sort((left, right) => left[1].at - right[1].at)[0];
      if (next === undefined) break;
      const [id, deadline] = next;
      this.#deadlines.delete(id);
      this.#now = deadline.at;
      deadline.onDeadline();
    }
    this.#now = target;
  }
}

interface PromptHarness {
  readonly controller: CdpDevicePromptController;
  readonly diagnostics: DevicePromptDiagnosticState;
  readonly session: FakeCdpSession;
  readonly time: FakeTime;
  readonly timeline: BluetoothTimeline;
}

const firstAddress = normalizeBluetoothAddress('00:11:22:33:44:55');
const secondAddress = normalizeBluetoothAddress('AA:BB:CC:DD:EE:FF');

function createHarness(options?: {
  readonly controllerClock?: MonotonicClock;
  readonly deadlineScheduler?: DevicePromptDeadlineScheduler;
  readonly getDiagnosticState?: () => DevicePromptDiagnosticState;
  readonly timelineLimit?: number;
}): PromptHarness {
  const session = new FakeCdpSession();
  const time = new FakeTime();
  const timeline = createBluetoothTimeline({
    limit: options?.timelineLimit ?? 100,
    clock: time,
  });
  const diagnostics = Object.freeze({
    centralState: 'powered-on' as const,
    knownPeripherals: Object.freeze([firstAddress, secondAddress]),
    advertisementsSent: 3,
  });
  const controller = new CdpDevicePromptController({
    transport: createCdpTransport('page', session),
    timeline,
    clock: options?.controllerClock ?? time,
    defaultDeadlineMs: 25,
    deadlineScheduler: options?.deadlineScheduler ?? time,
    getDiagnosticState: options?.getDiagnosticState ?? (() => diagnostics),
  });
  return { controller, diagnostics, session, time, timeline };
}

function emitPrompt(
  session: FakeCdpSession,
  devices: readonly Readonly<{ id: string; name: string }>[],
  id = 'secret-prompt-id',
): void {
  session.emit('DeviceAccess.deviceRequestPrompted', { id, devices });
}

async function receivePrompt(
  harness: PromptHarness,
  devices: readonly Readonly<{ id: string; name: string }>[],
): Promise<CdpDevicePrompt> {
  const waiting = harness.controller.waitForDevicePrompt();
  emitPrompt(harness.session, devices);
  return waiting;
}

function promptDevices(): readonly Readonly<{ id: string; name: string }>[] {
  return [
    { id: firstAddress, name: '' },
    { id: secondAddress, name: '' },
  ];
}

describe('CdpDevicePromptController', () => {
  it('arms synchronously and keeps immutable snapshots across prompt updates', async () => {
    const harness = createHarness();
    const source = [{ id: firstAddress, name: '' }];

    const waiting = harness.controller.waitForDevicePrompt();

    expect(
      harness.session.listenerCount('DeviceAccess.deviceRequestPrompted'),
    ).toBe(1);
    expect(harness.time.pendingDeadlineCount).toBe(1);
    emitPrompt(harness.session, source);
    const prompt = await waiting;
    const initialSnapshot = prompt.devices;
    source[0] = { id: 'later-mutation', name: 'later-mutation' };

    expect(initialSnapshot).toEqual([{ id: firstAddress, name: '' }]);
    expect(Object.isFrozen(prompt)).toBe(true);
    expect(Object.isFrozen(initialSnapshot)).toBe(true);
    expect(Object.isFrozen(initialSnapshot[0])).toBe(true);
    expect(
      harness.session.listenerCount('DeviceAccess.deviceRequestPrompted'),
    ).toBe(1);
    expect(harness.time.pendingDeadlineCount).toBe(0);

    emitPrompt(harness.session, promptDevices());
    expect(prompt.devices).toEqual(promptDevices());
    expect(prompt.devices).not.toBe(initialSnapshot);
    expect(initialSnapshot).toEqual([{ id: firstAddress, name: '' }]);

    await prompt.cancel();
    expect(
      harness.session.listenerCount('DeviceAccess.deviceRequestPrompted'),
    ).toBe(0);
  });

  it('selects the exact address when candidates have duplicate empty names', async () => {
    const harness = createHarness();
    const prompt = await receivePrompt(harness, promptDevices());

    await prompt.select(secondAddress);

    expect(prompt.settled).toBe(true);
    expect(harness.controller.activePrompt).toBeUndefined();
    expect(harness.session.calls).toEqual([
      {
        method: 'DeviceAccess.selectPrompt',
        parameters: {
          id: 'secret-prompt-id',
          deviceId: secondAddress,
        },
      },
    ]);
    expect(JSON.stringify(harness.timeline.snapshot())).not.toContain(
      'secret-prompt-id',
    );
  });

  it('throws PromptDeviceNotFoundError without mutation and permits id selection', async () => {
    const harness = createHarness();
    const prompt = await receivePrompt(harness, promptDevices());
    const absentAddress = normalizeBluetoothAddress('12:34:56:78:9A:BC');

    await expect(prompt.select(absentAddress)).rejects.toMatchObject({
      code: 'BLUETOOTH_PROMPT_DEVICE_NOT_FOUND',
      context: {
        address: absentAddress,
        candidateCount: 2,
        selectionMode: 'address',
      },
    } satisfies Partial<PromptDeviceNotFoundError>);
    expect(harness.session.calls).toEqual([]);

    await prompt.selectById(firstAddress);
    expect(harness.session.calls).toEqual([
      {
        method: 'DeviceAccess.selectPrompt',
        parameters: {
          id: 'secret-prompt-id',
          deviceId: firstAddress,
        },
      },
    ]);
  });

  it('rejects invalid and absent explicit ids without exposing them in diagnostics', async () => {
    const harness = createHarness();
    const prompt = await receivePrompt(harness, [
      { id: 'secret-device-id', name: '' },
    ]);

    await expect(prompt.selectById('')).rejects.toBeInstanceOf(
      BluetoothValidationError,
    );
    await expect(
      prompt.selectById('other-secret-device-id'),
    ).rejects.toBeInstanceOf(PromptDeviceNotFoundError);
    expect(harness.session.calls).toEqual([]);
    expect(JSON.stringify(harness.timeline.snapshot())).not.toContain(
      'secret-device-id',
    );
    await prompt.cancel();
  });

  it('cancels once and rejects every later settlement before protocol mutation', async () => {
    const harness = createHarness();
    const prompt = await receivePrompt(harness, promptDevices());

    await prompt.cancel();

    expect(prompt.settled).toBe(true);
    await expect(prompt.cancel()).rejects.toMatchObject({
      code: 'BLUETOOTH_VALIDATION_FAILED',
      context: { reason: 'prompt-already-settled' },
    } satisfies Partial<BluetoothValidationError>);
    await expect(prompt.select(firstAddress)).rejects.toBeInstanceOf(
      BluetoothValidationError,
    );
    expect(harness.session.calls).toEqual([
      {
        method: 'DeviceAccess.cancelPrompt',
        parameters: { id: 'secret-prompt-id' },
      },
    ]);
  });

  it('reopens after a failed command and allows an explicit retry', async () => {
    const harness = createHarness();
    const prompt = await receivePrompt(harness, promptDevices());
    const rawFailure = new Error('raw failure');
    harness.session.failures.push(rawFailure);

    await expect(prompt.select(firstAddress)).rejects.toMatchObject({
      name: 'CdpTransportError',
      kind: 'command-failed',
      cause: rawFailure,
    } satisfies Partial<CdpTransportError>);
    expect(prompt.settled).toBe(false);
    expect(harness.controller.activePrompt).toBe(prompt);

    await prompt.select(firstAddress);
    expect(prompt.settled).toBe(true);
    expect(harness.session.calls).toHaveLength(2);
  });

  it('rejects a concurrent settlement while the first command is in flight', async () => {
    const harness = createHarness();
    const prompt = await receivePrompt(harness, promptDevices());
    let resolveSend: ((value: unknown) => void) | undefined;
    harness.session.pendingSend = new Promise((resolve) => {
      resolveSend = resolve;
    });

    const selection = prompt.select(firstAddress);
    await expect(prompt.cancel()).rejects.toMatchObject({
      code: 'BLUETOOTH_CONCURRENT_OPERATION',
      context: { reason: 'prompt-settlement-in-progress' },
    } satisfies Partial<BluetoothConcurrentOperationError>);
    expect(harness.session.calls).toHaveLength(1);

    resolveSend?.({});
    await selection;
    expect(prompt.settled).toBe(true);
  });

  it('rejects malformed events and records no raw event payload', async () => {
    const malformedEvents: readonly Readonly<{
      payload: unknown;
      reason: string;
      secret: string;
    }>[] = [
      {
        payload: null,
        reason: 'invalid-prompt-payload',
        secret: 'not-present',
      },
      {
        payload: {
          id: 'secret-unexpected-prompt',
          devices: [],
          extra: 'secret-extra-value',
        },
        reason: 'unexpected-prompt-fields',
        secret: 'secret-extra-value',
      },
      {
        payload: {
          id: 'secret-invalid-device-prompt',
          devices: [{ id: 'secret-device', name: 7 }],
        },
        reason: 'invalid-prompt-device-name',
        secret: 'secret-device',
      },
    ];

    for (const malformed of malformedEvents) {
      const harness = createHarness();
      const waiting = harness.controller.waitForDevicePrompt();
      harness.session.emit(
        'DeviceAccess.deviceRequestPrompted',
        malformed.payload,
      );

      await expect(waiting).rejects.toMatchObject({
        code: 'BLUETOOTH_VALIDATION_FAILED',
        context: { reason: malformed.reason },
      } satisfies Partial<BluetoothValidationError>);
      expect(
        harness.session.listenerCount('DeviceAccess.deviceRequestPrompted'),
      ).toBe(0);
      expect(harness.time.pendingDeadlineCount).toBe(0);
      expect(JSON.stringify(harness.timeline.snapshot())).not.toContain(
        malformed.secret,
      );
    }
  });

  it('keeps the last valid snapshot after malformed or foreign updates', async () => {
    const harness = createHarness();
    const prompt = await receivePrompt(harness, promptDevices());
    const snapshot = prompt.devices;

    harness.session.emit('DeviceAccess.deviceRequestPrompted', {
      id: 'secret-prompt-id',
      devices: [{ id: 'secret-update-device', name: '', extra: true }],
    });
    emitPrompt(
      harness.session,
      [{ id: 'secret-foreign-device', name: '' }],
      'secret-foreign-prompt',
    );

    expect(prompt.devices).toBe(snapshot);
    expect(
      harness.timeline
        .snapshot()
        .filter((event) => event.type === 'device-prompt-event-rejected')
        .map((event) => event.data),
    ).toEqual([
      { phase: 'update', reason: 'invalid-prompt-device' },
      { phase: 'update', reason: 'unexpected-prompt-id' },
    ]);
    expect(JSON.stringify(harness.timeline.snapshot())).not.toContain(
      'secret-update-device',
    );
    expect(JSON.stringify(harness.timeline.snapshot())).not.toContain(
      'secret-foreign-prompt',
    );
    await prompt.cancel();
  });

  it('rejects duplicate candidate ids before a selection command', async () => {
    const harness = createHarness();
    const prompt = await receivePrompt(harness, [
      { id: firstAddress, name: 'same' },
      { id: firstAddress, name: 'same' },
    ]);

    await expect(prompt.select(firstAddress)).rejects.toMatchObject({
      code: 'BLUETOOTH_VALIDATION_FAILED',
      context: {
        matchingCandidateCount: 2,
        reason: 'multiple-address-matches',
      },
    } satisfies Partial<BluetoothValidationError>);
    expect(harness.session.calls).toEqual([]);
    await prompt.cancel();
  });

  it('allows only one unresolved wait or active prompt at a time', async () => {
    const harness = createHarness();
    const firstWait = harness.controller.waitForDevicePrompt();

    expect(() => harness.controller.waitForDevicePrompt()).toThrow(
      BluetoothConcurrentOperationError,
    );
    emitPrompt(harness.session, promptDevices());
    const prompt = await firstWait;
    expect(() => harness.controller.waitForDevicePrompt()).toThrow(
      BluetoothConcurrentOperationError,
    );

    await prompt.cancel();
    const nextWait = harness.controller.waitForDevicePrompt();
    emitPrompt(harness.session, promptDevices(), 'next-secret-prompt-id');
    const nextPrompt = await nextWait;
    await nextPrompt.cancel();
  });

  it('times out with the complete bounded diagnostic snapshot', async () => {
    const harness = createHarness({ timelineLimit: 50 });
    for (let index = 0; index < 12; index += 1) {
      harness.timeline.append({
        category: 'diagnostic',
        type: `prior-${String(index)}`,
        status: 'succeeded',
        data: { secretPayload: `secret-${String(index)}` },
      });
    }
    const waiting = harness.controller.waitForDevicePrompt({ deadlineMs: 20 });

    harness.time.advanceBy(23);

    const error = await waiting.catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(BluetoothTimeoutError);
    expect(error).toMatchObject({
      context: {
        advertisementsSent: 3,
        centralState: 'powered-on',
        deadlineMs: 20,
        elapsedMs: 20,
        knownPeripherals: [firstAddress, secondAddress],
        operation: 'wait-for-device-prompt',
        userGestureReminder: expect.stringContaining(
          'GattLab observes only the chooser opened by the fixture page',
        ),
      },
    } satisfies Partial<BluetoothTimeoutError>);
    if (!(error instanceof BluetoothTimeoutError)) {
      throw new Error('Expected a BluetoothTimeoutError.');
    }
    const recentTimeline = error.context['recentTimeline'];
    expect(recentTimeline).toHaveLength(10);
    expect(Object.isFrozen(recentTimeline)).toBe(true);
    expect(JSON.stringify(recentTimeline)).not.toContain('secretPayload');
    expect(JSON.stringify(recentTimeline)).not.toContain('secret-11');
    expect(recentTimeline).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: 'prompt',
          status: 'timed-out',
          type: 'device-prompt-wait',
        }),
      ]),
    );
    expect(
      harness.session.listenerCount('DeviceAccess.deviceRequestPrompted'),
    ).toBe(0);
    expect(harness.time.pendingDeadlineCount).toBe(0);
  });

  it.each([
    [
      'provider failure',
      () => {
        throw new Error('secret provider failure');
      },
      'diagnostic-state-provider-failed',
    ],
    [
      'invalid provider state',
      () => ({
        centralState: 'bogus',
        knownPeripherals: [firstAddress],
        advertisementsSent: 1,
      }),
      'diagnostic-state-invalid',
    ],
  ] as const)(
    'still rejects a timeout after %s',
    async (_label, getDiagnosticState, expectedReason) => {
      const harness = createHarness({
        getDiagnosticState:
          getDiagnosticState as () => DevicePromptDiagnosticState,
      });
      const waiting = harness.controller.waitForDevicePrompt();

      expect(() => harness.time.advanceBy(25)).not.toThrow();

      await expect(waiting).rejects.toMatchObject({
        code: 'BLUETOOTH_TIMEOUT',
        context: {
          advertisementsSent: null,
          centralState: null,
          diagnosticsUnavailable: expectedReason,
          elapsedMs: 25,
          knownPeripherals: [],
        },
      } satisfies Partial<BluetoothTimeoutError>);
      expect(
        harness.session.listenerCount('DeviceAccess.deviceRequestPrompted'),
      ).toBe(0);
      expect(harness.time.pendingDeadlineCount).toBe(0);
      expect(harness.timeline.snapshot().at(-1)).toMatchObject({
        status: 'timed-out',
        data: {
          diagnosticsUnavailable: true,
          diagnosticsUnavailableReason: expectedReason,
        },
      });
    },
  );

  it('still rejects a timeout when the diagnostic clock moves backwards', async () => {
    let controllerNow = 10;
    const harness = createHarness({
      controllerClock: { now: () => controllerNow },
    });
    const waiting = harness.controller.waitForDevicePrompt();
    controllerNow = 5;

    expect(() => harness.time.advanceBy(25)).not.toThrow();

    await expect(waiting).rejects.toMatchObject({
      code: 'BLUETOOTH_TIMEOUT',
      context: {
        advertisementsSent: 3,
        centralState: 'powered-on',
        diagnosticsUnavailable: 'clock-read-failed',
        elapsedMs: null,
        knownPeripherals: [firstAddress, secondAddress],
      },
    } satisfies Partial<BluetoothTimeoutError>);
    expect(harness.timeline.snapshot().at(-1)).toMatchObject({
      status: 'timed-out',
      data: {
        diagnosticsUnavailable: true,
        diagnosticsUnavailableReason: 'clock-read-failed',
        elapsedMs: null,
      },
    });
  });

  it('disposes idempotently, rejects a wait, and ignores a late event', async () => {
    const harness = createHarness();
    const waiting = harness.controller.waitForDevicePrompt();

    harness.controller.dispose('test-cleanup');
    harness.controller.dispose('ignored-second-dispose');
    emitPrompt(harness.session, promptDevices());

    await expect(waiting).rejects.toMatchObject({
      code: 'BLUETOOTH_CANCELLED',
      context: { reason: 'test-cleanup' },
    } satisfies Partial<BluetoothCancelledError>);
    expect(harness.controller.disposed).toBe(true);
    expect(harness.controller.activePrompt).toBeUndefined();
    expect(
      harness.session.listenerCount('DeviceAccess.deviceRequestPrompted'),
    ).toBe(0);
    expect(harness.time.pendingDeadlineCount).toBe(0);
    expect(() => harness.controller.waitForDevicePrompt()).toThrow(
      BluetoothBackendStoppedError,
    );
  });

  it('removes an active prompt update listener during disposal', async () => {
    const harness = createHarness();
    const prompt = await receivePrompt(harness, [
      { id: firstAddress, name: '' },
    ]);
    const snapshot = prompt.devices;

    harness.controller.dispose('active-prompt-cleanup');
    emitPrompt(harness.session, promptDevices());

    expect(
      harness.session.listenerCount('DeviceAccess.deviceRequestPrompted'),
    ).toBe(0);
    expect(prompt.devices).toBe(snapshot);
    expect(harness.controller.activePrompt).toBeUndefined();
    await expect(prompt.cancel()).rejects.toBeInstanceOf(
      BluetoothBackendStoppedError,
    );
    expect(harness.session.calls).toEqual([]);
  });

  it('cleans up the listener when deadline registration fails', async () => {
    const harness = createHarness({
      deadlineScheduler: {
        schedule: () => undefined as never,
      },
    });

    const waiting = harness.controller.waitForDevicePrompt();

    await expect(waiting).rejects.toThrow(/cancellable deadline/u);
    expect(
      harness.session.listenerCount('DeviceAccess.deviceRequestPrompted'),
    ).toBe(0);
  });

  it('does not record pending when a scheduler invokes the deadline synchronously', async () => {
    let cancellationCount = 0;
    const harness = createHarness({
      deadlineScheduler: {
        schedule: (_deadlineMs, onDeadline) => {
          onDeadline();
          return {
            cancel: () => {
              cancellationCount += 1;
            },
          };
        },
      },
    });

    const waiting = harness.controller.waitForDevicePrompt();

    await expect(waiting).rejects.toBeInstanceOf(BluetoothTimeoutError);
    expect(cancellationCount).toBe(1);
    expect(
      harness.session.listenerCount('DeviceAccess.deviceRequestPrompted'),
    ).toBe(0);
    expect(
      harness.timeline
        .snapshot()
        .filter((event) => event.type === 'device-prompt-wait')
        .map((event) => event.status),
    ).toEqual(['requested', 'timed-out']);
  });

  it('validates constructor, deadline, and runtime address inputs', async () => {
    const harness = createHarness();

    expect(
      () =>
        new CdpDevicePromptController({
          transport: createCdpTransport('page', new FakeCdpSession()),
          timeline: harness.timeline,
          clock: { now: () => Number.NaN },
          defaultDeadlineMs: 25,
          deadlineScheduler: harness.time,
          getDiagnosticState: () => harness.diagnostics,
        }),
    ).toThrow(/finite/u);
    expect(() =>
      harness.controller.waitForDevicePrompt({ deadlineMs: 0 }),
    ).toThrow(RangeError);

    const prompt = await receivePrompt(harness, promptDevices());
    await expect(
      prompt.select('not-an-address' as BluetoothAddress),
    ).rejects.toBeInstanceOf(BluetoothValidationError);
    expect(harness.session.calls).toEqual([]);
    await prompt.cancel();
  });
});
