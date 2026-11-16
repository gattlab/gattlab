import {
  BluetoothBackendStoppedError,
  BluetoothCancelledError,
  BluetoothCapabilityUnsupportedError,
  BluetoothLabAlreadyActiveError,
  BluetoothValidationError,
  BluetoothTimeoutError,
  type BackendStartOptions,
  type MonotonicClock,
} from '@gattlab/core';
import type {
  CdpBackendDeadlineScheduler,
  CdpBluetoothBackend,
  CdpBluetoothBackendFactoryOptions,
  CdpSessionLike,
  CdpLabInvalidation,
} from '@gattlab/cdp';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { describe, expect, it, vi } from 'vitest';

import {
  GattLabDiagnosticBuffer,
  type GattLabDiagnosticSnapshot,
} from '../src/diagnostics.js';
import {
  prepareGattLabRuntime,
  type GattLabRuntimeController,
  type GattLabRuntimeDependencies,
} from '../src/runtime.js';

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(cause: unknown): void;
}

interface FactoryInvocation {
  readonly options: CdpBluetoothBackendFactoryOptions;
  readonly startOptions: BackendStartOptions;
}

type FactoryBehavior = (
  invocation: FactoryInvocation,
) => Promise<CdpBluetoothBackend>;

function deferred<T>(): Deferred<T> {
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

class FakeCdpSession implements CdpSessionLike {
  readonly order: string[];
  readonly name: string;
  #detachFailure: unknown;
  detachCalls = 0;

  constructor(name: string, order: string[]) {
    this.name = name;
    this.order = order;
  }

  async send(): Promise<unknown> {
    return {};
  }

  on(): void {
    return undefined;
  }

  off(): void {
    return undefined;
  }

  async detach(): Promise<void> {
    this.detachCalls += 1;
    this.order.push(`${this.name}:detach`);
    if (this.#detachFailure !== undefined) throw this.#detachFailure;
  }

  failDetachWith(cause: unknown): void {
    this.#detachFailure = cause;
  }
}

class SessionSource {
  readonly sessions: FakeCdpSession[] = [];
  readonly #name: string;
  readonly #order: string[];
  readonly #queued: Promise<CdpSessionLike>[] = [];
  calls = 0;

  constructor(name: string, order: string[]) {
    this.#name = name;
    this.#order = order;
  }

  queue(result: Promise<CdpSessionLike>): void {
    this.#queued.push(result);
  }

  next(): Promise<CdpSessionLike> {
    this.calls += 1;
    const queued = this.#queued.shift();
    if (queued !== undefined) return queued;
    const session = new FakeCdpSession(
      `${this.#name}-${String(this.calls)}`,
      this.#order,
    );
    this.sessions.push(session);
    return Promise.resolve(session);
  }
}

interface RuntimeHarness {
  readonly browser: Browser;
  readonly browserSessions: SessionSource;
  readonly context: BrowserContext;
  readonly diagnostics: GattLabDiagnosticBuffer;
  readonly factoryOptions: CdpBluetoothBackendFactoryOptions[];
  readonly factoryInvocations: FactoryInvocation[];
  readonly order: string[];
  readonly page: Page;
  readonly pageSessions: SessionSource;
  readonly runtime: GattLabRuntimeController;
  closePage(): void;
  invalidateBackend(record: CdpLabInvalidation): void;
  documentChanged(): void;
  readonly pageListeners: Map<string, Set<() => void>>;
}

function createHarness(
  options: {
    readonly browser?: Browser;
    readonly browserName?: string;
    readonly fixtureOptions?: Parameters<
      typeof prepareGattLabRuntime
    >[0]['options'];
    readonly playwrightVersion?: string;
    readonly factoryBehavior?: FactoryBehavior;
    readonly failClockWith?: unknown;
    readonly failFactoryWith?: unknown;
  } = {},
): RuntimeHarness {
  const backendInvalidationListeners = new Set<
    (record: CdpLabInvalidation) => void
  >();
  let terminal: CdpLabInvalidation | undefined;
  const invalidateBackend = (record: CdpLabInvalidation): void => {
    if (terminal !== undefined) return;
    terminal = record;
    for (const listener of backendInvalidationListeners) listener(record);
  };
  const order: string[] = [];
  const browserSessions = new SessionSource('browser', order);
  const pageSessions = new SessionSource('page', order);
  const browser =
    options.browser ??
    ({
      newBrowserCDPSession: () => browserSessions.next(),
    } as unknown as Browser);
  const context = {
    newCDPSession: () => pageSessions.next(),
  } as unknown as BrowserContext;
  const pageListeners = new Map<string, Set<() => void>>();
  let pageClosed = false;
  const page = {
    on(event: string, listener: () => void) {
      const listeners = pageListeners.get(event) ?? new Set<() => void>();
      listeners.add(listener);
      pageListeners.set(event, listeners);
    },
    off(event: string, listener: () => void) {
      pageListeners.get(event)?.delete(listener);
    },
    isClosed: () => pageClosed,
    evaluate: async () => ({ secureContext: true, navigatorBluetooth: true }),
  } as unknown as Page;
  const factoryInvocations: FactoryInvocation[] = [];
  const factoryOptions: CdpBluetoothBackendFactoryOptions[] = [];
  const diagnostics = new GattLabDiagnosticBuffer({
    playwrightVersion: options.playwrightVersion ?? '1.65.1',
    headless: true,
    connection: 'launch',
  });
  const clock: MonotonicClock = { now: () => 0 };
  const scheduler: CdpBackendDeadlineScheduler = {
    schedule: () => ({ cancel: () => undefined }),
  };
  const defaultFactoryBehavior: FactoryBehavior = async ({ options }) => {
    const stop = vi.fn(async () => {
      order.push('backend:stop');
      await options.pageTransport.detach();
      await options.browserTransport.detach();
      await options.releaseLease();
      order.push('lease:released');
    });
    return { stop } as unknown as CdpBluetoothBackend;
  };
  const factoryBehavior = options.factoryBehavior ?? defaultFactoryBehavior;
  const dependencies: GattLabRuntimeDependencies = {
    createClock() {
      if (options.failClockWith !== undefined) throw options.failClockWith;
      return clock;
    },
    createDeadlineScheduler: () => scheduler,
    createBackendFactory(optionsForFactory) {
      factoryOptions.push(optionsForFactory);
      if (options.failFactoryWith !== undefined) {
        throw options.failFactoryWith;
      }
      return {
        start(startOptions) {
          const invocation = { options: optionsForFactory, startOptions };
          factoryInvocations.push(invocation);
          return factoryBehavior(invocation).then((backend) => {
            // Preserve backend identity while supplying the lifecycle integration
            // surface that every real CDP backend exposes.
            return Object.assign(backend, {
              onInvalidated:
                backend.onInvalidated ??
                ((listener: (record: CdpLabInvalidation) => void) => {
                  backendInvalidationListeners.add(listener);
                  return () => {
                    backendInvalidationListeners.delete(listener);
                  };
                }),
              assertUsable: backend.assertUsable ?? (() => undefined),
              invalidateFixturePage:
                backend.invalidateFixturePage ??
                (() =>
                  invalidateBackend({
                    reason: 'fixture-page-closed',
                    lifecycleState: 'invalidated',
                    operation: 'waitForDevicePrompt',
                    operationLayer: 'playwright',
                    detectedBy: 'fixture-page-close',
                    boundary: 'fixture-page-closed',
                    remediation: 'new-test-fixture',
                  })),
              noteFixtureDocumentChanged:
                backend.noteFixtureDocumentChanged ?? (() => undefined),
            });
          });
        },
      };
    },
  };
  const runtime = prepareGattLabRuntime(
    {
      browserName: options.browserName ?? 'chromium',
      browser,
      context,
      page,
      options: options.fixtureOptions,
      diagnostics,
    },
    dependencies,
  );

  return {
    browser,
    browserSessions,
    context,
    diagnostics,
    factoryOptions,
    factoryInvocations,
    order,
    page,
    pageSessions,
    runtime,
    pageListeners,
    invalidateBackend,
    closePage() {
      pageClosed = true;
      for (const listener of pageListeners.get('close') ?? []) listener();
    },
    documentChanged() {
      for (const listener of pageListeners.get('domcontentloaded') ?? [])
        listener();
    },
  };
}

async function flushPromises(): Promise<void> {
  for (let index = 0; index < 6; index += 1) await Promise.resolve(undefined);
}

describe('GattLabRuntimeController preparation', () => {
  it.each(['firefox', 'webkit'])(
    'rejects %s before either session is requested',
    (browserName) => {
      const order: string[] = [];
      const browserSessions = new SessionSource('browser', order);
      const browser = {
        newBrowserCDPSession: () => browserSessions.next(),
      } as unknown as Browser;

      expect(() =>
        prepareGattLabRuntime({
          browserName,
          browser,
          context: {} as BrowserContext,
          page: {} as Page,
          options: undefined,
        }),
      ).toThrow(BluetoothCapabilityUnsupportedError);
      expect(browserSessions.calls).toBe(0);
    },
  );

  it('rejects invalid options before either session is requested', () => {
    const order: string[] = [];
    const browserSessions = new SessionSource('browser', order);
    const browser = {
      newBrowserCDPSession: () => browserSessions.next(),
    } as unknown as Browser;

    expect(() =>
      prepareGattLabRuntime({
        browserName: 'chromium',
        browser,
        context: {} as BrowserContext,
        page: {} as Page,
        options: { operationTimeoutMs: 0 },
      }),
    ).toThrow(BluetoothValidationError);
    expect(browserSessions.calls).toBe(0);
  });
});

describe('GattLabRuntimeController lifecycle', () => {
  it('tears down an idle runtime without acquiring a lease or session', async () => {
    const harness = createHarness();

    const firstStop = harness.runtime.stop();
    const secondStop = harness.runtime.stop();

    expect(secondStop).toBe(firstStop);
    await firstStop;
    expect(harness.runtime.state).toBe('stopped');
    expect(harness.browserSessions.calls).toBe(0);
    expect(harness.pageSessions.calls).toBe(0);
    expect(harness.factoryInvocations).toHaveLength(0);
    await expect(harness.runtime.start()).rejects.toBeInstanceOf(
      BluetoothBackendStoppedError,
    );
  });

  it('shares one promise, backend, lease, and session pair across starts', async () => {
    const backendResult = deferred<CdpBluetoothBackend>();
    const backend = {
      stop: vi.fn(async () => undefined),
    } as unknown as CdpBluetoothBackend;
    const harness = createHarness({
      factoryBehavior: () => backendResult.promise,
    });

    const firstStart = harness.runtime.start();
    const secondStart = harness.runtime.start();

    expect(secondStart).toBe(firstStart);
    await flushPromises();
    expect(harness.factoryInvocations).toHaveLength(1);
    backendResult.resolve(backend);
    await expect(firstStart).resolves.toBe(backend);
    expect(harness.runtime.start()).toBe(firstStart);
    expect(harness.browserSessions.calls).toBe(1);
    expect(harness.pageSessions.calls).toBe(1);
    await harness.runtime.stop();
    expect(backend.stop).toHaveBeenCalledOnce();
    await expect(harness.runtime.start()).rejects.toBeInstanceOf(
      BluetoothBackendStoppedError,
    );
  });

  it('runs an operation synchronously when the shared backend is ready', async () => {
    const harness = createHarness();
    const backend = await harness.runtime.start();
    let operationEntered = false;

    const result = harness.runtime.withBackend((receivedBackend) => {
      operationEntered = true;
      return Promise.resolve(receivedBackend);
    });

    expect(operationEntered).toBe(true);
    await expect(result).resolves.toBe(backend);
    await harness.runtime.stop();
  });

  it('waits for a controllably pending backend stop', async () => {
    const stopEntered = deferred<undefined>();
    const allowStop = deferred<undefined>();
    const harness = createHarness({
      async factoryBehavior({ options }) {
        return {
          async stop() {
            stopEntered.resolve(undefined);
            await allowStop.promise;
            await options.pageTransport.detach();
            await options.browserTransport.detach();
            await options.releaseLease();
          },
        } as unknown as CdpBluetoothBackend;
      },
    });
    await harness.runtime.start();

    const stop = harness.runtime.stop();
    await stopEntered.promise;
    let settled = false;
    void stop.then(() => {
      settled = true;
    });
    await flushPromises();
    expect(settled).toBe(false);
    expect(harness.runtime.state).toBe('stopping');

    allowStop.resolve(undefined);
    await stop;
    expect(harness.runtime.state).toBe('stopped');
  });

  it('rejects a same-Browser competitor before requesting its sessions', async () => {
    const first = createHarness();
    await first.runtime.start();
    const competitor = createHarness({ browser: first.browser });

    const conflict = competitor.runtime.start();

    await expect(conflict).rejects.toBeInstanceOf(
      BluetoothLabAlreadyActiveError,
    );
    expect(first.browserSessions.calls).toBe(1);
    expect(first.pageSessions.calls).toBe(1);
    expect(competitor.pageSessions.calls).toBe(0);
    await first.runtime.stop();
  });

  it('preserves a page-session failure and cleans browser then lease', async () => {
    const primary = new Error('page session failed');
    const harness = createHarness();
    harness.pageSessions.queue(Promise.reject(primary));

    await expect(harness.runtime.start()).rejects.toBe(primary);
    expect(harness.browserSessions.sessions[0]?.detachCalls).toBe(1);
    expect(harness.diagnostics.snapshot()).toMatchObject({
      timelines: [],
      runtimeFailures: [
        {
          stage: 'runtime-start',
          name: 'Error',
          message: 'page session failed',
        },
      ],
    });

    const later = createHarness({ browser: harness.browser });
    await later.runtime.start();
    await later.runtime.stop();
  });

  it('preserves a browser-session failure and releases the lease', async () => {
    const primary = new Error('browser session failed');
    const harness = createHarness();
    harness.browserSessions.queue(Promise.reject(primary));

    await expect(harness.runtime.start()).rejects.toBe(primary);
    expect(harness.pageSessions.calls).toBe(0);

    const later = createHarness({ browser: harness.browser });
    await later.runtime.start();
    await later.runtime.stop();
  });

  it('best-effort cleans page, browser, and lease after local setup failure', async () => {
    const primary = new Error('clock failed');
    const harness = createHarness({ failClockWith: primary });

    await expect(harness.runtime.start()).rejects.toBe(primary);
    expect(harness.order).toEqual(['page-1:detach', 'browser-1:detach']);

    const later = createHarness({ browser: harness.browser });
    await later.runtime.start();
    await later.runtime.stop();
  });

  it('records pre-start cleanup failures without replacing the primary error', async () => {
    const primary = new Error('factory construction failed');
    const detachFailure = new TypeError('page detach failed');
    const harness = createHarness({ failFactoryWith: primary });
    const pageSession = new FakeCdpSession('failing-page', harness.order);
    pageSession.failDetachWith(detachFailure);
    harness.pageSessions.queue(Promise.resolve(pageSession));

    await expect(harness.runtime.start()).rejects.toBe(primary);
    expect(pageSession.detachCalls).toBe(1);
    expect(harness.browserSessions.sessions[0]?.detachCalls).toBe(1);
    const timeline = harness.factoryOptions[0]?.timeline;
    expect(timeline).toBeDefined();
    expect(timeline?.closed).toBe(true);
    expect(timeline?.snapshot()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: 'lifecycle',
          type: 'cleanup-step',
          status: 'failed',
          data: {
            reason: 'TypeError',
            step: 'page-session.detach',
          },
        }),
      ]),
    );
    expect(harness.diagnostics.snapshot()).toMatchObject({
      timelines: [
        {
          owner: 'playwright-runtime',
          events: [
            expect.objectContaining({
              type: 'cleanup-step',
              status: 'failed',
            }),
          ],
        },
      ],
      runtimeFailures: [
        {
          stage: 'runtime-start',
          message: 'factory construction failed',
        },
      ],
    });

    const later = createHarness({ browser: harness.browser });
    await later.runtime.start();
    await later.runtime.stop();
  });

  it('cancels before factory start while the browser session is pending', async () => {
    const heldSession = deferred<CdpSessionLike>();
    const harness = createHarness();
    harness.browserSessions.queue(heldSession.promise);

    const start = harness.runtime.start();
    const stop = harness.runtime.stop();
    let stopped = false;
    void stop.then(() => {
      stopped = true;
    });
    await flushPromises();
    expect(stopped).toBe(false);

    const session = new FakeCdpSession('held-browser', harness.order);
    heldSession.resolve(session);

    await expect(start).rejects.toBeInstanceOf(BluetoothCancelledError);
    await stop;
    expect(session.detachCalls).toBe(1);
    expect(harness.factoryInvocations).toHaveLength(0);
    const later = createHarness({ browser: harness.browser });
    await later.runtime.start();
    await later.runtime.stop();
  });

  it('cancels before factory start while the page session is pending', async () => {
    const heldSession = deferred<CdpSessionLike>();
    const harness = createHarness();
    harness.pageSessions.queue(heldSession.promise);

    const start = harness.runtime.start();
    await flushPromises();
    const stop = harness.runtime.stop();
    const pageSession = new FakeCdpSession('held-page', harness.order);
    heldSession.resolve(pageSession);

    await expect(start).rejects.toBeInstanceOf(BluetoothCancelledError);
    await stop;
    expect(pageSession.detachCalls).toBe(1);
    expect(harness.browserSessions.sessions[0]?.detachCalls).toBe(1);
    expect(harness.factoryInvocations).toHaveLength(0);
  });

  it('leaves cancellation cleanup exclusively to the invoked factory', async () => {
    const factoryEntered = deferred<undefined>();
    const factoryFinished = deferred<undefined>();
    const harness = createHarness({
      async factoryBehavior({ options, startOptions }) {
        const pageDetach = vi.spyOn(options.pageTransport, 'detach');
        const browserDetach = vi.spyOn(options.browserTransport, 'detach');
        factoryEntered.resolve(undefined);
        await new Promise<void>((resolve) => {
          startOptions.cancellation?.onCancelled(resolve);
        });
        await options.pageTransport.detach();
        await options.browserTransport.detach();
        await options.releaseLease();
        factoryFinished.resolve(undefined);
        expect(pageDetach).toHaveBeenCalledOnce();
        expect(browserDetach).toHaveBeenCalledOnce();
        throw new BluetoothCancelledError('Factory startup cancelled.');
      },
    });

    const start = harness.runtime.start();
    await factoryEntered.promise;
    const stop = harness.runtime.stop();
    await factoryFinished.promise;

    await expect(start).rejects.toBeInstanceOf(BluetoothCancelledError);
    await stop;
    const invocation = harness.factoryInvocations[0];
    expect(invocation).toBeDefined();
    expect(
      invocation === undefined ? 0 : invocation.options.pageTransport.detach,
    ).toHaveBeenCalledOnce();
    expect(
      invocation === undefined ? 0 : invocation.options.browserTransport.detach,
    ).toHaveBeenCalledOnce();

    const later = createHarness({ browser: harness.browser });
    await later.runtime.start();
    await later.runtime.stop();
  });

  it('does not repeat cleanup after an invoked factory rejects startup', async () => {
    const primary = new Error('backend startup failed');
    const harness = createHarness({
      async factoryBehavior({ options }) {
        const pageDetach = vi.spyOn(options.pageTransport, 'detach');
        const browserDetach = vi.spyOn(options.browserTransport, 'detach');
        await options.pageTransport.detach();
        await options.browserTransport.detach();
        await options.releaseLease();
        expect(pageDetach).toHaveBeenCalledOnce();
        expect(browserDetach).toHaveBeenCalledOnce();
        throw primary;
      },
    });

    await expect(harness.runtime.start()).rejects.toBe(primary);
    const invocation = harness.factoryInvocations[0];
    expect(invocation).toBeDefined();
    expect(
      invocation === undefined ? 0 : invocation.options.pageTransport.detach,
    ).toHaveBeenCalledOnce();
    expect(
      invocation === undefined ? 0 : invocation.options.browserTransport.detach,
    ).toHaveBeenCalledOnce();

    const later = createHarness({ browser: harness.browser });
    await later.runtime.start();
    await later.runtime.stop();
  });

  it('reports teardown failure only after the backend releases the lease', async () => {
    const teardownFailure = new BluetoothCancelledError('teardown failed');
    const harness = createHarness({
      async factoryBehavior({ options }) {
        return {
          async stop() {
            await options.pageTransport.detach();
            await options.browserTransport.detach();
            await options.releaseLease();
            throw teardownFailure;
          },
        } as unknown as CdpBluetoothBackend;
      },
    });
    await harness.runtime.start();

    await expect(harness.runtime.stop()).rejects.toBe(teardownFailure);
    expect(harness.runtime.state).toBe('stopped');
    expect(harness.diagnostics.snapshot().runtimeFailures).toEqual([
      expect.objectContaining({
        stage: 'runtime-stop',
        code: 'BLUETOOTH_CANCELLED',
        message: 'teardown failed',
      }),
    ]);
    const later = createHarness({ browser: harness.browser });
    await later.runtime.start();
    await later.runtime.stop();
  });

  it('captures the backend-owned snapshot through its artifact callback', async () => {
    const harness = createHarness({
      async factoryBehavior({ options }) {
        options.timeline.append({
          category: 'lifecycle',
          type: 'test-backend-start',
          status: 'succeeded',
        });
        return {
          timeline: options.timeline,
          async stop() {
            await options.flushArtifacts?.(options.timeline.snapshot());
            await options.pageTransport.detach();
            await options.browserTransport.detach();
            await options.releaseLease();
            options.timeline.close();
          },
        } as unknown as CdpBluetoothBackend;
      },
    });

    const backend = await harness.runtime.start();
    await harness.runtime.stop();
    const snapshot: GattLabDiagnosticSnapshot = harness.diagnostics.snapshot();

    expect(snapshot.timelines).toMatchObject([
      {
        owner: 'cdp-backend',
        events: [
          {
            category: 'lifecycle',
            type: 'test-backend-start',
            status: 'succeeded',
          },
        ],
      },
    ]);
    expect(backend.timeline.closed).toBe(true);
  });

  it('captures the validated baseline and records its timeline classification', async () => {
    const harness = createHarness({
      async factoryBehavior({ options }) {
        return {
          capabilities: {
            browserName: 'chromium',
            browserProduct: 'HeadlessChrome/159.0.8154.6',
            browserVersion: '159.0.8154.6',
            protocolVersion: '1.3',
            domains: { bluetoothEmulation: true, deviceAccess: true },
            operations: {
              centralState: true,
              advertisement: true,
              preconnectedPeripheral: true,
              services: true,
              secondaryServices: false,
              characteristics: true,
              descriptors: true,
              connectionResponse: true,
              discoveryResponse: true,
              characteristicReadWrite: true,
              descriptorReadWrite: true,
              subscriptionResponse: true,
              gattDisconnect: true,
              nativeNotificationPayload: false,
            },
          },
          timeline: options.timeline,
          async stop() {
            await options.flushArtifacts?.(options.timeline.snapshot());
            await options.pageTransport.detach();
            await options.browserTransport.detach();
            await options.releaseLease();
            options.timeline.close();
          },
        } as CdpBluetoothBackend;
      },
    });

    await harness.runtime.start();
    await harness.runtime.stop();

    expect(harness.diagnostics.snapshot().capabilityDiagnostics).toMatchObject({
      compatibility: { status: 'validated', mismatches: [] },
    });
    expect(harness.diagnostics.snapshot().timelines[0]?.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: 'diagnostic',
          type: 'compatibility-baseline',
          data: expect.objectContaining({ status: 'validated' }),
        }),
      ]),
    );
  });
});

