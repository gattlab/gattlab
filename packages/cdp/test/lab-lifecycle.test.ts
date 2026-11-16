import {
  BluetoothBackendStoppedError,
  BluetoothCancelledError,
  BluetoothTimeoutError,
  createBluetoothTimeline,
  createCancellationController,
  validatePeripheralDefinition,
  type MonotonicClock,
  type GattOperationEvent,
  type NormalizedPeripheral,
} from '@gattlab/core';
import { describe, expect, it, vi } from 'vitest';
import { CdpBluetoothBackendFactory } from '../src/backend.js';
import type { CdpCommandTimeout } from '../src/index.js';
import {
  CdpLabLifecycle,
  type CdpLabInvalidation,
} from '../src/lab-lifecycle.js';
import type {
  OperationDeadline,
  OperationDeadlineScheduler,
} from '../src/pending-operation-registry.js';
import {
  CdpTransportError,
  createCdpTransport,
  type CdpSessionLike,
} from '../src/transport.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

class ManualTime implements MonotonicClock, OperationDeadlineScheduler {
  #now = 0;
  #nextId = 0;
  readonly #deadlines = new Map<number, { at: number; run: () => void }>();
  now(): number {
    return this.#now;
  }
  schedule(delay: number, run: () => void): OperationDeadline {
    const id = ++this.#nextId;
    this.#deadlines.set(id, { at: this.#now + delay, run });
    return {
      cancel: () => {
        this.#deadlines.delete(id);
      },
    };
  }
  elapseWithoutCallbacks(ms: number): void {
    this.#now += ms;
  }
  advance(ms: number): void {
    const target = this.#now + ms;
    for (;;) {
      const next = [...this.#deadlines]
        .filter(([, item]) => item.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      this.#deadlines.delete(next[0]);
      this.#now = next[1].at;
      next[1].run();
    }
    this.#now = target;
  }
}

class Session implements CdpSessionLike {
  readonly calls: { method: string; parameters?: object }[] = [];
  readonly listeners = new Map<string, Set<(payload: unknown) => void>>();
  readonly failures = new Map<string, unknown>();
  readonly held = new Map<string, ReturnType<typeof deferred<unknown>>>();
  detached = false;
  async send(method: string, parameters?: object): Promise<unknown> {
    this.calls.push({ method, ...(parameters ? { parameters } : {}) });
    if (this.failures.has(method)) {
      const error = this.failures.get(method);
      this.failures.delete(method);
      throw error;
    }
    const held = this.held.get(method);
    if (held) return held.promise;
    if (method === 'Browser.getVersion')
      return {
        product: 'HeadlessChrome/159.0.8154.6',
        protocolVersion: '1.3',
        userAgent: 'test',
      };
    if (method === 'BluetoothEmulation.addService')
      return { serviceId: `service-${this.calls.length}` };
    if (method === 'BluetoothEmulation.addCharacteristic')
      return { characteristicId: `characteristic-${this.calls.length}` };
    if (method === 'BluetoothEmulation.addDescriptor')
      return { descriptorId: `descriptor-${this.calls.length}` };
    return {};
  }
  on(event: string, listener: (payload: unknown) => void): void {
    const set = this.listeners.get(event) ?? new Set();
    set.add(listener);
    this.listeners.set(event, set);
  }
  off(event: string, listener: (payload: unknown) => void): void {
    this.listeners.get(event)?.delete(listener);
  }
  emit(event: string, payload: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(payload);
  }
  async detach(): Promise<void> {
    this.detached = true;
    for (const item of this.held.values())
      item.reject(new Error('session detached'));
    this.held.clear();
  }
  hold(method: string) {
    const item = deferred<unknown>();
    this.held.set(method, item);
    return item;
  }
  count(method: string): number {
    return this.calls.filter((call) => call.method === method).length;
  }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 24; ++i) await Promise.resolve();
}
function outcome<T>(promise: Promise<T>): Promise<T | unknown> {
  return promise.then(
    (value) => value,
    (cause: unknown) => cause,
  );
}
const stateMethod = 'BluetoothEmulation.setSimulatedCentralState';
const missing = (method = stateMethod) =>
  new Error(
    `cdpSession.send: Protocol error (${method}): BluetoothEmulation not enabled`,
  );
function model(): NormalizedPeripheral {
  const validated = validatePeripheralDefinition({
    address: '00:11:22:33:44:55',
    name: 'lifecycle',
    advertisement: { rssi: -42, name: 'lifecycle' },
    services: [
      {
        uuid: '180f',
        characteristics: [
          {
            uuid: '2a19',
            properties: ['read'],
            descriptors: [{ uuid: '2901' }],
          },
        ],
      },
    ],
  });
  if (!validated.success) throw new Error('Invalid fixture');
  return validated.value;
}
function engine() {
  const time = new ManualTime();
  const session = new Session();
  const transport = createCdpTransport('browser', session);
  const timeline = createBluetoothTimeline({ limit: 200, clock: time });
  const invalidated = vi.fn();
  const lab = new CdpLabLifecycle({
    transport,
    clock: time,
    scheduler: time,
    timeline,
    commandDeadlineMs: 100,
    centralState: 'powered-on',
    invalidate: invalidated,
  });
  return { lab, time, session, transport, timeline, invalidated };
}
async function publicBackend(
  options: { commandDeadlineMs?: number; operationDeadlineMs?: number } = {},
) {
  const time = new ManualTime();
  const session = new Session();
  const page = new Session();
  const timeline = createBluetoothTimeline({ limit: 200, clock: time });
  const release = vi.fn(async () => undefined);
  const factoryOptions = {
    browserName: 'chromium',
    browserTransport: createCdpTransport('browser', session),
    pageTransport: createCdpTransport('page', page),
    inspectWebBluetoothEnvironment: async () => ({
      secureContext: true,
      navigatorBluetooth: true,
    }),
    timeline,
    clock: time,
    deadlineScheduler: time,
    operationDeadlineMs: 1,
    promptDeadlineMs: 10,
    teardownDeadlineMs: 20,
    releaseLease: release,
    ...options,
  };
  const backend = await new CdpBluetoothBackendFactory(factoryOptions).start({
    centralState: 'powered-on',
  });
  return { backend, time, session, page, timeline, release };
}

describe('started lab lifecycle through the public CDP factory', () => {
  it.each(['cdp', 'playwright'] as const)(
    'selectById uses its public operation name at the %s factory boundary',
    async (operationLayer) => {
      const h = await publicBackend();
      const waiting = h.backend.waitForDevicePrompt({ operationLayer });
      await flush();
      h.page.emit('DeviceAccess.deviceRequestPrompted', {
        id: 'selection-by-id',
        devices: [{ id: 'candidate-id', name: 'candidate' }],
      });
      const prompt = await waiting;
      await prompt.selectById('candidate-id');
      expect(h.page.count('DeviceAccess.selectPrompt')).toBe(1);
      expect(prompt.settled).toBe(true);
      h.backend.invalidateFixturePage(operationLayer);
      await expect(prompt.selectById('candidate-id')).rejects.toMatchObject({
        context: {
          reason: 'fixture-page-closed',
          operation: 'selectById',
          operationLayer,
        },
      });
      await h.backend.stop();
    },
  );

  it('retains the first loss cause across cleanup and reports the current public operation', async () => {
    const h = await publicBackend({ commandDeadlineMs: 100 });
    const initialDisables = h.session.count('BluetoothEmulation.disable');
    const records: CdpLabInvalidation[] = [];
    h.backend.onInvalidated((record) => records.push(record));
    h.backend.noteFixtureDocumentChanged();
    const raw = missing();
    h.session.failures.set(stateMethod, raw);
    const first = await outcome(h.backend.setCentralState('powered-off'));
    expect(first).toBeInstanceOf(BluetoothBackendStoppedError);
    expect(first).toMatchObject({
      context: {
        reason: 'adapter-lost',
        operation: 'setCentralState',
        operationLayer: 'cdp',
        lifecycleState: 'invalidated',
        detectedBy: 'command-rejection',
        boundary: 'fixture-document-changed',
        remediation: 'new-test-fixture',
      },
    });
    expect((first as Error).cause).toBeInstanceOf(CdpTransportError);
    expect(((first as Error).cause as Error).cause).toBe(raw);
    h.backend.invalidateFixturePage('playwright');
    await flush();
    await h.backend.stop();
    const second = await outcome(h.backend.addPeripheral(model()));
    expect(second).toMatchObject({
      context: {
        reason: 'adapter-lost',
        operation: 'addPeripheral',
        boundary: 'fixture-document-changed',
      },
      cause: (first as Error).cause,
    });
    expect(records).toHaveLength(1);
    expect(Object.isFrozen(records[0])).toBe(true);
    expect(h.release).toHaveBeenCalledTimes(1);
    expect(h.session.count('BluetoothEmulation.disable')).toBe(
      initialDisables + 1,
    );
  });

  it.each([
    ['generic text', new Error('BluetoothEmulation not enabled')],
    ['other method', missing('BluetoothEmulation.simulateAdvertisement')],
    ['nested cause', new Error('outer', { cause: missing() })],
    ['plain shape', { message: missing().message }],
    [
      'unsupported command',
      new Error(
        `cdpSession.send: Protocol error (${stateMethod}): method not found`,
      ),
    ],
    ['session closure', new Error('Target closed')],
  ])('preserves %s without fabricating adapter loss', async (_label, raw) => {
    const h = await publicBackend({ commandDeadlineMs: 100 });
    h.session.failures.set(stateMethod, raw);
    const failure = await outcome(h.backend.setCentralState('powered-off'));
    expect(failure).toBeInstanceOf(CdpTransportError);
    expect((failure as Error).cause).toBe(raw);
    h.backend.assertUsable('setCentralState');
    await h.backend.setCentralState('powered-on');
    await h.backend.stop();
  });

  it.each(['live', 'check-failed', 'check-timed-out', 'adapter-lost'] as const)(
    'a hanging advertisement performs one deadline check with %s evidence and never replays',
    async (detection) => {
      const h = await publicBackend({ commandDeadlineMs: 100 });
      const peripheral = model();
      await h.backend.addPeripheral(peripheral);
      const method = 'BluetoothEmulation.simulateAdvertisement';
      const held = h.session.hold(method);
      const original = new Error('independent check failure');
      if (detection === 'check-failed')
        h.session.failures.set(stateMethod, original);
      if (detection === 'adapter-lost')
        h.session.failures.set(stateMethod, missing());
      const checkHeld =
        detection === 'check-timed-out'
          ? h.session.hold(stateMethod)
          : undefined;
      const initialStateSends = h.session.count(stateMethod);
      const result = outcome(h.backend.simulateAdvertisement(peripheral));
      await flush();
      h.time.advance(100);
      await flush();
      if (checkHeld) {
        h.time.advance(100);
        await flush();
      }
      const failure = await result;
      expect(h.timeline.snapshot()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'operation-timeout',
            data: expect.objectContaining({
              deadlineKind: 'command',
              deadlineMs: 100,
              checkDeadlineMs: 100,
              commandOutcome: 'unknown',
            }),
          }),
        ]),
      );
      if (detection === 'adapter-lost')
        expect(failure).toMatchObject({
          name: 'BluetoothBackendStoppedError',
          context: {
            reason: 'adapter-lost',
            detectedBy: 'liveness-check',
            operation: 'simulateAdvertisement',
          },
        });
      else
        expect(failure).toMatchObject({
          name: 'BluetoothTimeoutError',
          context: {
            operation: 'simulateAdvertisement',
            deadlineKind: 'command',
            deadlineMs: 100,
            checkDeadlineMs: 100,
            timeoutPhase: 'operation',
            detection,
            centralStateBlocked: false,
            remediation: 'inspect-operation',
          },
          cause: {
            name: 'BluetoothTimeoutError',
            context: { deadlineMs: 100, detection: 'not-checked' },
          },
        });
      if (detection === 'live')
        expect((failure as CdpCommandTimeout).deadlineCheck).toBeUndefined();
      if (detection === 'check-failed' || detection === 'check-timed-out') {
        const check = (failure as CdpCommandTimeout).deadlineCheck;
        expect(check).toMatchObject({
          timeoutPhase: 'deadline-check',
          deadlineKind: 'command',
          deadlineMs: 100,
          detection,
        });
        expect(Object.isFrozen(check)).toBe(true);
        expect(
          Object.getOwnPropertyDescriptor(failure, 'deadlineCheck'),
        ).toMatchObject({
          enumerable: false,
          writable: false,
          configurable: false,
        });
        if (detection === 'check-failed')
          expect(check?.cause).toMatchObject({
            name: 'CdpTransportError',
            cause: original,
          });
        else
          expect(check?.cause).toMatchObject({
            name: 'BluetoothTimeoutError',
            context: {
              timeoutPhase: 'entry-check',
              deadlineKind: 'command',
              deadlineMs: 100,
              detection: 'check-timed-out',
            },
          });
        expect(check?.cause).not.toBe((failure as Error).cause);
      }
      expect(h.session.count(method)).toBe(1);
      expect(h.session.count(stateMethod)).toBe(initialStateSends + 1);
      held.resolve({});
      checkHeld?.resolve({});
      await flush();
      if (detection === 'adapter-lost') {
        h.time.advance(20);
        await flush();
      }
      await outcome(h.backend.stop());
      expect(h.release).toHaveBeenCalledTimes(1);
    },
  );

  it('a hanging GATT response uses its command budget and detects adapter loss without a replay', async () => {
    const h = await publicBackend({
      commandDeadlineMs: 100,
      operationDeadlineMs: 1000,
    });
    const peripheral = model();
    await h.backend.addPeripheral(peripheral);
    const events: GattOperationEvent[] = [];
    h.backend.onEvent((event) => {
      if (event.kind === 'gatt-operation') events.push(event);
    });
    h.session.emit('BluetoothEmulation.gattOperationReceived', {
      address: peripheral.address,
      type: 'connection',
    });
    const event = events[0];
    if (!event) throw new Error('Missing GATT event');
    const method = 'BluetoothEmulation.simulateGATTOperationResponse';
    const held = h.session.hold(method);
    const result = outcome(
      h.backend.respondToGattOperation({
        operationId: event.operationId,
        type: 'connection',
        result: 'success',
      }),
    );
    await flush();
    h.session.failures.set(stateMethod, missing());
    h.time.advance(100);
    await flush();
    expect(await result).toMatchObject({
      name: 'BluetoothBackendStoppedError',
      context: {
        reason: 'adapter-lost',
        detectedBy: 'liveness-check',
        operation: 'respondToGattOperation',
      },
    });
    held.resolve({});
    await flush();
    h.time.advance(20);
    await flush();
    await outcome(h.backend.stop());
    expect(h.session.count(method)).toBe(1);
    expect(h.release).toHaveBeenCalledTimes(1);
  });

  it.each(['live', 'check-timed-out'] as const)(
    'pending-GATT application deadline remains primary across a %s command check',
    async (detection) => {
      const h = await publicBackend({
        commandDeadlineMs: 100,
        operationDeadlineMs: 1,
      });
      const peripheral = model();
      await h.backend.addPeripheral(peripheral);
      const events: GattOperationEvent[] = [];
      h.backend.onEvent((event) => {
        if (event.kind === 'gatt-operation') events.push(event);
      });
      h.session.emit('BluetoothEmulation.gattOperationReceived', {
        address: peripheral.address,
        type: 'connection',
      });
      const event = events[0];
      if (!event) throw new Error('Missing GATT event');
      const method = 'BluetoothEmulation.simulateGATTOperationResponse';
      const held = h.session.hold(method);
      const checkHeld =
        detection === 'check-timed-out'
          ? h.session.hold(stateMethod)
          : undefined;
      const result = outcome(
        h.backend.respondToGattOperation({
          operationId: event.operationId,
          type: 'connection',
          result: 'success',
        }),
      );
      await flush();
      h.time.advance(1);
      await flush();
      if (checkHeld) {
        h.time.advance(100);
        await flush();
      }
      expect(await result).toMatchObject({
        name: 'BluetoothTimeoutError',
        context: {
          operation: 'respondToGattOperation',
          deadlineKind: 'application-operation',
          deadlineMs: 1,
          checkDeadlineMs: 100,
          timeoutPhase: 'operation',
          detection,
        },
        cause: { name: 'BluetoothTimeoutError', context: { deadlineMs: 1 } },
      });
      expect(h.session.count(stateMethod)).toBe(1);
      expect(h.session.count(method)).toBe(1);
      held.resolve({});
      checkHeld?.resolve({});
      await flush();
      h.backend.assertUsable('respondToGattOperation');
      await h.backend.stop();
    },
  );

  it('default watchdog floor tolerates a slow live model command', async () => {
    const h = await publicBackend();
    const held = h.session.hold('BluetoothEmulation.addService');
    const result = outcome(h.backend.addPeripheral(model()));
    await flush();
    h.time.advance(29999);
    await flush();
    h.backend.assertUsable('addPeripheral');
    expect(h.session.count('BluetoothEmulation.addCharacteristic')).toBe(0);
    held.resolve({ serviceId: 'registered' });
    await expect(result).resolves.toBeUndefined();
    expect(h.session.count('BluetoothEmulation.addCharacteristic')).toBe(1);
    await h.backend.stop();
  });

  it('an explicit larger command override is not capped by the default floor', async () => {
    const h = await publicBackend({
      commandDeadlineMs: 45000,
      operationDeadlineMs: 1,
    });
    const held = h.session.hold('BluetoothEmulation.addService');
    const result = outcome(h.backend.addPeripheral(model()));
    await flush();
    h.time.advance(44999);
    await flush();
    h.backend.assertUsable('addPeripheral');
    expect(h.session.count('BluetoothEmulation.addCharacteristic')).toBe(0);
    held.resolve({ serviceId: 'registered' });
    await expect(result).resolves.toBeUndefined();
    await h.backend.stop();
  });

  it('the omitted command option is finite and expires at exactly thirty seconds', async () => {
    const h = await publicBackend();
    const held = h.session.hold('BluetoothEmulation.addService');
    const result = outcome(h.backend.addPeripheral(model()));
    await flush();
    h.time.advance(30000);
    await flush();
    expect(await result).toMatchObject({
      name: 'BluetoothBackendStoppedError',
      context: { reason: 'model-outcome-unknown' },
      cause: {
        name: 'BluetoothTimeoutError',
        context: {
          deadlineKind: 'command',
          deadlineMs: 30000,
          checkDeadlineMs: 30000,
        },
      },
    });
    held.resolve({ serviceId: 'late' });
    await flush();
    await outcome(h.backend.stop());
  });

  it('transport closure keeps its session-closed classification instead of becoming adapter loss', async () => {
    const h = await publicBackend({ commandDeadlineMs: 100 });
    h.session.emit('close', {});
    const failure = await outcome(h.backend.setCentralState('powered-off'));
    expect(failure).toMatchObject({
      name: 'CdpTransportError',
      kind: 'session-closed',
      target: 'browser',
    });
    h.backend.assertUsable('setCentralState');
    await outcome(h.backend.stop());
  });

  it.each([0, -1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1])(
    'validates commandDeadlineMs=%s before any startup send',
    async (commandDeadlineMs) => {
      const time = new ManualTime();
      const session = new Session();
      const page = new Session();
      expect(
        () =>
          new CdpBluetoothBackendFactory({
            browserName: 'chromium',
            browserTransport: createCdpTransport('browser', session),
            pageTransport: createCdpTransport('page', page),
            inspectWebBluetoothEnvironment: async () => ({
              secureContext: true,
              navigatorBluetooth: true,
            }),
            timeline: createBluetoothTimeline({ limit: 200, clock: time }),
            clock: time,
            deadlineScheduler: time,
            operationDeadlineMs: 1,
            commandDeadlineMs,
            promptDeadlineMs: 1,
            teardownDeadlineMs: 1,
            releaseLease: async () => undefined,
          }),
      ).toThrow();
      expect(session.calls).toHaveLength(0);
      expect(page.calls).toHaveLength(0);
    },
  );

  it('invalidates issued registration immediately and sends no remaining hierarchy commands after late acknowledgement', async () => {
    const h = await publicBackend({ commandDeadlineMs: 100 });
    const held = h.session.hold('BluetoothEmulation.addService');
    const records: CdpLabInvalidation[] = [];
    h.backend.onInvalidated((record) => records.push(record));
    const result = outcome(h.backend.addPeripheral(model()));
    await flush();
    h.time.advance(100);
    await flush();
    const failure = await result;
    expect(failure).toMatchObject({
      context: {
        reason: 'model-outcome-unknown',
        detectedBy: 'model-operation-aborted',
        operation: 'addPeripheral',
      },
      cause: {
        name: 'BluetoothTimeoutError',
        context: { deadlineKind: 'command', deadlineMs: 100 },
      },
    });
    held.resolve({ serviceId: 'too-late' });
    await flush();
    expect(h.session.count('BluetoothEmulation.addCharacteristic')).toBe(0);
    expect(await outcome(h.backend.addPeripheral(model()))).toBeInstanceOf(
      BluetoothBackendStoppedError,
    );
    await outcome(h.backend.stop());
    expect(records).toHaveLength(1);
    expect(h.release).toHaveBeenCalledTimes(1);
  });

  it('keeps caller cancellation primary after issued model effects and prevents late publication', async () => {
    const h = await publicBackend({ commandDeadlineMs: 100 });
    const held = h.session.hold('BluetoothEmulation.addService');
    const cancellation = createCancellationController();
    const result = outcome(
      h.backend.addPeripheral(model(), { cancellation: cancellation.signal }),
    );
    await flush();
    cancellation.cancel();
    expect(await result).toBeInstanceOf(BluetoothCancelledError);
    held.resolve({ serviceId: 'cancelled' });
    await flush();
    expect(() => h.backend.assertUsable('simulateAdvertisement')).toThrow(
      BluetoothBackendStoppedError,
    );
    expect(h.session.count('BluetoothEmulation.addCharacteristic')).toBe(0);
    await outcome(h.backend.stop());
  });

  it('pre-cancelled registration leaves the live model usable and sends nothing', async () => {
    const h = await publicBackend({ commandDeadlineMs: 100 });
    const cancellation = createCancellationController();
    cancellation.cancel();
    const count = h.session.calls.length;
    expect(
      await outcome(
        h.backend.addPeripheral(model(), { cancellation: cancellation.signal }),
      ),
    ).toBeInstanceOf(BluetoothCancelledError);
    expect(h.session.calls).toHaveLength(count);
    await h.backend.addPeripheral(model());
    await h.backend.stop();
  });

  it('an independent missing-binding mutation and teardown proceed while a state command has no reply', async () => {
    const h = await publicBackend({ commandDeadlineMs: 100 });
    await h.backend.addPeripheral(model());
    h.session.hold(stateMethod);
    const stateResult = outcome(h.backend.setCentralState('powered-off'));
    await flush();
    const method = 'BluetoothEmulation.simulateAdvertisement';
    h.session.failures.set(method, missing(method));
    expect(
      await outcome(h.backend.simulateAdvertisement(model())),
    ).toMatchObject({
      context: { reason: 'adapter-lost', operation: 'simulateAdvertisement' },
    });
    expect(await stateResult).toBeInstanceOf(BluetoothBackendStoppedError);
    await flush();
    h.time.advance(20);
    await flush();
    await outcome(h.backend.stop());
    expect(h.session.count(stateMethod)).toBe(1);
    expect(h.session.detached).toBe(true);
    expect(h.release).toHaveBeenCalledTimes(1);
  });
});

