import {
  BluetoothBackendStoppedError,
  BluetoothCancelledError,
  BluetoothTimeoutError,
  BluetoothCapabilityUnsupportedError,
  createBluetoothTimeline,
  createCancellationController,
  runBestEffortBackendCleanup,
  type BackendCleanupFailure,
  type BackendCleanupStep,
  type BluetoothTimeline,
  type CancellationSignal,
  type CentralState,
  type MonotonicClock,
  type NormalizedPeripheral,
} from '@gattlab/core';
import {
  CdpBluetoothBackendFactory,
  createCdpTransport,
  type CdpBackendDeadlineScheduler,
  type CdpBluetoothBackend,
  type CdpBluetoothBackendFactoryOptions,
  type CdpSessionLike,
  type CdpLabInvalidation,
} from '@gattlab/cdp';
import type { Browser, BrowserContext, Page } from '@playwright/test';

import {
  acquireBrowserProcessLease,
  type BrowserProcessLease,
} from './browser-process-lease.js';
import {
  normalizeGattLabFixtureOptions,
  type GattLabFixtureOptions,
  type NormalizedGattLabFixtureOptions,
} from './options.js';
import {
  createPlaywrightDeadlineScheduler,
  createPlaywrightMonotonicClock,
} from './time.js';
import {
  GattLabDiagnosticBuffer,
  type GattLabTimelineOwner,
} from './diagnostics.js';

export type GattLabRuntimeState =
  'idle' | 'starting' | 'started' | 'stopping' | 'stopped';

export interface GattLabRuntimePreparation {
  readonly browserName: string;
  readonly browser: Browser;
  readonly context: BrowserContext;
  readonly page: Page;
  readonly options: GattLabFixtureOptions | undefined;
  readonly diagnostics?: GattLabDiagnosticBuffer;
}

interface RuntimeInputs {
  readonly browserName: 'chromium';
  readonly browser: Browser;
  readonly context: BrowserContext;
  readonly page: Page;
  readonly options: NormalizedGattLabFixtureOptions;
  readonly diagnostics: GattLabDiagnosticBuffer;
}

interface CdpBackendFactoryLike {
  start(options: {
    readonly centralState: CentralState;
    readonly cancellation?: CancellationSignal;
  }): Promise<CdpBluetoothBackend>;
}

export interface GattLabRuntimeDependencies {
  createClock(): MonotonicClock;
  createDeadlineScheduler(): CdpBackendDeadlineScheduler;
  createBackendFactory(
    options: CdpBluetoothBackendFactoryOptions,
  ): CdpBackendFactoryLike;
}

const productionDependencies: GattLabRuntimeDependencies = Object.freeze({
  createClock: createPlaywrightMonotonicClock,
  createDeadlineScheduler: createPlaywrightDeadlineScheduler,
  createBackendFactory(
    options: CdpBluetoothBackendFactoryOptions,
  ): CdpBackendFactoryLike {
    return new CdpBluetoothBackendFactory(options);
  },
});

/** Validates fixture inputs and prepares a lazy runtime without browser effects. */
export function prepareGattLabRuntime(
  preparation: GattLabRuntimePreparation,
  dependencies: GattLabRuntimeDependencies = productionDependencies,
): GattLabRuntimeController {
  if (preparation.browserName !== 'chromium') {
    throw new BluetoothCapabilityUnsupportedError(
      `GattLab requires Chromium, but Playwright selected ${JSON.stringify(preparation.browserName)}.`,
      {
        context: {
          expectedBrowserName: 'chromium',
          actualBrowserName: preparation.browserName,
        },
      },
    );
  }

  const options = normalizeGattLabFixtureOptions(preparation.options);
  const diagnostics = preparation.diagnostics ?? new GattLabDiagnosticBuffer();
  diagnostics.configure(options);
  return new GattLabRuntimeController(
    {
      browserName: 'chromium',
      browser: preparation.browser,
      context: preparation.context,
      page: preparation.page,
      options,
      diagnostics,
    },
    dependencies,
  );
}