describe('fixture lifecycle propagation', () => {
  it.each(['browser-session', 'page-session', 'factory'] as const)(
    'never publishes a backend after fixture closure during %s startup',
    async (stage) => {
      const heldSession = deferred<CdpSessionLike>();
      const factoryEntered = deferred<undefined>();
      const factoryContinue = deferred<undefined>();
      const harness = createHarness({
        async factoryBehavior({ options }) {
          factoryEntered.resolve(undefined);
          await factoryContinue.promise;
          return {
            async stop() {
              await options.pageTransport.detach();
              await options.browserTransport.detach();
              await options.releaseLease();
            },
          } as unknown as CdpBluetoothBackend;
        },
      });
      if (stage === 'browser-session')
        harness.browserSessions.queue(heldSession.promise);
      if (stage === 'page-session')
        harness.pageSessions.queue(heldSession.promise);
      const callback = vi.fn(async () => 'published');
      const operation = harness.runtime.withBackend(
        callback,
        'createPeripheral',
      );
      const rejection = expect(operation).rejects.toMatchObject({
        code: 'BLUETOOTH_BACKEND_STOPPED',
        context: {
          reason: 'fixture-page-closed',
          lifecycleState: 'invalidated',
          operation: 'createPeripheral',
          operationLayer: 'playwright',
          detectedBy: 'fixture-page-close',
          boundary: 'fixture-page-closed',
          remediation: 'new-test-fixture',
        },
      });
      if (stage === 'factory') await factoryEntered.promise;
      else await flushPromises();
      harness.closePage();
      const competitor = createHarness({ browser: harness.browser });
      await expect(competitor.runtime.start()).rejects.toBeInstanceOf(
        BluetoothLabAlreadyActiveError,
      );
      if (stage === 'factory') factoryContinue.resolve(undefined);
      else
        heldSession.resolve(
          new FakeCdpSession('pending-startup-session', harness.order),
        );
      await rejection;
      await harness.runtime.stop();
      expect(callback).not.toHaveBeenCalled();
      expect(harness.runtime.state).toBe('stopped');
      expect(
        [...harness.pageListeners.values()].every(
          (listeners) => listeners.size === 0,
        ),
      ).toBe(true);
      const browserCallsBeforeReuse = harness.browserSessions.calls;
      const next = createHarness({ browser: harness.browser });
      await next.runtime.start();
      await next.runtime.stop();
      expect(harness.browserSessions.calls).toBe(browserCallsBeforeReuse + 1);
      expect(next.pageSessions.calls).toBe(1);
    },
  );

  it('retains the first backend reason with public names through stopping and stopped cleanup', async () => {
    const allowStop = deferred<undefined>();
    const harness = createHarness({
      async factoryBehavior({ options }) {
        return {
          async stop() {
            await allowStop.promise;
            await options.pageTransport.detach();
            await options.browserTransport.detach();
            await options.releaseLease();
          },
        } as unknown as CdpBluetoothBackend;
      },
    });
    await harness.runtime.start();
    const notifications: CdpLabInvalidation[] = [];
    harness.runtime.onInvalidated((record) => notifications.push(record));
    const cause = new Error('first adapter rejection');
    const record: CdpLabInvalidation = {
      reason: 'adapter-lost',
      lifecycleState: 'invalidated',
      operation: 'simulateAdvertisement',
      operationLayer: 'cdp',
      detectedBy: 'command-rejection',
      boundary: 'fixture-document-changed',
      remediation: 'new-test-fixture',
      cause,
    };
    harness.invalidateBackend(record);
    Object.assign(record, { reason: 'model-outcome-unknown' });
    expect(harness.runtime.state).toBe('stopping');
    for (const operation of [
      'createPeripheral',
      'setState',
      'select',
      'cancel',
    ]) {
      expect(() =>
        harness.runtime.withBackend(vi.fn(), operation),
      ).toThrowError(
        expect.objectContaining({
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
        }),
      );
    }
    harness.invalidateBackend({ ...record, reason: 'fixture-page-closed' });
    expect(notifications).toHaveLength(1);
    allowStop.resolve(undefined);
    await harness.runtime.stop();
    expect(harness.runtime.state).toBe('stopped');
    expect(() =>
      harness.runtime.withBackend(vi.fn(), 'waitForDevicePrompt'),
    ).toThrowError(
      expect.objectContaining({
        cause,
        context: expect.objectContaining({
          reason: 'adapter-lost',
          operation: 'waitForDevicePrompt',
          operationLayer: 'playwright',
        }),
      }),
    );
  });

  it('ordinary disposal before fixture closure retains ordinary stopped semantics', async () => {
    const harness = createHarness();
    await harness.runtime.start();
    await harness.runtime.stop();
    harness.closePage();
    await expect(
      harness.runtime.withBackend(async () => undefined, 'createPeripheral'),
    ).rejects.toMatchObject({
      code: 'BLUETOOTH_BACKEND_STOPPED',
      context: { operation: 'start', state: 'stopped' },
    });
    expect(
      [...harness.pageListeners.values()].every(
        (listeners) => listeners.size === 0,
      ),
    ).toBe(true);
  });

  it('only document boundaries notify CDP and the notification alone leaves the lab usable', async () => {
    const noteDocument = vi.fn();
    const harness = createHarness({
      async factoryBehavior({ options }) {
        return {
          noteFixtureDocumentChanged: noteDocument,
          async stop() {
            await options.pageTransport.detach();
            await options.browserTransport.detach();
            await options.releaseLease();
          },
        } as unknown as CdpBluetoothBackend;
      },
    });
    await harness.runtime.start();
    harness.documentChanged();
    expect(noteDocument).toHaveBeenCalledOnce();
    expect(harness.pageListeners.has('framenavigated')).toBe(false);
    await expect(
      harness.runtime.withBackend(async () => 'live', 'setState'),
    ).resolves.toBe('live');
    await harness.runtime.stop();
    harness.documentChanged();
    expect(noteDocument).toHaveBeenCalledOnce();
  });
});

