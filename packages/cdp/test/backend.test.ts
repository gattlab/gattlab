import {
  BluetoothBackendStoppedError,
  BluetoothCancelledError,
  BluetoothLabAlreadyActiveError,
  createBluetoothTimeline,
  createCancellationController,
  validatePeripheralDefinition,
  type BluetoothTimeline,
  type GattOperationEvent,
  type MonotonicClock,
  type NormalizedPeripheral,
} from '@gattlab/core';
import { describe, expect, it, vi } from 'vitest';

import {
  CdpBluetoothBackendFactory,
  type CdpBackendDeadlineScheduler,
  type CdpBluetoothBackend,
} from '../src/backend.js';
import type { OperationDeadline } from '../src/pending-operation-registry.js';
import {
  CdpTransportError,
  createCdpTransport,
  type CdpSessionLike,
} from '../src/transport.js';

interface SentCommand {
  readonly method: string;
  readonly parameters?: object;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(cause: unknown): void;
}

function createDeferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | undefined;
  let rejectPromise: ((cause: unknown) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve(value) {
      if (resolvePromise === undefined) throw new Error('Missing resolver.');
      resolvePromise(value);
    },
    reject(cause) {
      if (rejectPromise === undefined) throw new Error('Missing rejecter.');
      rejectPromise(cause);
    },
  };
}

class BackendCdpSession implements CdpSessionLike {
  readonly calls: SentCommand[] = [];
  readonly listeners = new Map<string, Set<(payload: unknown) => void>>();
  readonly order: string[];
  readonly #held = new Map<string, Deferred<unknown>>();
  readonly #failures = new Map<string, unknown[]>();
  #nextService = 0;
  #nextCharacteristic = 0;
  #nextDescriptor = 0;
  detached = false;
  rejectHeldOnDetach = true;

  constructor(
    readonly name: 'browser' | 'page',
    order: string[],
  ) {
    this.order = order;
  }

  async send(method: string, parameters?: object): Promise<unknown> {
    this.calls.push({
      method,
      ...(parameters === undefined ? {} : { parameters }),
    });
    this.order.push(`${this.name}:${method}`);
    const failures = this.#failures.get(method);
    const failure = failures?.shift();
    if (failure !== undefined) throw failure;
    const held = this.#held.get(method);
    if (held !== undefined) return held.promise;
    switch (method) {
      case 'Browser.getVersion':
        return {
          product: 'HeadlessChrome/159.0.8154.6',
          protocolVersion: '1.3',
          userAgent: 'Mozilla/5.0 (Macintosh) HeadlessChrome/159.0.8154.6',
        };
      case 'BluetoothEmulation.addService':
        this.#nextService += 1;
        return { serviceId: `service-${String(this.#nextService)}` };
      case 'BluetoothEmulation.addCharacteristic':
        this.#nextCharacteristic += 1;
        return {
          characteristicId: `characteristic-${String(this.#nextCharacteristic)}`,
        };
      case 'BluetoothEmulation.addDescriptor':
        this.#nextDescriptor += 1;
        return { descriptorId: `descriptor-${String(this.#nextDescriptor)}` };
      default:
        return {};
    }
  }

  on(event: string, listener: (payload: unknown) => void): void {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
  }

  off(event: string, listener: (payload: unknown) => void): void {
    this.listeners.get(event)?.delete(listener);
  }

  async detach(): Promise<void> {
    this.order.push(`${this.name}:detach`);
    this.detached = true;
    if (this.rejectHeldOnDetach) {
      for (const held of this.#held.values()) {
        held.reject(new Error(`${this.name} session detached`));
      }
      this.#held.clear();
    }
  }

  emit(event: string, payload: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(payload);
  }

  hold(method: string): Deferred<unknown> {
    const deferred = createDeferred<unknown>();
    this.#held.set(method, deferred);
    return deferred;
  }

  failNext(method: string, cause: unknown): void {
    const failures = this.#failures.get(method) ?? [];
    failures.push(cause);
    this.#failures.set(method, failures);
  }

  failOnCall(method: string, call: number, cause: unknown): void {
    const failures = this.#failures.get(method) ?? [];
    while (failures.length < call - 1) failures.push(undefined);
    failures.push(cause);
    this.#failures.set(method, failures);
  }

  listenerCount(event: string): number {
    return this.listeners.get(event)?.size ?? 0;
  }
}