describe('deterministic underlying-command and deadline races', () => {
  it('a page-target DeviceAccess rejection never becomes browser adapter loss', async () => {
    const h = engine();
    const page = new Session();
    const transport = createCdpTransport('page', page);
    const method = 'DeviceAccess.cancelPrompt';
    const raw = missing(method);
    page.failures.set(method, raw);
    const failure = await outcome(
      h.lab.withBudget('cancel', 'cdp', async (token) => {
        await h.lab.scope(token).send(transport, method, { id: 'prompt' });
      }),
    );
    expect(failure).toMatchObject({
      name: 'CdpTransportError',
      target: 'page',
      kind: 'command-failed',
      cause: raw,
    });
    expect(h.lab.terminal).toBeUndefined();
    h.lab.assertUsable('cancel');
    expect(h.invalidated).not.toHaveBeenCalled();
  });

  it.each(['check-failed', 'check-timed-out'] as const)(
    'secondary %s evidence retains exact check and original timeout objects',
    async (detection) => {
      const h = engine();
      const raw = new Error('unrelated protocol rejection');
      const held =
        detection === 'check-timed-out'
          ? h.session.hold(stateMethod)
          : undefined;
      if (!held) h.session.failures.set(stateMethod, raw);
      const primary = new BluetoothTimeoutError('application wait expired', {
        context: { deadlineMs: 3 },
      });
      const actualCheck = h.lab.checkLiveness.bind(h.lab);
      let secondary: unknown;
      const spy = vi
        .spyOn(h.lab, 'checkLiveness')
        .mockImplementation(async (operation, layer) => {
          try {
            await actualCheck(operation, layer);
          } catch (cause) {
            secondary = cause;
            throw cause;
          }
        });
      const result = outcome(
        h.lab.diagnoseTimeout(
          'expectRead',
          'playwright',
          primary,
          'application-operation',
        ),
      );
      await flush();
      if (held) {
        h.time.advance(100);
        await flush();
      }
      const failure = (await result) as CdpCommandTimeout;
      expect(failure).toBeInstanceOf(BluetoothTimeoutError);
      expect(failure.cause).toBe(primary);
      expect(failure.context).toMatchObject({
        deadlineKind: 'application-operation',
        deadlineMs: 3,
        checkDeadlineMs: 100,
        timeoutPhase: 'operation',
        detection,
      });
      expect(failure.deadlineCheck).toMatchObject({
        timeoutPhase: 'deadline-check',
        deadlineKind: 'command',
        deadlineMs: 100,
        detection,
      });
      expect(failure.deadlineCheck?.cause).toBe(secondary);
      expect(Object.isFrozen(failure.deadlineCheck)).toBe(true);
      if (!held) expect((secondary as Error).cause).toBe(raw);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(h.session.count(stateMethod)).toBe(1);
      held?.resolve({});
      await flush();
      spy.mockRestore();
    },
  );

  it('a timed-out state send blocks checks without stale writes, then its late acknowledgement updates the next check state', async () => {
    const h = engine();
    const held = h.session.hold(stateMethod);
    const stateResult = outcome(
      h.lab.withBudget('setCentralState', 'cdp', async (token) =>
        h.lab.stateCommand(h.lab.scope(token), 'powered-off'),
      ),
    );
    await flush();
    h.time.advance(100);
    await flush();
    const entryResult = outcome(
      h.lab.checkLiveness('expectRead', 'playwright'),
    );
    await flush();
    h.time.advance(100);
    await flush();
    const stateFailure = await stateResult;
    const entryFailure = await entryResult;
    expect(stateFailure).toBeInstanceOf(BluetoothTimeoutError);
    expect(stateFailure).toMatchObject({
      context: {
        deadlineKind: 'command',
        deadlineMs: 100,
        timeoutPhase: 'operation',
        checkDeadlineMs: 100,
        detection: 'unconfirmed',
        centralStateBlocked: true,
        remediation: 'dispose-lab',
      },
    });
    const blockedCheck = (stateFailure as CdpCommandTimeout).deadlineCheck;
    expect(blockedCheck).toMatchObject({
      timeoutPhase: 'deadline-check',
      deadlineKind: 'command',
      deadlineMs: 100,
      detection: 'unconfirmed',
      cause: {
        name: 'BluetoothTimeoutError',
        context: {
          timeoutPhase: 'entry-check',
          detection: 'unconfirmed',
          centralStateBlocked: true,
          remediation: 'dispose-lab',
        },
      },
    });
    expect(Object.isFrozen(blockedCheck)).toBe(true);
    expect(blockedCheck?.cause).not.toBe((stateFailure as Error).cause);
    expect(entryFailure).toMatchObject({
      context: {
        timeoutPhase: 'entry-check',
        detection: 'unconfirmed',
        centralStateBlocked: true,
        remediation: 'dispose-lab',
      },
    });
    expect(h.session.count(stateMethod)).toBe(1);
    expect(h.lab.terminal).toBeUndefined();
    h.session.held.delete(stateMethod);
    held.resolve({});
    await flush();
    expect(h.lab.centralState).toBe('powered-off');
    await h.lab.checkLiveness('expectRead', 'playwright');
    expect(h.session.calls.at(-1)).toEqual({
      method: stateMethod,
      parameters: { state: 'powered-off' },
    });
    expect(h.session.count(stateMethod)).toBe(2);
  });

  it('an issued fence times out without recursive checks and holds serialization until raw settlement', async () => {
    const h = engine();
    const held = h.session.hold(stateMethod);
    const first = outcome(h.lab.checkLiveness('waitForDevicePrompt'));
    await flush();
    h.time.advance(100);
    await flush();
    expect(await first).toMatchObject({
      context: {
        timeoutPhase: 'entry-check',
        detection: 'check-timed-out',
        centralStateBlocked: false,
        remediation: 'inspect-operation',
      },
    });
    const second = outcome(h.lab.checkLiveness('select'));
    await flush();
    h.time.advance(100);
    await flush();
    expect(await second).toMatchObject({
      context: {
        detection: 'unconfirmed',
        centralStateBlocked: true,
        remediation: 'dispose-lab',
      },
    });
    expect(h.session.count(stateMethod)).toBe(1);
    h.session.held.delete(stateMethod);
    held.resolve({});
    await flush();
    await h.lab.checkLiveness('cancel');
    expect(h.session.count(stateMethod)).toBe(2);
  });

  it('cancelling a state send does not release its raw serialization ownership', async () => {
    const h = engine();
    const held = h.session.hold(stateMethod);
    const cancellation = createCancellationController();
    const stateResult = outcome(
      h.lab.withBudget(
        'setCentralState',
        'cdp',
        async (token) => h.lab.stateCommand(h.lab.scope(token), 'absent'),
        { cancellation: cancellation.signal },
      ),
    );
    await flush();
    cancellation.cancel();
    expect(await stateResult).toBeInstanceOf(BluetoothCancelledError);
    const checkResult = outcome(h.lab.checkLiveness('expectRead'));
    await flush();
    h.time.advance(100);
    await flush();
    expect(await checkResult).toMatchObject({
      context: { detection: 'unconfirmed' },
    });
    expect(h.session.count(stateMethod)).toBe(1);
    h.session.held.delete(stateMethod);
    held.resolve({});
    await flush();
    await h.lab.checkLiveness('waitForWrite');
    expect(h.session.calls.at(-1)?.parameters).toEqual({ state: 'absent' });
  });

  it.each(['fixture-page-closed', 'adapter-lost'] as const)(
    'late state success cannot reopen %s',
    async (reason) => {
      const h = engine();
      const held = h.session.hold(stateMethod);
      const result = outcome(
        h.lab.withBudget('setCentralState', 'cdp', async (token) =>
          h.lab.stateCommand(h.lab.scope(token), 'absent'),
        ),
      );
      await flush();
      h.lab.invalidate(
        reason,
        'setCentralState',
        'cdp',
        reason === 'adapter-lost' ? 'command-rejection' : 'fixture-page-close',
      );
      expect(await result).toBeInstanceOf(BluetoothBackendStoppedError);
      held.resolve({});
      await flush();
      expect(h.lab.centralState).toBe('powered-on');
      expect(() => h.lab.assertUsable('expectRead')).toThrow(
        BluetoothBackendStoppedError,
      );
    },
  );

  it('deadline before the first model effect leaves the lab usable and prevents delayed sends', async () => {
    const h = engine();
    const gate = deferred<undefined>();
    const result = outcome(
      h.lab.withBudget('createPeripheral', 'playwright', async (token) => {
        await gate.promise;
        await h.lab.withBudget(
          'addPeripheral',
          'cdp',
          async (nested) => {
            await h.lab
              .scope(nested)
              .send(h.transport, 'BluetoothEmulation.addService', {
                address: model().address,
                serviceUuid: '180f',
              });
          },
          token,
        );
      }),
    );
    await flush();
    h.time.advance(100);
    await flush();
    expect(await result).toMatchObject({
      name: 'BluetoothTimeoutError',
      context: {
        deadlineKind: 'command',
        detection: 'not-checked',
        timeoutPhase: 'operation',
      },
    });
    expect(h.session.count(stateMethod)).toBe(0);
    expect(h.lab.terminal).toBeUndefined();
    gate.resolve(undefined);
    await flush();
    expect(h.session.count('BluetoothEmulation.addService')).toBe(0);
    h.lab.assertUsable('createPeripheral');
  });

  it('logical clock expiry after an acknowledged nested model send prevents publication even before the scheduler callback', async () => {
    const h = engine();
    let published = false;
    const result = outcome(
      h.lab.withBudget(
        'createPeripheral',
        'playwright',
        async (token, commit) => {
          await h.lab.withBudget(
            'addPeripheral',
            'cdp',
            async (nested) => {
              await h.lab
                .scope(nested)
                .send(h.transport, 'BluetoothEmulation.addService', {
                  address: model().address,
                  serviceUuid: '180f',
                });
            },
            token,
          );
          h.time.elapseWithoutCallbacks(100);
          commit();
          published = true;
        },
      ),
    );
    expect(await result).toMatchObject({
      name: 'BluetoothBackendStoppedError',
      context: {
        reason: 'model-outcome-unknown',
        operation: 'createPeripheral',
        operationLayer: 'playwright',
      },
      cause: {
        name: 'BluetoothTimeoutError',
        context: { deadlineKind: 'command', deadlineMs: 100 },
      },
    });
    expect(published).toBe(false);
    expect(h.invalidated).toHaveBeenCalledTimes(1);
    expect(h.session.count(stateMethod)).toBe(0);
    expect(h.session.count('BluetoothEmulation.addService')).toBe(1);
  });

  it('nested model commands share one original budget including intermediate work', async () => {
    const h = engine();
    const second = h.session.hold('BluetoothEmulation.addService');
    let published = false;
    const result = outcome(
      h.lab.withBudget(
        'createPeripheral',
        'playwright',
        async (token, commit) => {
          await h.lab.withBudget(
            'addPeripheral',
            'cdp',
            async (nested) => {
              await h.lab
                .scope(nested)
                .send(
                  h.transport,
                  'BluetoothEmulation.simulatePreconnectedPeripheral',
                  {
                    address: model().address,
                    name: 'lifecycle',
                    manufacturerData: [],
                    knownServiceUuids: [],
                  },
                );
            },
            token,
          );
          h.time.advance(80);
          await h.lab.withBudget(
            'addPeripheral',
            'cdp',
            async (nested) => {
              await h.lab
                .scope(nested)
                .send(h.transport, 'BluetoothEmulation.addService', {
                  address: model().address,
                  serviceUuid: '180f',
                });
            },
            token,
          );
          commit();
          published = true;
        },
      ),
    );
    await flush();
    h.time.advance(20);
    await flush();
    expect(await result).toMatchObject({
      name: 'BluetoothBackendStoppedError',
      context: {
        reason: 'model-outcome-unknown',
        operation: 'createPeripheral',
        operationLayer: 'playwright',
      },
      cause: { context: { deadlineMs: 100 } },
    });
    second.resolve({ serviceId: 'late' });
    await flush();
    expect(published).toBe(false);
    expect(h.session.count('BluetoothEmulation.addService')).toBe(1);
  });

  it('blocks a parallel model continuation after its composed operation failed before the command deadline', async () => {
    const h = engine();
    const gate = deferred<undefined>();
    const primary = new Error('composed operation failed');
    let continuation!: Promise<unknown>;
    await expect(
      h.lab.withBudget('createPeripheral', 'playwright', async (token) => {
        continuation = outcome(
          (async () => {
            await gate.promise;
            await h.lab
              .scope(token)
              .send(h.transport, 'BluetoothEmulation.addService', {
                address: model().address,
                serviceUuid: '180f',
              });
          })(),
        );
        throw primary;
      }),
    ).rejects.toBe(primary);
    h.time.advance(1);
    gate.resolve(undefined);
    const failure = await continuation;
    expect(failure).toBeInstanceOf(BluetoothCancelledError);
    expect(failure).toMatchObject({
      message: 'The Bluetooth command phase has ended.',
      context: { operation: 'createPeripheral' },
    });
    expect(h.session.count('BluetoothEmulation.addService')).toBe(0);
    expect(h.lab.terminal).toBeUndefined();
    h.lab.assertUsable('createPeripheral');
  });

  it('blocks nested work using a token from a successfully ended command phase before its deadline', async () => {
    const h = engine();
    const token = await h.lab.withBudget(
      'createPeripheral',
      'playwright',
      async (options) => options,
    );
    h.time.advance(1);
    const work = vi.fn(async (options: typeof token) => {
      await h.lab
        .scope(options)
        .send(h.transport, 'BluetoothEmulation.addService', {
          address: model().address,
          serviceUuid: '180f',
        });
    });
    const failure = await outcome(
      Promise.resolve().then(() =>
        h.lab.withBudget('addPeripheral', 'cdp', work, token),
      ),
    );
    expect(failure).toBeInstanceOf(BluetoothCancelledError);
    expect(failure).toMatchObject({
      message: 'The Bluetooth command phase has ended.',
      context: { operation: 'createPeripheral' },
    });
    expect(work).not.toHaveBeenCalled();
    expect(h.session.count('BluetoothEmulation.addService')).toBe(0);
    expect(h.lab.terminal).toBeUndefined();
    h.lab.assertUsable('addPeripheral');
  });

  it('cancellation after work starts but before any model send is nonterminal', async () => {
    const h = engine();
    const gate = deferred<undefined>();
    const cancellation = createCancellationController();
    const result = outcome(
      h.lab.withBudget(
        'createPeripheral',
        'playwright',
        async (token) => {
          await gate.promise;
          await h.lab
            .scope(token)
            .send(h.transport, 'BluetoothEmulation.addService', {
              address: model().address,
              serviceUuid: '180f',
            });
        },
        { cancellation: cancellation.signal },
      ),
    );
    await flush();
    cancellation.cancel();
    expect(await result).toBeInstanceOf(BluetoothCancelledError);
    expect(h.lab.terminal).toBeUndefined();
    gate.resolve(undefined);
    await flush();
    expect(h.session.count('BluetoothEmulation.addService')).toBe(0);
    h.lab.assertUsable('createPeripheral');
  });

  it('late state success after explicit disposal does not update committed state', async () => {
    const h = engine();
    const held = h.session.hold(stateMethod);
    const result = outcome(
      h.lab.withBudget('setCentralState', 'cdp', async (token) =>
        h.lab.stateCommand(h.lab.scope(token), 'absent'),
      ),
    );
    await flush();
    h.lab.stop();
    held.resolve({});
    await flush();
    expect(await result).toBeUndefined();
    expect(h.lab.centralState).toBe('powered-on');
    expect(h.lab.terminal).toBeUndefined();
    expect(h.session.count(stateMethod)).toBe(1);
  });

  it('ordinary stop that wins first is retained over later fixture closure', async () => {
    const h = engine();
    const listener = vi.fn();
    h.lab.onInvalidated(listener);
    h.lab.stop();
    h.lab.invalidateFixturePage('playwright');
    expect(h.lab.terminal).toBeUndefined();
    expect(listener).not.toHaveBeenCalled();
    expect(() => h.lab.assertUsable('createPeripheral')).toThrow(
      BluetoothBackendStoppedError,
    );
  });

  it('concurrent invalidation rejects active scopes once, retains first evidence, and tolerates a throwing observer', async () => {
    const h = engine();
    const held = deferred<undefined>();
    const records: CdpLabInvalidation[] = [];
    h.lab.onInvalidated(() => {
      throw new Error('observer');
    });
    h.lab.onInvalidated((record) => records.push(record));
    const left = outcome(
      h.lab.withBudget(
        'simulateAdvertisement',
        'cdp',
        async () => held.promise,
      ),
    );
    const right = outcome(
      h.lab.withBudget(
        'respondToGattOperation',
        'playwright',
        async () => held.promise,
      ),
    );
    await flush();
    const cause = missing();
    h.lab.invalidate(
      'adapter-lost',
      'simulateAdvertisement',
      'cdp',
      'command-rejection',
      cause,
    );
    h.lab.invalidateFixturePage('playwright');
    expect(await left).toMatchObject({
      context: { operation: 'simulateAdvertisement', reason: 'adapter-lost' },
      cause,
    });
    expect(await right).toMatchObject({
      context: {
        operation: 'respondToGattOperation',
        operationLayer: 'playwright',
        reason: 'adapter-lost',
      },
      cause,
    });
    expect(records).toHaveLength(1);
    expect(h.invalidated).toHaveBeenCalledTimes(1);
    const lateObserver = vi.fn();
    h.lab.onInvalidated(lateObserver);
    expect(lateObserver).toHaveBeenCalledWith(records[0]);
    held.resolve(undefined);
    await flush();
    expect(h.invalidated).toHaveBeenCalledTimes(1);
  });
});