describe('public boundary diagnostics', () => {
  it('maps only public operation/layer while preserving original and secondary timeout budgets', async () => {
    const harness = createHarness();
    await harness.runtime.start();
    const primary = new Error('original command timeout cause');
    const timeout = new BluetoothTimeoutError('original command deadline', {
      cause: primary,
      context: {
        operation: 'simulateAdvertisement',
        operationLayer: 'cdp',
        deadlineKind: 'command',
        deadlineMs: 41,
        checkDeadlineMs: 41,
        timeoutPhase: 'operation',
        detection: 'unconfirmed',
        centralStateBlocked: true,
        remediation: 'dispose-lab',
        deadlineCheck: {
          deadlineKind: 'command',
          deadlineMs: 41,
          timeoutPhase: 'deadline-check',
        },
      },
    });
    await expect(
      harness.runtime.withBackend(async () => {
        throw timeout;
      }, 'advertise'),
    ).rejects.toMatchObject({
      code: 'BLUETOOTH_TIMEOUT',
      cause: primary,
      context: {
        operation: 'advertise',
        operationLayer: 'playwright',
        deadlineKind: 'command',
        deadlineMs: 41,
        checkDeadlineMs: 41,
        timeoutPhase: 'operation',
        detection: 'unconfirmed',
        centralStateBlocked: true,
        remediation: 'dispose-lab',
        deadlineCheck: {
          deadlineKind: 'command',
          deadlineMs: 41,
          timeoutPhase: 'deadline-check',
        },
      },
    });
    await harness.runtime.stop();
  });

  it('preserves explicit cancellation when the same model operation closes usability', async () => {
    const harness = createHarness();
    await harness.runtime.start();
    const primary = new BluetoothCancelledError('original explicit cancel');
    const waiting = harness.runtime.withBackend(async () => {
      harness.invalidateBackend({
        reason: 'model-outcome-unknown',
        lifecycleState: 'invalidated',
        operation: 'addPeripheral',
        operationLayer: 'cdp',
        detectedBy: 'model-operation-aborted',
        boundary: 'unobserved',
        remediation: 'new-test-fixture',
        cause: primary,
      });
      throw primary;
    }, 'createPeripheral');
    await expect(waiting).rejects.toBe(primary);
    await harness.runtime.stop();
    expect(() =>
      harness.runtime.withBackend(async () => undefined, 'createPeripheral'),
    ).toThrowError(
      expect.objectContaining({
        cause: primary,
        context: expect.objectContaining({
          reason: 'model-outcome-unknown',
          operation: 'createPeripheral',
          operationLayer: 'playwright',
        }),
      }),
    );
  });
});