class FakeTime implements MonotonicClock, CdpBackendDeadlineScheduler {
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

  schedule(deadlineMs: number, onDeadline: () => void): OperationDeadline {
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

interface BackendHarness {
  readonly backend: CdpBluetoothBackend;
  readonly browserSession: BackendCdpSession;
  readonly flushedSnapshots: readonly unknown[][];
  readonly order: string[];
  readonly pageSession: BackendCdpSession;
  readonly releaseLease: ReturnType<typeof vi.fn>;
  readonly time: FakeTime;
  readonly timeline: BluetoothTimeline;
}

async function createHarness(): Promise<BackendHarness> {
  const order: string[] = [];
  const browserSession = new BackendCdpSession('browser', order);
  const pageSession = new BackendCdpSession('page', order);
  const time = new FakeTime();
  const timeline = createBluetoothTimeline({ limit: 200, clock: time });
  const flushedSnapshots: unknown[][] = [];
  const releaseLease = vi.fn(async () => {
    order.push('lease:release');
  });
  const backend = await new CdpBluetoothBackendFactory({
    browserName: 'chromium',
    browserTransport: createCdpTransport('browser', browserSession),
    pageTransport: createCdpTransport('page', pageSession),
    inspectWebBluetoothEnvironment: async () => ({
      secureContext: true,
      navigatorBluetooth: true,
    }),
    timeline,
    clock: time,
    deadlineScheduler: time,
    operationDeadlineMs: 50,
    promptDeadlineMs: 50,
    teardownDeadlineMs: 20,
    async flushArtifacts(events) {
      order.push('artifacts:flush');
      flushedSnapshots.push([...events]);
    },
    releaseLease,
  }).start({ centralState: 'powered-on' });
  return {
    backend,
    browserSession,
    flushedSnapshots,
    order,
    pageSession,
    releaseLease,
    time,
    timeline,
  };
}

function normalizedPeripheral(options?: {
  readonly address?: string;
  readonly explicitScanFields?: boolean;
}): NormalizedPeripheral {
  const result = validatePeripheralDefinition({
    address: options?.address ?? '00:11:22:33:44:55',
    name: 'Backend sensor',
    advertisement: {
      rssi: -42,
      name: 'Backend sensor',
      ...(options?.explicitScanFields === true
        ? { appearance: 0, txPower: -4 }
        : {}),
    },
    services: [],
  });
  if (!result.success) throw new Error('Expected a valid peripheral fixture.');
  return result.value;
}

function normalizedHierarchy(): NormalizedPeripheral {
  const result = validatePeripheralDefinition({
    address: '00:11:22:33:44:66',
    name: 'Integrated hierarchy sensor',
    advertisement: { rssi: -42 },
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
  if (!result.success) throw new Error('Expected a valid hierarchy fixture.');
  return result.value;
}

async function flushPromiseQueue(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

describe('CdpBluetoothBackendFactory', () => {
  it('composes every operation-family listener and live prompt diagnostics', async () => {
    const harness = await createHarness();
    const peripheral = normalizedHierarchy();
    await harness.backend.addPeripheral(peripheral);
    const receivedKinds: string[] = [];
    harness.backend.onEvent((event) => receivedKinds.push(event.kind));

    harness.browserSession.emit('BluetoothEmulation.gattOperationReceived', {
      address: peripheral.address,
      type: 'connection',
    });
    harness.browserSession.emit(
      'BluetoothEmulation.characteristicOperationReceived',
      { characteristicId: 'characteristic-1', type: 'read' },
    );
    harness.browserSession.emit(
      'BluetoothEmulation.descriptorOperationReceived',
      { descriptorId: 'descriptor-1', type: 'read' },
    );
    expect(receivedKinds).toEqual([
      'gatt-operation',
      'characteristic-operation',
      'descriptor-operation',
    ]);

    const waiting = harness.backend.waitForDevicePrompt();
    const timeoutOutcome = waiting.then(
      () => undefined,
      (cause: unknown) => cause,
    );
    for (let index = 0; index < 40; index += 1) await Promise.resolve(); // Complete entry fence before advancing the full arrival budget.
    harness.time.advanceBy(50);
    expect(await timeoutOutcome).toMatchObject({
      name: 'BluetoothTimeoutError',
      context: {
        centralState: 'powered-on',
        knownPeripherals: [peripheral.address],
        advertisementsSent: 0,
      },
    });

    await harness.backend.stop();
  });

  it('integrates mutations, scan-default diagnostics, and ordered close-last teardown', async () => {
    const harness = await createHarness();
    const peripheral = normalizedPeripheral();
    const advertisementRequest = normalizedPeripheral({
      explicitScanFields: true,
    });

    await harness.backend.addPeripheral(peripheral);
    await harness.backend.simulateAdvertisement(advertisementRequest);
    await harness.backend.setCentralState('powered-off');

    const advertisement = harness.timeline
      .snapshot()
      .find(
        (event) =>
          event.type === 'advertisement' && event.status === 'succeeded',
      );
    expect(advertisement?.data).toMatchObject({
      appearanceSubstituted: true,
      txPowerSubstituted: true,
      txPowerSubstitutionApplicationVisible: true,
    });
    expect(
      harness.browserSession.calls.some(
        (call) =>
          call.method === 'BluetoothEmulation.simulateAdvertisement' &&
          JSON.stringify(call.parameters).includes(
            '"appearance":0,"txPower":0',
          ),
      ),
    ).toBe(true);

    const firstStop = harness.backend.stop();
    const secondStop = harness.backend.stop();
    expect(secondStop).toBe(firstStop);
    await firstStop;

    expect(harness.order.slice(-6)).toEqual([
      'page:DeviceAccess.disable',
      'browser:BluetoothEmulation.disable',
      'page:detach',
      'browser:detach',
      'artifacts:flush',
      'lease:release',
    ]);
    expect(harness.flushedSnapshots).toHaveLength(1);
    expect(harness.releaseLease).toHaveBeenCalledOnce();
    expect(harness.timeline.closed).toBe(true);
    expect(() => harness.backend.onEvent(() => undefined)).toThrow(
      BluetoothBackendStoppedError,
    );
    await expect(
      harness.backend.setCentralState('powered-on'),
    ).rejects.toBeInstanceOf(BluetoothBackendStoppedError);
    expect(
      harness.browserSession.listenerCount(
        'BluetoothEmulation.gattOperationReceived',
      ),
    ).toBe(0);
  });

  it('cancels a pending peripheral operation before simulated disconnection and records a late completion', async () => {
    const harness = await createHarness();
    const peripheral = normalizedHierarchy();
    await harness.backend.addPeripheral(peripheral);
    const events: GattOperationEvent[] = [];
    harness.backend.onEvent((event) => {
      if (event.kind === 'gatt-operation') events.push(event);
    });

    harness.browserSession.emit('BluetoothEmulation.gattOperationReceived', {
      address: peripheral.address,
      type: 'connection',
    });
    const event = events[0];
    if (event === undefined) throw new Error('Expected a GATT operation.');
    const heldResponse = harness.browserSession.hold(
      'BluetoothEmulation.simulateGATTOperationResponse',
    );
    const response = harness.backend.respondToGattOperation({
      operationId: event.operationId,
      type: 'connection',
      result: 'success',
    });
    const responseOutcome = response.then(
      () => undefined,
      (cause: unknown) => cause,
    );
    await flushPromiseQueue();

    await harness.backend.disconnect(peripheral.address);
    expect(await responseOutcome).toBeInstanceOf(BluetoothCancelledError);
    heldResponse.resolve({});
    await flushPromiseQueue();

    expect(
      harness.timeline
        .snapshot()
        .some(
          (entry) =>
            entry.type === 'operation-late-completion' &&
            entry.operationId === event.operationId &&
            entry.data?.['completion'] === 'protocol-success',
        ),
    ).toBe(true);
    const cancelIndex = harness.timeline
      .snapshot()
      .findIndex((entry) => entry.type === 'operation-cancelled');
    const disconnectIndex = harness.browserSession.calls.findIndex(
      (call) => call.method === 'BluetoothEmulation.simulateGATTDisconnection',
    );
    expect(cancelIndex).toBeGreaterThan(-1);
    expect(disconnectIndex).toBeGreaterThan(-1);

    expect(
      harness.timeline
        .snapshot()
        .find((entry) => entry.type === 'peripheral-hierarchy-rehydration'),
    ).toMatchObject({
      category: 'peripheral',
      type: 'peripheral-hierarchy-rehydration',
      status: 'succeeded',
      data: { source: 'scripted-disconnection' },
    });
    expect(
      harness.browserSession.calls.filter(
        (call) => call.method === 'BluetoothEmulation.addCharacteristic',
      ),
    ).toHaveLength(2);
    await harness.backend.simulateAdvertisement(peripheral);
    expect(
      harness.browserSession.calls.filter(
        (call) => call.method === 'BluetoothEmulation.addCharacteristic',
      ),
    ).toHaveLength(2);
    await harness.backend.stop();
  });

  it('uses structural call cancellation to interrupt a response without reversing its terminal state', async () => {
    const harness = await createHarness();
    const peripheral = normalizedPeripheral();
    await harness.backend.addPeripheral(peripheral);
    const events: GattOperationEvent[] = [];
    harness.backend.onEvent((event) => {
      if (event.kind === 'gatt-operation') events.push(event);
    });
    harness.browserSession.emit('BluetoothEmulation.gattOperationReceived', {
      address: peripheral.address,
      type: 'connection',
    });
    const event = events[0];
    if (event === undefined) throw new Error('Expected a GATT operation.');
    const heldResponse = harness.browserSession.hold(
      'BluetoothEmulation.simulateGATTOperationResponse',
    );
    const cancellation = createCancellationController();
    const response = harness.backend.respondToGattOperation(
      {
        operationId: event.operationId,
        type: 'connection',
        result: 'success',
      },
      { cancellation: cancellation.signal },
    );
    const responseOutcome = response.then(
      () => undefined,
      (cause: unknown) => cause,
    );
    await flushPromiseQueue();

    cancellation.cancel();
    expect(await responseOutcome).toMatchObject({
      name: 'BluetoothCancelledError',
      context: expect.objectContaining({
        cancellationReason: 'caller-cancelled',
      }),
    });
    heldResponse.resolve({});
    await flushPromiseQueue();
    expect(
      harness.timeline
        .snapshot()
        .some(
          (entry) =>
            entry.type === 'operation-late-completion' &&
            entry.operationId === event.operationId &&
            entry.status === 'cancelled',
        ),
    ).toBe(true);
    await harness.backend.stop();
  });

  it('rejects a cancelled ordinary call promptly and records its protocol completion as late', async () => {
    const harness = await createHarness();
    const heldStateChange = harness.browserSession.hold(
      'BluetoothEmulation.setSimulatedCentralState',
    );
    const cancellation = createCancellationController();
    const stateChange = harness.backend.setCentralState('powered-off', {
      cancellation: cancellation.signal,
    });
    const stateChangeOutcome = stateChange.then(
      () => undefined,
      (cause: unknown) => cause,
    );
    await flushPromiseQueue();

    cancellation.cancel();
    expect(await stateChangeOutcome).toMatchObject({
      name: 'BluetoothCancelledError',
      context: { operation: 'central-state' },
    });
    heldStateChange.resolve({});
    await flushPromiseQueue();

    expect(harness.timeline.snapshot()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'central-state',
          status: 'cancelled',
        }),
        expect.objectContaining({
          type: 'backend-call-late-completion',
          status: 'cancelled',
          data: expect.objectContaining({
            completion: 'protocol-success',
            operationType: 'central-state',
          }),
        }),
      ]),
    );
    await harness.backend.stop();
  });

  it('detaches before bounded settlement so an in-flight mutation records its late failure before artifact flush', async () => {
    const harness = await createHarness();
    const peripheral = normalizedPeripheral();
    await harness.backend.addPeripheral(peripheral);
    const events: GattOperationEvent[] = [];
    harness.backend.onEvent((event) => {
      if (event.kind === 'gatt-operation') events.push(event);
    });
    harness.browserSession.emit('BluetoothEmulation.gattOperationReceived', {
      address: peripheral.address,
      type: 'connection',
    });
    const event = events[0];
    if (event === undefined) throw new Error('Expected a GATT operation.');
    harness.browserSession.hold(
      'BluetoothEmulation.simulateGATTOperationResponse',
    );
    const response = harness.backend.respondToGattOperation({
      operationId: event.operationId,
      type: 'connection',
      result: 'success',
    });
    const responseOutcome = response.then(
      () => undefined,
      (cause: unknown) => cause,
    );
    await flushPromiseQueue();

    await harness.backend.stop();
    expect(await responseOutcome).toBeInstanceOf(BluetoothCancelledError);

    const flushed = harness.flushedSnapshots[0] ?? [];
    expect(flushed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'operation-late-completion',
          operationId: event.operationId,
          status: 'cancelled',
          data: expect.objectContaining({ completion: 'protocol-failure' }),
        }),
        expect.objectContaining({
          type: 'pending-operation-settlement',
          status: 'succeeded',
        }),
      ]),
    );
    expect(harness.time.pendingDeadlineCount).toBe(0);
    expect(harness.order.indexOf('browser:detach')).toBeLessThan(
      harness.order.indexOf('artifacts:flush'),
    );
    expect(harness.order.indexOf('artifacts:flush')).toBeLessThan(
      harness.order.indexOf('lease:release'),
    );
  });

  it('settles an ordinary in-flight backend call before closing the timeline', async () => {
    const harness = await createHarness();
    harness.browserSession.hold('BluetoothEmulation.setSimulatedCentralState');
    const stateChange = harness.backend.setCentralState('powered-off');
    const stateChangeOutcome = stateChange.then(
      () => undefined,
      (cause: unknown) => cause,
    );
    await flushPromiseQueue();

    await harness.backend.stop();

    expect(await stateChangeOutcome).toMatchObject({
      name: 'CdpTransportError',
      kind: 'session-closed',
      method: 'BluetoothEmulation.setSimulatedCentralState',
    });
    expect(harness.flushedSnapshots[0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'central-state',
          status: 'failed',
        }),
      ]),
    );
    expect(harness.timeline.closed).toBe(true);
  });

  it('records settlement expiry, closes, and releases the lease when detach cannot settle a mutation', async () => {
    const harness = await createHarness();
    const peripheral = normalizedPeripheral();
    await harness.backend.addPeripheral(peripheral);
    const events: GattOperationEvent[] = [];
    harness.backend.onEvent((event) => {
      if (event.kind === 'gatt-operation') events.push(event);
    });
    harness.browserSession.emit('BluetoothEmulation.gattOperationReceived', {
      address: peripheral.address,
      type: 'connection',
    });
    const event = events[0];
    if (event === undefined) throw new Error('Expected a GATT operation.');
    harness.browserSession.rejectHeldOnDetach = false;
    const heldResponse = harness.browserSession.hold(
      'BluetoothEmulation.simulateGATTOperationResponse',
    );
    const response = harness.backend.respondToGattOperation({
      operationId: event.operationId,
      type: 'connection',
      result: 'success',
    });
    const responseOutcome = response.then(
      () => undefined,
      (cause: unknown) => cause,
    );
    await flushPromiseQueue();

    const stopping = harness.backend.stop();
    for (let index = 0; index < 40; index += 1) await Promise.resolve();
    // Pending-request cancellation has settled the public delivery budget; raw send is still observed.
    expect(harness.time.pendingDeadlineCount).toBe(1);
    harness.time.advanceBy(20);
    await expect(stopping).rejects.toThrow('pending-operations.settled');
    expect(await responseOutcome).toBeInstanceOf(BluetoothCancelledError);
    expect(harness.timeline.closed).toBe(true);
    expect(harness.releaseLease).toHaveBeenCalledOnce();
    expect(harness.flushedSnapshots[0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'cleanup-step',
          status: 'timed-out',
          data: expect.objectContaining({
            step: 'pending-operations.settled',
          }),
        }),
      ]),
    );
    heldResponse.resolve({});
    await flushPromiseQueue();
  });

  it('preserves a late ordinary-call success after settlement expiry closes the timeline', async () => {
    const harness = await createHarness();
    harness.browserSession.rejectHeldOnDetach = false;
    const heldStateChange = harness.browserSession.hold(
      'BluetoothEmulation.setSimulatedCentralState',
    );
    const stateChange = harness.backend.setCentralState('powered-off');
    await flushPromiseQueue();

    const stopping = harness.backend.stop();
    for (let index = 0; index < 40; index += 1) await Promise.resolve();
    // Original finite command budget remains tracked beside independent teardown settlement.
    expect(harness.time.pendingDeadlineCount).toBe(2);
    harness.time.advanceBy(20);
    await expect(stopping).rejects.toThrow('pending-operations.settled');
    expect(harness.timeline.closed).toBe(true);

    heldStateChange.resolve({});
    await expect(stateChange).resolves.toBeUndefined();
  });

  it('preserves a late ordinary-call protocol failure after settlement expiry closes the timeline', async () => {
    const harness = await createHarness();
    harness.browserSession.rejectHeldOnDetach = false;
    const heldStateChange = harness.browserSession.hold(
      'BluetoothEmulation.setSimulatedCentralState',
    );
    const stateChange = harness.backend.setCentralState('powered-off');
    const stateChangeOutcome = stateChange.then(
      () => undefined,
      (cause: unknown) => cause,
    );
    await flushPromiseQueue();

    const stopping = harness.backend.stop();
    for (let index = 0; index < 40; index += 1) await Promise.resolve();
    // Original finite command budget remains tracked beside independent teardown settlement.
    expect(harness.time.pendingDeadlineCount).toBe(2);
    harness.time.advanceBy(20);
    await expect(stopping).rejects.toThrow('pending-operations.settled');
    expect(harness.timeline.closed).toBe(true);

    const protocolFailure = new Error('late central-state transport failure');
    heldStateChange.reject(protocolFailure);
    const outcome = await stateChangeOutcome;
    expect(outcome).toBeInstanceOf(CdpTransportError);
    expect(outcome).toMatchObject({
      kind: 'session-closed',
      method: 'BluetoothEmulation.setSimulatedCentralState',
      cause: protocolFailure,
    });
  });

  it('attempts every cleanup step after a failure and reports it only after closing', async () => {
    const harness = await createHarness();
    harness.pageSession.failNext(
      'DeviceAccess.disable',
      new Error('device access disable failed'),
    );

    await expect(harness.backend.stop()).rejects.toThrow(
      'DeviceAccess.disable',
    );
    expect(harness.browserSession.detached).toBe(true);
    expect(harness.pageSession.detached).toBe(true);
    expect(harness.releaseLease).toHaveBeenCalledOnce();
    expect(harness.timeline.closed).toBe(true);
  });

  it('preserves the startup failure while fully unwinding the acquired lease', async () => {
    const order: string[] = [];
    const browserSession = new BackendCdpSession('browser', order);
    const pageSession = new BackendCdpSession('page', order);
    const time = new FakeTime();
    const timeline = createBluetoothTimeline({ limit: 100, clock: time });
    const failure = new Error('production DeviceAccess enable failed');
    pageSession.failOnCall('DeviceAccess.enable', 2, failure);
    const releaseLease = vi.fn(async () => {
      order.push('lease:release');
    });

    const starting = new CdpBluetoothBackendFactory({
      browserName: 'chromium',
      browserTransport: createCdpTransport('browser', browserSession),
      pageTransport: createCdpTransport('page', pageSession),
      inspectWebBluetoothEnvironment: async () => ({
        secureContext: true,
        navigatorBluetooth: true,
      }),
      timeline,
      clock: time,
      deadlineScheduler: time,
      operationDeadlineMs: 50,
      promptDeadlineMs: 50,
      teardownDeadlineMs: 20,
      async flushArtifacts(events) {
        expect(
          events.some(
            (event) =>
              event.type === 'backend-start' && event.status === 'failed',
          ),
        ).toBe(true);
        order.push('artifacts:flush');
      },
      releaseLease,
    }).start({ centralState: 'powered-on' });

    await expect(starting).rejects.toMatchObject({
      name: 'CdpTransportError',
      method: 'DeviceAccess.enable',
      cause: failure,
    });
    expect(browserSession.detached).toBe(true);
    expect(pageSession.detached).toBe(true);
    expect(order.slice(-2)).toEqual(['artifacts:flush', 'lease:release']);
    expect(releaseLease).toHaveBeenCalledOnce();
    expect(timeline.closed).toBe(true);
  });

  it('maps a backend enable race and never disables the foreign domain', async () => {
    const order: string[] = [];
    const browserSession = new BackendCdpSession('browser', order);
    const pageSession = new BackendCdpSession('page', order);
    const time = new FakeTime();
    const timeline = createBluetoothTimeline({ limit: 100, clock: time });
    const rawCause = new Error(
      'Protocol error (BluetoothEmulation.enable): BluetoothEmulation already enabled',
    );
    browserSession.failOnCall('BluetoothEmulation.enable', 2, rawCause);
    const releaseLease = vi.fn(async () => {
      order.push('lease:release');
    });

    const starting = new CdpBluetoothBackendFactory({
      browserName: 'chromium',
      browserTransport: createCdpTransport('browser', browserSession),
      pageTransport: createCdpTransport('page', pageSession),
      inspectWebBluetoothEnvironment: async () => ({
        secureContext: true,
        navigatorBluetooth: true,
      }),
      timeline,
      clock: time,
      deadlineScheduler: time,
      operationDeadlineMs: 50,
      promptDeadlineMs: 50,
      teardownDeadlineMs: 20,
      releaseLease,
    }).start({ centralState: 'powered-on' });

    const error = await starting.catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(BluetoothLabAlreadyActiveError);
    expect(error).toMatchObject({
      context: {
        leaseScope: 'browser-process',
        remediation: 'use-separate-browser-process',
        detection: 'cdp-domain-conflict',
      },
      cause: {
        name: 'CdpTransportError',
        method: 'BluetoothEmulation.enable',
        cause: rawCause,
      },
    });
    expect(order).toEqual([
      'browser:Browser.getVersion',
      'browser:BluetoothEmulation.enable',
      'page:DeviceAccess.enable',
      'page:DeviceAccess.disable',
      'browser:BluetoothEmulation.disable',
      'browser:BluetoothEmulation.enable',
      'page:detach',
      'browser:detach',
      'lease:release',
    ]);
    expect(releaseLease).toHaveBeenCalledOnce();
    expect(timeline.closed).toBe(true);
  });

  it('keeps attempted cleanup for an unrelated backend enable failure', async () => {
    const order: string[] = [];
    const browserSession = new BackendCdpSession('browser', order);
    const pageSession = new BackendCdpSession('page', order);
    const time = new FakeTime();
    const timeline = createBluetoothTimeline({ limit: 100, clock: time });
    const rawCause = new Error(
      'Protocol error (BluetoothEmulation.enable): another rejection',
    );
    browserSession.failOnCall('BluetoothEmulation.enable', 2, rawCause);

    const starting = new CdpBluetoothBackendFactory({
      browserName: 'chromium',
      browserTransport: createCdpTransport('browser', browserSession),
      pageTransport: createCdpTransport('page', pageSession),
      inspectWebBluetoothEnvironment: async () => ({
        secureContext: true,
        navigatorBluetooth: true,
      }),
      timeline,
      clock: time,
      deadlineScheduler: time,
      operationDeadlineMs: 50,
      promptDeadlineMs: 50,
      teardownDeadlineMs: 20,
      releaseLease: async () => undefined,
    }).start({ centralState: 'powered-on' });

    await expect(starting).rejects.toMatchObject({
      name: 'CdpTransportError',
      method: 'BluetoothEmulation.enable',
      cause: rawCause,
    });
    expect(order).toEqual([
      'browser:Browser.getVersion',
      'browser:BluetoothEmulation.enable',
      'page:DeviceAccess.enable',
      'page:DeviceAccess.disable',
      'browser:BluetoothEmulation.disable',
      'browser:BluetoothEmulation.enable',
      'browser:BluetoothEmulation.disable',
      'page:detach',
      'browser:detach',
    ]);
    expect(timeline.closed).toBe(true);
  });

  it('unwinds sessions and the lease when startup is already cancelled', async () => {
    const order: string[] = [];
    const browserSession = new BackendCdpSession('browser', order);
    const pageSession = new BackendCdpSession('page', order);
    const time = new FakeTime();
    const timeline = createBluetoothTimeline({ limit: 100, clock: time });
    const releaseLease = vi.fn(async () => {
      order.push('lease:release');
    });
    const cancellation = createCancellationController();
    cancellation.cancel();

    const starting = new CdpBluetoothBackendFactory({
      browserName: 'chromium',
      browserTransport: createCdpTransport('browser', browserSession),
      pageTransport: createCdpTransport('page', pageSession),
      inspectWebBluetoothEnvironment: async () => ({
        secureContext: true,
        navigatorBluetooth: true,
      }),
      timeline,
      clock: time,
      deadlineScheduler: time,
      operationDeadlineMs: 50,
      promptDeadlineMs: 50,
      teardownDeadlineMs: 20,
      releaseLease,
    }).start({
      centralState: 'powered-on',
      cancellation: cancellation.signal,
    });

    await expect(starting).rejects.toBeInstanceOf(BluetoothCancelledError);
    expect(browserSession.calls).toEqual([]);
    expect(pageSession.calls).toEqual([]);
    expect(browserSession.detached).toBe(true);
    expect(pageSession.detached).toBe(true);
    expect(releaseLease).toHaveBeenCalledOnce();
    expect(timeline.closed).toBe(true);
  });
});