/** Owns lazy backend startup, use, diagnostics, and idempotent teardown. */
export class GattLabRuntimeController {
  readonly #inputs: RuntimeInputs;
  readonly #dependencies: GattLabRuntimeDependencies;
  readonly #diagnostics: GattLabDiagnosticBuffer;
  #state: GattLabRuntimeState = 'idle';
  #backend: CdpBluetoothBackend | undefined;
  #startPromise: Promise<CdpBluetoothBackend> | undefined;
  #stopPromise: Promise<void> | undefined;
  #startupCleanupFailure: Error | undefined;
  #cancelStartup: (() => void) | undefined;
  #invalidation: CdpLabInvalidation | undefined;
  readonly #invalidationListeners = new Set<
    (record: CdpLabInvalidation) => void
  >();
  #fixtureClosed = false;
  #disposing = false;
  #unsubscribeInvalidation: (() => void) | undefined;
  readonly #onPageClose = (): void => {
    if (this.#disposing || this.#invalidation !== undefined) return;
    this.#fixtureClosed = true;
    if (this.#backend !== undefined) {
      this.#backend.invalidateFixturePage('playwright');
    } else {
      this.#retainInvalidation(
        Object.freeze({
          reason: 'fixture-page-closed',
          lifecycleState: 'invalidated',
          operation: 'waitForDevicePrompt',
          operationLayer: 'playwright',
          detectedBy: 'fixture-page-close',
          boundary: 'fixture-page-closed',
          remediation: 'new-test-fixture',
        }),
      );
      this.#cancelStartup?.();
    }
  };
  readonly #onDocumentChanged = (): void => {
    this.#backend?.noteFixtureDocumentChanged();
  };

  constructor(
    inputs: RuntimeInputs,
    dependencies: GattLabRuntimeDependencies = productionDependencies,
  ) {
    this.#inputs = inputs;
    this.#dependencies = dependencies;
    this.#diagnostics = inputs.diagnostics;
    inputs.page.on('close', this.#onPageClose);
    inputs.page.on('domcontentloaded', this.#onDocumentChanged);
    if (inputs.page.isClosed()) this.#onPageClose();
  }

  get state(): GattLabRuntimeState {
    return this.#state;
  }

  get options(): NormalizedGattLabFixtureOptions {
    return this.#inputs.options;
  }

  capturePeripheralDiagnostics(peripheral: NormalizedPeripheral): void {
    this.#diagnostics.capturePeripheral(peripheral);
  }

  withBackend<T>(
    operation: (backend: CdpBluetoothBackend) => Promise<T>,
    operationName = 'onEvent',
  ): Promise<T> {
    this.assertUsable(operationName);
    if (this.#state === 'started' && this.#backend !== undefined) {
      return this.#atBoundary(operation(this.#backend), operationName);
    }
    return this.start().then(
      (backend) => {
        this.assertUsable(operationName);
        return this.#atBoundary(operation(backend), operationName);
      },
      (cause: unknown) => {
        this.assertUsable(operationName);
        throw cause;
      },
    );
  }

  #atBoundary<T>(result: Promise<T>, operation: string): Promise<T> {
    return result.catch((cause: unknown) => {
      if (cause instanceof BluetoothCancelledError) throw cause;
      this.assertUsable(operation);
      if (
        cause instanceof BluetoothTimeoutError &&
        cause.context['deadlineKind'] !== undefined
      ) {
        const error = new BluetoothTimeoutError(cause.message, {
          cause: cause.cause,
          context: {
            ...cause.context,
            operation,
            operationLayer: 'playwright',
          },
        });
        if ('deadlineCheck' in cause)
          Object.defineProperty(error, 'deadlineCheck', {
            value: cause.deadlineCheck,
          });
        throw error;
      }
      throw cause;
    });
  }

  assertUsable(operation: string): void {
    if (this.#invalidation !== undefined) {
      const { cause, ...context } = this.#invalidation;
      throw new BluetoothBackendStoppedError(
        'Bluetooth lab is invalidated; use a new test fixture.',
        {
          cause,
          context: { ...context, operation, operationLayer: 'playwright' },
        },
      );
    }
  }

  onInvalidated(listener: (record: CdpLabInvalidation) => void): () => void {
    this.#invalidationListeners.add(listener);
    if (this.#invalidation !== undefined) listener(this.#invalidation);
    return () => {
      this.#invalidationListeners.delete(listener);
    };
  }

  #retainInvalidation(record: CdpLabInvalidation): void {
    if (this.#disposing || this.#invalidation !== undefined) return;
    this.#invalidation = Object.freeze({ ...record });
    for (const listener of this.#invalidationListeners)
      listener(this.#invalidation);
    void this.stop().catch((cause: unknown) => {
      this.#diagnostics.captureRuntimeFailure('runtime-stop', cause);
    });
  }

  start(): Promise<CdpBluetoothBackend> {
    if (this.#startPromise !== undefined) {
      if (this.#state === 'starting' || this.#state === 'started') {
        return this.#startPromise;
      }
      return Promise.reject(this.#stoppedError('start'));
    }
    if (this.#state !== 'idle') {
      return Promise.reject(this.#stoppedError('start'));
    }

    const cancellation = createCancellationController();
    this.#cancelStartup = () => {
      cancellation.cancel();
    };
    this.#state = 'starting';
    const startPromise = this.#startOwned(cancellation.signal);
    this.#startPromise = startPromise;
    void startPromise.then(
      (backend) => {
        if (this.#state === 'starting') {
          this.#backend = backend;
          this.#state = 'started';
        }
      },
      () => {
        if (this.#state === 'starting') this.#state = 'stopped';
      },
    );
    return startPromise;
  }

  stop(): Promise<void> {
    if (this.#stopPromise !== undefined) return this.#stopPromise;
    this.#disposing = true;
    this.#inputs.page.off('close', this.#onPageClose);
    this.#inputs.page.off('domcontentloaded', this.#onDocumentChanged);

    if (this.#state === 'idle') {
      this.#state = 'stopped';
      this.#stopPromise = Promise.resolve();
      return this.#stopPromise;
    }
    if (this.#state === 'stopped') {
      this.#stopPromise = Promise.resolve();
      return this.#stopPromise;
    }

    this.#state = 'stopping';
    this.#cancelStartup?.();
    const startPromise = this.#startPromise;
    if (startPromise === undefined) {
      this.#stopPromise = Promise.resolve().then(() => {
        this.#state = 'stopped';
      });
      return this.#stopPromise;
    }

    this.#stopPromise = this.#stopStartedRuntime(startPromise);
    return this.#stopPromise;
  }

  async #startOwned(
    cancellation: CancellationSignal,
  ): Promise<CdpBluetoothBackend> {
    let lease: BrowserProcessLease | undefined;
    let browserSession: CdpSessionLike | undefined;
    let pageSession: CdpSessionLike | undefined;
    let browserTransport:
      ReturnType<typeof createCdpTransport<'browser'>> | undefined;
    let pageTransport:
      ReturnType<typeof createCdpTransport<'page'>> | undefined;
    let timeline: BluetoothTimeline | undefined;
    let backendStartInvoked = false;

    try {
      cancellation.throwIfCancelled();
      lease = acquireBrowserProcessLease(this.#inputs.browser);
      cancellation.throwIfCancelled();

      browserSession = await this.#inputs.browser.newBrowserCDPSession();
      browserTransport = createCdpTransport('browser', browserSession);
      cancellation.throwIfCancelled();

      pageSession = await this.#inputs.context.newCDPSession(this.#inputs.page);
      pageTransport = createCdpTransport('page', pageSession);
      cancellation.throwIfCancelled();

      const clock = this.#dependencies.createClock();
      const deadlineScheduler = this.#dependencies.createDeadlineScheduler();
      timeline = createBluetoothTimeline({
        limit: this.#inputs.options.historyLimit,
        clock,
      });
      const ownedLease = lease;
      const factory = this.#dependencies.createBackendFactory({
        browserName: this.#inputs.browserName,
        browserTransport,
        pageTransport,
        inspectWebBluetoothEnvironment: () =>
          inspectWebBluetoothEnvironment(this.#inputs.page),
        timeline,
        clock,
        deadlineScheduler,
        operationDeadlineMs: this.#inputs.options.operationTimeoutMs,
        promptDeadlineMs: this.#inputs.options.promptTimeoutMs,
        teardownDeadlineMs: this.#inputs.options.teardownTimeoutMs,
        flushArtifacts: (events) => {
          this.#diagnostics.captureTimeline('cdp-backend', events);
          return Promise.resolve();
        },
        releaseLease: () => ownedLease.release(),
      });
      cancellation.throwIfCancelled();

      backendStartInvoked = true;
      const backend = await factory.start({
        centralState: this.#inputs.options.centralState,
        cancellation,
      });
      this.#backend = backend;
      this.#unsubscribeInvalidation = backend.onInvalidated((record) => {
        this.#retainInvalidation(record);
      });
      if (this.#fixtureClosed) backend.invalidateFixturePage('playwright');
      if (this.#invalidation !== undefined) {
        try {
          await backend.stop();
        } catch (cause) {
          this.#startupCleanupFailure =
            cause instanceof Error
              ? cause
              : new Error('Startup cleanup failed.', { cause });
          this.#diagnostics.captureRuntimeFailure('runtime-stop', cause);
        }
        this.assertUsable('waitForDevicePrompt');
      }
      const compatibility = this.#diagnostics.captureCapabilities(
        backend.capabilities,
      );
      if (compatibility !== undefined) {
        try {
          backend.timeline.append({
            category: 'diagnostic',
            type: 'compatibility-baseline',
            data: {
              status: compatibility.status,
              mismatches: compatibility.mismatches,
              observedPlaywrightVersion:
                compatibility.observed.playwrightVersion,
              observedHeadless: compatibility.observed.headless,
              observedBrowserChannel:
                compatibility.observed.channel ?? 'bundled',
              observedExecutable: compatibility.observed.customExecutable
                ? 'custom'
                : 'bundled',
              observedConnection: compatibility.observed.connection,
              observedBrowserProduct: compatibility.observed.browserProduct,
              observedBrowserVersion: compatibility.observed.browserVersion,
              observedProtocolVersion:
                compatibility.observed.protocolVersion ?? 'unknown',
              validatedPlaywrightVersion:
                compatibility.validated.playwrightVersion,
              validatedBrowserProduct: compatibility.validated.browserProduct,
              validatedProtocolVersion: compatibility.validated.protocolVersion,
              validatedHeadlessMode: compatibility.validated.headlessMode,
            },
          });
        } catch {
          // Compatibility diagnostics never change a successful runtime start.
        }
      }
      return backend;
    } catch (cause) {
      this.#diagnostics.captureRuntimeFailure('runtime-start', cause);
      if (!backendStartInvoked) {
        await cleanupBeforeBackendStart({
          browserSession,
          pageSession,
          browserTransport,
          pageTransport,
          lease,
          timeline,
          diagnostics: this.#diagnostics,
        });
      }
      throw cause;
    }
  }

  async #stopStartedRuntime(
    startPromise: Promise<CdpBluetoothBackend>,
  ): Promise<void> {
    try {
      let backend: CdpBluetoothBackend;
      try {
        backend = await startPromise;
      } catch (cause) {
        if (cause instanceof BluetoothCancelledError) return;
        if (
          cause instanceof BluetoothBackendStoppedError &&
          this.#invalidation !== undefined &&
          cause.context['reason'] === this.#invalidation.reason
        ) {
          if (this.#startupCleanupFailure !== undefined)
            throw this.#startupCleanupFailure;
          return;
        }
        throw cause;
      }
      try {
        await backend.stop();
      } catch (cause) {
        this.#diagnostics.captureRuntimeFailure('runtime-stop', cause);
        throw cause;
      }
    } finally {
      this.#unsubscribeInvalidation?.();
      this.#unsubscribeInvalidation = undefined;
      this.#backend = undefined;
      this.#state = 'stopped';
    }
  }

  #stoppedError(operation: string): BluetoothBackendStoppedError {
    return new BluetoothBackendStoppedError(
      `Cannot ${operation} the GattLab runtime after teardown has begun.`,
      { context: { operation, state: this.#state } },
    );
  }
}

interface PreStartCleanupResources {
  readonly browserSession: CdpSessionLike | undefined;
  readonly pageSession: CdpSessionLike | undefined;
  readonly browserTransport:
    ReturnType<typeof createCdpTransport<'browser'>> | undefined;
  readonly pageTransport:
    ReturnType<typeof createCdpTransport<'page'>> | undefined;
  readonly lease: BrowserProcessLease | undefined;
  readonly timeline: BluetoothTimeline | undefined;
  readonly diagnostics: GattLabDiagnosticBuffer;
}

async function cleanupBeforeBackendStart(
  resources: PreStartCleanupResources,
): Promise<void> {
  const steps: BackendCleanupStep[] = [];
  if (resources.pageTransport !== undefined) {
    steps.push({
      name: 'page-session.detach',
      run: () => resources.pageTransport?.detach() ?? Promise.resolve(),
    });
  } else if (resources.pageSession !== undefined) {
    steps.push({
      name: 'page-session.detach',
      run: () => resources.pageSession?.detach() ?? Promise.resolve(),
    });
  }
  if (resources.browserTransport !== undefined) {
    steps.push({
      name: 'browser-session.detach',
      run: () => resources.browserTransport?.detach() ?? Promise.resolve(),
    });
  } else if (resources.browserSession !== undefined) {
    steps.push({
      name: 'browser-session.detach',
      run: () => resources.browserSession?.detach() ?? Promise.resolve(),
    });
  }
  const failures = await runBestEffortBackendCleanup(steps);
  const timeline = resources.timeline;
  recordPreStartCleanupFailures(timeline, failures);

  if (resources.lease !== undefined) {
    const releaseFailures = await runBestEffortBackendCleanup([
      {
        name: 'browser-process-lease.release',
        run: () => resources.lease?.release() ?? Promise.resolve(),
      },
    ]);
    recordPreStartCleanupFailures(timeline, releaseFailures);
  }

  if (timeline === undefined) return;
  captureTimelineBeforeClose(
    resources.diagnostics,
    'playwright-runtime',
    timeline,
  );
  try {
    timeline.close();
  } catch {
    // The primary startup failure remains authoritative if closing fails.
  }
}

function captureTimelineBeforeClose(
  diagnostics: GattLabDiagnosticBuffer,
  owner: GattLabTimelineOwner,
  timeline: BluetoothTimeline,
): void {
  try {
    diagnostics.captureTimeline(owner, timeline.snapshot());
  } catch {
    // The primary startup failure remains authoritative if capture fails.
  }
}

function recordPreStartCleanupFailures(
  timeline: BluetoothTimeline | undefined,
  failures: readonly BackendCleanupFailure[],
): void {
  if (timeline === undefined) return;
  for (const failure of failures) {
    try {
      timeline.append({
        category: 'lifecycle',
        type: 'cleanup-step',
        status: 'failed',
        data: {
          reason: cleanupFailureReason(failure.cause),
          step: failure.name,
        },
      });
    } catch {
      // The primary startup failure remains authoritative if diagnostics fail.
    }
  }
}

function cleanupFailureReason(cause: unknown): string {
  if (cause instanceof Error && cause.name.length > 0) return cause.name;
  return 'unknown-failure';
}

async function inspectWebBluetoothEnvironment(page: Page): Promise<{
  readonly secureContext: boolean;
  readonly navigatorBluetooth: boolean;
}> {
  return page.evaluate(() => {
    const browserGlobal = globalThis as {
      readonly isSecureContext?: boolean;
      readonly navigator?: object;
    };
    return {
      secureContext: browserGlobal.isSecureContext === true,
      navigatorBluetooth:
        browserGlobal.navigator !== undefined &&
        'bluetooth' in browserGlobal.navigator,
    };
  });
}
