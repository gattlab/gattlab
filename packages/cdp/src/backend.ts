import {
  BackendLifecycleController,
  BluetoothCancelledError,
  BluetoothTimeoutError,
  BluetoothValidationError,
  type BackendBluetoothEvent,
  type BackendCallOptions,
  type BackendStartOptions,
  type BluetoothAddress,
  type BluetoothAutomationBackend,
  type BluetoothAutomationBackendFactory,
  type BluetoothCapabilities,
  type BluetoothTimeline,
  type BluetoothTimelineEvent,
  type CancellationSignal,
  type CentralState,
  type CharacteristicOperationResponse,
  type DescriptorOperationResponse,
  type DiagnosticValue,
  type GattOperationResponse,
  type MonotonicClock,
  type NormalizedPeripheral,
  type TimelineEventInput,
} from '@gattlab/core';

import {
  CdpCapabilityProbe,
  type WebBluetoothEnvironment,
} from './capability-probe.js';
import { CdpCharacteristicOperationHandler } from './characteristic-operation-handler.js';
import { CdpDescriptorOperationHandler } from './descriptor-operation-handler.js';
import {
  CdpDevicePromptController,
  type CdpDevicePrompt,
  type WaitForDevicePromptOptions,
} from './device-prompt-controller.js';
import { CdpEntityRegistry } from './entity-registry.js';
import {
  bluetoothEmulationAlreadyActiveError,
  isBluetoothEmulationAlreadyEnabledError,
} from './domain-conflict.js';
import { CdpGattOperationHandler } from './gatt-operation-handler.js';
import {
  PendingOperationRegistry,
  type OperationDeadline,
  type OperationDeadlineScheduler,
} from './pending-operation-registry.js';
import {
  CdpLabLifecycle,
  defaultCommandDeadlineMs,
  type CdpCommandScope,
  type CdpLabInvalidation,
  type CdpOperationLayer,
} from './lab-lifecycle.js';
import type { CdpTransport } from './transport.js';

export type CdpBackendDeadlineScheduler = OperationDeadlineScheduler;

export interface CdpBluetoothBackendFactoryOptions {
  readonly browserName: string;
  readonly browserTransport: CdpTransport<'browser'>;
  readonly pageTransport: CdpTransport<'page'>;
  /** Inspect the consumer page's secure context and navigator.bluetooth; rejection is preserved by capability diagnostics. */
  readonly inspectWebBluetoothEnvironment: () => Promise<WebBluetoothEnvironment>;
  readonly timeline: BluetoothTimeline;
  readonly clock: MonotonicClock;
  readonly deadlineScheduler: CdpBackendDeadlineScheduler;
  /** Pending GATT application-wait deadline; does not limit active Chromium commands. */
  readonly operationDeadlineMs: number;
  /** Finite positive safe-integer started-command budget; omission uses the measured 30,000 ms default independently of application waits. */
  readonly commandDeadlineMs?: number;
  readonly promptDeadlineMs: number;
  readonly teardownDeadlineMs: number;
  /** Flush an owned timeline snapshot before the browser-process lease moves. */
  readonly flushArtifacts?: (
    events: readonly BluetoothTimelineEvent[],
  ) => Promise<void>;
  /** Release the lease acquired by the Playwright integration owner. */
  readonly releaseLease: () => Promise<void>;
}

export interface CdpBluetoothBackend extends BluetoothAutomationBackend {
  readonly timeline: BluetoothTimeline;
  /** Reject active use after the first terminal transition; identity inspection and stop remain available. */
  assertUsable(operation: string, operationLayer?: CdpOperationLayer): void;
  /** Observe the immutable first terminal record synchronously; unsubscribe is idempotent. */
  onInvalidated(listener: (record: CdpLabInvalidation) => void): () => void;
  /** Record observed fixture main-document replacement for diagnostics only. */
  noteFixtureDocumentChanged(): void;
  /** Close usability after the owned fixture page closes; ordinary disposal that won first is retained. */
  invalidateFixturePage(operationLayer?: CdpOperationLayer): void;
  /** Compose registration, queueing and publication under one command budget; pass the supplied options to nested backend methods. */
  withCommandBudget<T>(
    operation: string,
    operationLayer: CdpOperationLayer,
    work: (options: BackendCallOptions, assertCommit: () => void) => Promise<T>,
    options?: BackendCallOptions,
  ): Promise<T>;
  /** Reapply the acknowledged state under a finite, serialized entry fence; never reset or reconstruct the adapter. */
  checkLiveness(
    operation: string,
    operationLayer?: CdpOperationLayer,
  ): Promise<void>;
  /** After an application wait expires, perform at most one independent bounded check and reject with original timeout or terminal evidence. */
  diagnoseTimeout(
    operation: string,
    operationLayer: CdpOperationLayer,
    timeout: BluetoothTimeoutError,
    deadlineKind?: 'application-operation' | 'prompt',
  ): Promise<never>;
  /** Arm the page listener synchronously; wait with the supplied/factory prompt deadline. Stopped, concurrent or invalid-deadline calls throw before returning. */
  waitForDevicePrompt(
    options?: WaitForDevicePromptOptions,
  ): Promise<CdpDevicePrompt>;
}

interface StartedBackendResources {
  readonly capabilities: BluetoothCapabilities;
  readonly entities: CdpEntityRegistry;
  readonly pendingOperations: PendingOperationRegistry;
  readonly gattHandler: CdpGattOperationHandler;
  readonly characteristicHandler: CdpCharacteristicOperationHandler;
  readonly descriptorHandler: CdpDescriptorOperationHandler;
}

interface CleanupFailure {
  readonly name: string;
  readonly cause: unknown;
}

type BackendTimelineCategory = TimelineEventInput['category'];

/**
 * Creates the complete CDP backend over sessions owned by the Playwright layer.
 *
 * One factory instance owns one session pair and can be started only once.
 */
export class CdpBluetoothBackendFactory implements BluetoothAutomationBackendFactory {
  readonly #options: CdpBluetoothBackendFactoryOptions;
  #startClaimed = false;

  /** Adopt an owned session pair and externally acquired lease; invalid callbacks/name throw TypeError, invalid positive-integer deadlines RangeError. */
  constructor(options: CdpBluetoothBackendFactoryOptions) {
    assertFactoryOptions(options);
    this.#options = options;
  }

  /** Attempt startup once, probe capabilities and install operation handlers; cancellation/capability/transport failures reject and unwind ownership. No whole-start deadline. */
  async start(options: BackendStartOptions): Promise<CdpBluetoothBackend> {
    if (this.#startClaimed) {
      throw new BluetoothValidationError(
        'This CDP backend factory has already started or attempted startup.',
        { context: { reason: 'cdp-backend-factory-already-used' } },
      );
    }
    this.#startClaimed = true;
    const { browserTransport, pageTransport, timeline } = this.#options;
    let bluetoothEmulationEnableAttempted = false;
    let deviceAccessEnableAttempted = false;
    let unsubscribeCancellation = (): void => undefined;

    try {
      assertCentralState(options.centralState);
      safeAppend(timeline, {
        category: 'lifecycle',
        type: 'backend-start',
        status: 'requested',
        data: { centralState: options.centralState },
      });
      unsubscribeCancellation =
        options.cancellation?.onCancelled(() => {
          void Promise.allSettled([
            pageTransport.detach(),
            browserTransport.detach(),
          ]);
        }) ?? unsubscribeCancellation;
      options.cancellation?.throwIfCancelled();
      const capabilities = await new CdpCapabilityProbe({
        browserName: this.#options.browserName,
        browserTransport,
        pageTransport,
        inspectWebBluetoothEnvironment:
          this.#options.inspectWebBluetoothEnvironment,
      }).probe();
      options.cancellation?.throwIfCancelled();

      bluetoothEmulationEnableAttempted = true;
      try {
        await browserTransport.send('BluetoothEmulation.enable', {
          state: options.centralState,
          leSupported: true,
        });
      } catch (cause) {
        if (isBluetoothEmulationAlreadyEnabledError(cause)) {
          bluetoothEmulationEnableAttempted = false;
          throw bluetoothEmulationAlreadyActiveError(cause);
        }
        throw cause;
      }
      options.cancellation?.throwIfCancelled();

      deviceAccessEnableAttempted = true;
      await pageTransport.send('DeviceAccess.enable');
      options.cancellation?.throwIfCancelled();

      const resources = this.#createResources(capabilities);
      const backend = new StartedCdpBluetoothBackend({
        ...this.#options,
        ...resources,
        initialCentralState: options.centralState,
      });
      backend.installEventHandlers();
      safeAppend(timeline, {
        category: 'lifecycle',
        type: 'backend-start',
        status: 'succeeded',
        data: {
          browserProduct: capabilities.browserProduct,
          browserVersion: capabilities.browserVersion,
        },
      });
      unsubscribeCancellation();
      return backend;
    } catch (cause) {
      unsubscribeCancellation();
      const primaryCause = cancellationCause(options.cancellation, cause);
      safeAppend(timeline, {
        category: 'lifecycle',
        type: 'backend-start',
        status:
          primaryCause instanceof BluetoothCancelledError
            ? 'cancelled'
            : 'failed',
        data: { reason: startupFailureReason(primaryCause) },
      });
      await unwindFailedStartup({
        browserTransport,
        pageTransport,
        timeline,
        bluetoothEmulationEnableAttempted,
        deviceAccessEnableAttempted,
        flushArtifacts: this.#options.flushArtifacts,
        releaseLease: this.#options.releaseLease,
      });
      throw primaryCause;
    }
  }

  #createResources(
    capabilities: BluetoothCapabilities,
  ): StartedBackendResources {
    const entities = new CdpEntityRegistry(this.#options.browserTransport);
    const pendingOperations = new PendingOperationRegistry({
      timeline: this.#options.timeline,
      defaultDeadlineMs: this.#options.operationDeadlineMs,
      deadlineScheduler: this.#options.deadlineScheduler,
      operationIdNamespace: 'cdp-operation',
    });
    const sharedHandlerOptions = {
      transport: this.#options.browserTransport,
      entities,
      pendingOperations,
      timeline: this.#options.timeline,
    };
    return {
      capabilities,
      entities,
      pendingOperations,
      gattHandler: new CdpGattOperationHandler(sharedHandlerOptions),
      characteristicHandler: new CdpCharacteristicOperationHandler(
        sharedHandlerOptions,
      ),
      descriptorHandler: new CdpDescriptorOperationHandler(
        sharedHandlerOptions,
      ),
    };
  }
}

interface StartedCdpBluetoothBackendOptions
  extends CdpBluetoothBackendFactoryOptions, StartedBackendResources {
  readonly initialCentralState: CentralState;
}

class StartedCdpBluetoothBackend implements CdpBluetoothBackend {
  readonly capabilities: BluetoothCapabilities;
  readonly timeline: BluetoothTimeline;
  readonly #browserTransport: CdpTransport<'browser'>;
  readonly #pageTransport: CdpTransport<'page'>;
  readonly #entities: CdpEntityRegistry;
  readonly #pendingOperations: PendingOperationRegistry;
  readonly #promptController: CdpDevicePromptController;
  readonly #gattHandler: CdpGattOperationHandler;
  readonly #characteristicHandler: CdpCharacteristicOperationHandler;
  readonly #descriptorHandler: CdpDescriptorOperationHandler;
  readonly #deadlineScheduler: CdpBackendDeadlineScheduler;
  readonly #teardownDeadlineMs: number;
  readonly #flushArtifacts: (
    events: readonly BluetoothTimelineEvent[],
  ) => Promise<void>;
  readonly #releaseLease: () => Promise<void>;
  readonly #lifecycle = new BackendLifecycleController();
  readonly #handlerUnsubscribers: (() => void)[] = [];
  readonly #knownPeripherals = new Set<BluetoothAddress>();
  readonly #inFlightCalls = new Set<Promise<void>>();
  readonly #inFlightMutations = new Set<Promise<void>>();
  readonly #lab: CdpLabLifecycle;
  #advertisementsSent = 0;
  #handlersInstalled = false;

  constructor(options: StartedCdpBluetoothBackendOptions) {
    this.capabilities = options.capabilities;
    this.timeline = options.timeline;
    this.#browserTransport = options.browserTransport;
    this.#pageTransport = options.pageTransport;
    this.#entities = options.entities;
    this.#pendingOperations = options.pendingOperations;
    this.#gattHandler = options.gattHandler;
    this.#characteristicHandler = options.characteristicHandler;
    this.#descriptorHandler = options.descriptorHandler;
    this.#deadlineScheduler = options.deadlineScheduler;
    this.#teardownDeadlineMs = options.teardownDeadlineMs;
    this.#flushArtifacts = options.flushArtifacts ?? (() => Promise.resolve());
    this.#releaseLease = options.releaseLease;
    this.#lab = new CdpLabLifecycle({
      transport: options.browserTransport,
      scheduler: options.deadlineScheduler,
      clock: options.clock,
      timeline: options.timeline,
      commandDeadlineMs: options.commandDeadlineMs ?? defaultCommandDeadlineMs,
      centralState: options.initialCentralState,
      getState: () => this.#lifecycle.state,
      invalidate: () => {
        this.#entities.invalidate();
        this.#pendingOperations.cancelAll('lab-invalidated');
        let cause: unknown;
        try {
          this.#lab.assertUsable('waitForDevicePrompt');
        } catch (error) {
          cause = error;
        }
        this.#promptController.dispose('lab-invalidated', cause);
        void this.stop().catch(() => undefined);
      },
    });

    this.#promptController = new CdpDevicePromptController({
      transport: options.pageTransport,
      timeline: options.timeline,
      clock: options.clock,
      defaultDeadlineMs: options.promptDeadlineMs,
      deadlineScheduler: options.deadlineScheduler,
      lifecycle: {
        assertActive: (operation, layer) => {
          this.#lab.assertUsable(operation, layer);
        },
        beforeWait: (layer) =>
          this.#lab.checkLiveness('waitForDevicePrompt', layer),
        settle: (operation, layer, options, send) =>
          this.#lab.withBudget(
            operation,
            layer,
            async (token, assertCommit) => {
              const scope = this.#lab.scope(token);
              await this.#lab.stateCommand(scope);
              scope.entryCheck = false;
              const native = send(scope.sender(this.#pageTransport));
              this.#trackMutation(native);
              await native;
              assertCommit();
            },
            options,
          ),
        diagnoseTimeout: (timeout, layer) =>
          this.#lab.diagnoseTimeout(
            'waitForDevicePrompt',
            layer,
            timeout,
            'prompt',
          ),
      },
      getDiagnosticState: () => ({
        centralState: this.#lab.centralState,
        knownPeripherals: [...this.#knownPeripherals].sort(),
        advertisementsSent: this.#advertisementsSent,
      }),
    });
  }

  installEventHandlers(): void {
    if (this.#handlersInstalled) {
      throw new TypeError('CDP backend event handlers are already installed.');
    }
    this.#handlersInstalled = true;
    const deliver = (event: BackendBluetoothEvent): void => {
      if (this.#lifecycle.emit(event)) return;
      this.#pendingOperations.cancel(event.operationId, 'backend-stopping');
    };
    const onError = (cause: unknown): void => {
      safeAppend(this.timeline, {
        category: 'diagnostic',
        type: 'backend-event-error',
        status: 'failed',
        data: { reason: eventFailureReason(cause) },
      });
    };
    this.#handlerUnsubscribers.push(
      this.#gattHandler.subscribe(deliver, onError),
      this.#characteristicHandler.subscribe(deliver, onError),
      this.#descriptorHandler.subscribe(deliver, onError),
    );
  }

  stop(): Promise<void> {
    const stop = this.#lifecycle.stop(() => this.#teardown());
    this.#lab.stop();
    return stop;
  }

  assertUsable(
    operation: string,
    operationLayer: CdpOperationLayer = 'cdp',
  ): void {
    this.#lab.assertUsable(operation, operationLayer);
  }
  onInvalidated(listener: (record: CdpLabInvalidation) => void): () => void {
    return this.#lab.onInvalidated(listener);
  }
  noteFixtureDocumentChanged(): void {
    this.#lab.noteFixtureDocumentChanged();
  }
  invalidateFixturePage(operationLayer: CdpOperationLayer = 'cdp'): void {
    this.#lab.invalidateFixturePage(operationLayer);
  }
  withCommandBudget<T>(
    operation: string,
    layer: CdpOperationLayer,
    work: (options: BackendCallOptions, assertCommit: () => void) => Promise<T>,
    options?: BackendCallOptions,
  ): Promise<T> {
    return this.#lab.withBudget(operation, layer, work, options);
  }
  checkLiveness(
    operation: string,
    layer: CdpOperationLayer = 'cdp',
  ): Promise<void> {
    return this.#lab.checkLiveness(operation, layer);
  }
  diagnoseTimeout(
    operation: string,
    layer: CdpOperationLayer,
    timeout: BluetoothTimeoutError,
    kind: 'application-operation' | 'prompt' = 'application-operation',
  ): Promise<never> {
    return this.#lab.diagnoseTimeout(operation, layer, timeout, kind);
  }

  setCentralState(
    state: CentralState,
    options?: BackendCallOptions,
  ): Promise<void> {
    assertCentralState(state);
    return this.#trackCall(
      this.#runMutation(
        'adapter',
        'central-state',
        options,
        async (scope) => {
          await this.#lab.stateCommand(scope, state);
        },
        { state },
      ),
    );
  }

  addPeripheral(
    definition: NormalizedPeripheral,
    options?: BackendCallOptions,
  ): Promise<void> {
    return this.#trackCall(
      this.#runMutation(
        'peripheral',
        'peripheral-registration',
        options,
        async (scope) => {
          const identity = await this.#entities.addPeripheralHierarchy(
            definition,
            this.#entityMutation(scope),
          );
          scope.assertCommittable();
          this.#knownPeripherals.add(definition.address);
          if (identity === 'created') {
            safeAppend(this.timeline, {
              category: 'peripheral',
              type: 'identity-bootstrap',
              entity: peripheralReference(definition.address),
              status: 'succeeded',
              data: { source: 'service-model' },
            });
          }
        },
        { address: definition.address },
        definition.address,
      ),
    );
  }

  simulateAdvertisement(
    peripheral: NormalizedPeripheral,
    options?: BackendCallOptions,
  ): Promise<void> {
    const advertisement = this.#entities.getPeripheral(
      peripheral.address,
    )?.advertisement;
    return this.#trackCall(
      this.#runMutation(
        'advertisement',
        'advertisement',
        options,
        async (scope) => {
          const identity = await this.#entities.simulateAdvertisement(
            peripheral.address,
            this.#entityMutation(scope),
          );
          if (identity === 'created') {
            safeAppend(this.timeline, {
              category: 'peripheral',
              type: 'identity-bootstrap',
              entity: peripheralReference(peripheral.address),
              status: 'succeeded',
              data: { source: 'advertisement' },
            });
          }
          scope.assertCommittable();
          this.#advertisementsSent += 1;
        },
        {
          address: peripheral.address,
          appearanceSubstituted: advertisement?.appearance === undefined,
          txPowerSubstituted: advertisement?.txPower === undefined,
          txPowerSubstitutionApplicationVisible:
            advertisement?.txPower === undefined,
        },
        peripheral.address,
      ),
    );
  }

  createPreconnectedPeripheral(
    peripheral: NormalizedPeripheral,
    options?: BackendCallOptions,
  ): Promise<void> {
    return this.#trackCall(
      this.#runMutation(
        'peripheral',
        'preconnected-peripheral',
        options,
        async (scope) => {
          await this.#entities.createPreconnectedPeripheral(
            peripheral.address,
            this.#entityMutation(scope),
          );
        },
        { address: peripheral.address, intent: 'user-requested' },
        peripheral.address,
      ),
    );
  }

  disconnect(
    address: BluetoothAddress,
    options?: BackendCallOptions,
  ): Promise<void> {
    return this.#trackCall(
      this.#runMutation(
        'gatt',
        'gatt-disconnection',
        options,
        async (scope) => {
          const cancelledOperations =
            this.#pendingOperations.cancelForPeripheral(
              address,
              'peripheral-disconnected',
            );
          safeAppend(this.timeline, {
            category: 'gatt',
            type: 'disconnect-pending-cancellation',
            entity: peripheralReference(address),
            status: 'succeeded',
            data: { cancelledOperations },
          });
          await this.#gattHandler.disconnect(
            address,
            scope.sender(this.#browserTransport),
          );
          await this.#entities.rehydrateAfterDisconnection(
            address,
            this.#entityMutation(scope),
          );
          safeAppend(this.timeline, {
            category: 'peripheral',
            type: 'peripheral-hierarchy-rehydration',
            entity: peripheralReference(address),
            status: 'succeeded',
            data: { source: 'scripted-disconnection' },
          });
        },
        { address },
        address,
      ),
    );
  }

  respondToGattOperation(
    response: GattOperationResponse,
    options?: BackendCallOptions,
  ): Promise<void> {
    return this.#trackCall(
      this.#runResponseMutation(
        'respondToGattOperation',
        options,
        response.operationId,
        (scope) =>
          this.#gattHandler.respond(
            response,
            scope.sender(this.#browserTransport),
          ),
      ),
    );
  }

  respondToCharacteristicOperation(
    response: CharacteristicOperationResponse,
    options?: BackendCallOptions,
  ): Promise<void> {
    return this.#trackCall(
      this.#runResponseMutation(
        'respondToCharacteristicOperation',
        options,
        response.operationId,
        (scope) =>
          this.#characteristicHandler.respond(
            response,
            scope.sender(this.#browserTransport),
          ),
      ),
    );
  }

  respondToDescriptorOperation(
    response: DescriptorOperationResponse,
    options?: BackendCallOptions,
  ): Promise<void> {
    return this.#trackCall(
      this.#runResponseMutation(
        'respondToDescriptorOperation',
        options,
        response.operationId,
        (scope) =>
          this.#descriptorHandler.respond(
            response,
            scope.sender(this.#browserTransport),
          ),
      ),
    );
  }

  onEvent(listener: (event: BackendBluetoothEvent) => void): () => void {
    this.#lab.assertUsable('onEvent');
    return this.#lifecycle.onEvent(listener);
  }

  waitForDevicePrompt(
    options?: WaitForDevicePromptOptions,
  ): Promise<CdpDevicePrompt> {
    if (options?.deadlineMs !== undefined)
      assertPositiveSafeInteger(options.deadlineMs, 'Device prompt deadlineMs');
    const requestedLayer: unknown = options?.operationLayer;
    if (
      requestedLayer !== undefined &&
      requestedLayer !== 'cdp' &&
      requestedLayer !== 'playwright'
    )
      throw new TypeError('Device prompt operationLayer is invalid.');
    this.#lab.assertUsable('waitForDevicePrompt');
    this.#lifecycle.assertStarted('wait for a device prompt');
    return this.#promptController.waitForDevicePrompt(options);
  }

  #entityMutation(scope: CdpCommandScope) {
    return {
      transport: scope.sender(this.#browserTransport),
      assertCommittable: () => {
        scope.assertCommittable();
      },
      markModelEffect: () => {
        scope.markModelEffect();
      },
    };
  }

  async #runResponseMutation(
    operation: string,
    options: BackendCallOptions | undefined,
    operationId: string,
    mutation: (scope: CdpCommandScope) => Promise<void>,
  ): Promise<void> {
    this.#lab.assertUsable(operation);
    this.#lifecycle.assertStarted(operation);
    const unsubscribe =
      options?.cancellation?.onCancelled(() =>
        this.#pendingOperations.cancel(operationId, 'caller-cancelled'),
      ) ?? (() => undefined);
    try {
      await this.#lab.withBudget(
        operation,
        'cdp',
        async (token, assertCommit) => {
          const native = mutation(this.#lab.scope(token));
          this.#trackMutation(native);
          await native;
          assertCommit();
        },
        options,
      );
    } finally {
      unsubscribe();
    }
  }

  #trackCall(call: Promise<void>): Promise<void> {
    const tracked = call.then(
      () => undefined,
      () => undefined,
    );
    this.#inFlightCalls.add(tracked);
    void tracked.then(() => {
      this.#inFlightCalls.delete(tracked);
    });
    return call;
  }

  async #callsSettled(): Promise<void> {
    const calls = [...this.#inFlightCalls];
    if (calls.length === 0) return;
    await Promise.all(calls);
    return this.#callsSettled();
  }

  #trackMutation(mutation: Promise<void>): void {
    const tracked = mutation.then(
      () => undefined,
      () => undefined,
    );
    this.#inFlightMutations.add(tracked);
    void tracked.then(() => {
      this.#inFlightMutations.delete(tracked);
    });
  }

  async #mutationsSettled(): Promise<void> {
    const mutations = [...this.#inFlightMutations];
    if (mutations.length === 0) return;
    await Promise.all(mutations);
    return this.#mutationsSettled();
  }

  async #runMutation(
    category: BackendTimelineCategory,
    type: string,
    options: BackendCallOptions | undefined,
    mutation: (scope: CdpCommandScope) => Promise<void>,
    data: Readonly<Record<string, DiagnosticValue>>,
    address?: BluetoothAddress,
  ): Promise<void> {
    const operation =
      (
        {
          'central-state': 'setCentralState',
          'peripheral-registration': 'addPeripheral',
          advertisement: 'simulateAdvertisement',
          'preconnected-peripheral': 'createPreconnectedPeripheral',
          'gatt-disconnection': 'disconnect',
        } as Record<string, string>
      )[type] ?? type;
    this.#lab.assertUsable(operation);
    this.#lifecycle.assertStarted(operation);
    const entity =
      address === undefined ? undefined : peripheralReference(address);
    options?.cancellation?.throwIfCancelled();
    safeAppend(this.timeline, {
      category,
      type,
      ...(entity ? { entity } : {}),
      status: 'requested',
      data,
    });
    try {
      await this.#lab.withBudget(
        operation,
        'cdp',
        async (token, assertCommit) => {
          const native = mutation(this.#lab.scope(token));
          const observed = native.then(
            () => {
              if (options?.cancellation?.cancelled)
                safeAppend(this.timeline, {
                  category,
                  type: 'backend-call-late-completion',
                  ...(entity ? { entity } : {}),
                  status: 'cancelled',
                  data: {
                    ...data,
                    completion: 'protocol-success',
                    operationType: type,
                  },
                });
            },
            (cause: unknown) => {
              if (options?.cancellation?.cancelled)
                safeAppend(this.timeline, {
                  category,
                  type: 'backend-call-late-completion',
                  ...(entity ? { entity } : {}),
                  status: 'cancelled',
                  data: {
                    ...data,
                    completion: 'protocol-failure',
                    operationType: type,
                    reason: operationFailureReason(cause),
                  },
                });
            },
          );
          this.#trackMutation(observed);
          await native;
          if (!this.#lab.stopped) assertCommit();
          safeAppend(this.timeline, {
            category,
            type,
            ...(entity ? { entity } : {}),
            status: 'succeeded',
            data,
          });
        },
        options,
      );
    } catch (cause) {
      safeAppend(this.timeline, {
        category,
        type,
        ...(entity ? { entity } : {}),
        status:
          cause instanceof BluetoothCancelledError ? 'cancelled' : 'failed',
        data: { ...data, reason: operationFailureReason(cause) },
      });
      throw cause;
    }
  }

  async #teardown(): Promise<void> {
    const failures: CleanupFailure[] = [];
    safeAppend(this.timeline, {
      category: 'lifecycle',
      type: 'backend-stop',
      status: 'requested',
    });

    const cancelledOperations =
      this.#pendingOperations.cancelAll('backend-stopping');
    this.#promptController.dispose('backend-stopping');
    for (const unsubscribe of this.#handlerUnsubscribers.splice(0)) {
      try {
        unsubscribe();
      } catch (cause) {
        recordCleanupFailure(
          failures,
          this.timeline,
          'operation-listener-removal',
          cause,
        );
      }
    }
    safeAppend(this.timeline, {
      category: 'lifecycle',
      type: 'pending-operation-cancellation',
      status: 'cancelled',
      data: { cancelledOperations },
    });

    await attemptCleanup(failures, this.timeline, 'DeviceAccess.disable', () =>
      this.#pageTransport.send('DeviceAccess.disable'),
    );
    const bluetoothDisabled = await attemptCleanup(
      failures,
      this.timeline,
      'BluetoothEmulation.disable',
      () => this.#browserTransport.send('BluetoothEmulation.disable'),
    );
    if (bluetoothDisabled) this.#entities.resetAfterDomainDisable();
    await attemptCleanup(failures, this.timeline, 'page-session.detach', () =>
      this.#pageTransport.detach(),
    );
    await attemptCleanup(
      failures,
      this.timeline,
      'browser-session.detach',
      () => this.#browserTransport.detach(),
    );

    try {
      const settled = await settleWithinDeadline(
        Promise.all([
          this.#pendingOperations.settled(),
          this.#callsSettled(),
          this.#mutationsSettled(),
        ]).then(() => undefined),
        this.#deadlineScheduler,
        this.#teardownDeadlineMs,
      );
      if (!settled) {
        const cause = new BluetoothTimeoutError(
          `Bluetooth teardown mutations did not settle within ${String(this.#teardownDeadlineMs)} ms.`,
          {
            context: {
              deadlineMs: this.#teardownDeadlineMs,
              operation: 'backend-stop',
              reason: 'pending-operation-settlement-timeout',
            },
          },
        );
        recordCleanupFailure(
          failures,
          this.timeline,
          'pending-operations.settled',
          cause,
          'timed-out',
        );
      } else {
        safeAppend(this.timeline, {
          category: 'lifecycle',
          type: 'pending-operation-settlement',
          status: 'succeeded',
          data: { deadlineMs: this.#teardownDeadlineMs },
        });
      }
    } catch (cause) {
      recordCleanupFailure(
        failures,
        this.timeline,
        'pending-operations.settled',
        cause,
      );
    }

    await attemptCleanup(failures, this.timeline, 'artifact-flush', () =>
      this.#flushArtifacts(this.timeline.snapshot()),
    );
    await attemptCleanup(
      failures,
      this.timeline,
      'browser-process-lease.release',
      this.#releaseLease,
    );
    safeAppend(this.timeline, {
      category: 'lifecycle',
      type: 'backend-stop',
      status: failures.length === 0 ? 'succeeded' : 'failed',
      data: { cleanupFailureCount: failures.length },
    });
    this.timeline.close();

    if (failures.length > 0) {
      throw new AggregateError(
        failures.map(({ cause }) => cause),
        `Bluetooth backend teardown completed with ${String(failures.length)} cleanup failure(s): ${failures.map(({ name }) => name).join(', ')}.`,
      );
    }
  }
}

async function unwindFailedStartup(options: {
  readonly browserTransport: CdpTransport<'browser'>;
  readonly pageTransport: CdpTransport<'page'>;
  readonly timeline: BluetoothTimeline;
  readonly bluetoothEmulationEnableAttempted: boolean;
  readonly deviceAccessEnableAttempted: boolean;
  readonly flushArtifacts:
    ((events: readonly BluetoothTimelineEvent[]) => Promise<void>) | undefined;
  readonly releaseLease: () => Promise<void>;
}): Promise<void> {
  const failures: CleanupFailure[] = [];
  if (options.deviceAccessEnableAttempted) {
    await attemptCleanup(
      failures,
      options.timeline,
      'DeviceAccess.disable',
      () => options.pageTransport.send('DeviceAccess.disable'),
    );
  }
  if (options.bluetoothEmulationEnableAttempted) {
    await attemptCleanup(
      failures,
      options.timeline,
      'BluetoothEmulation.disable',
      () => options.browserTransport.send('BluetoothEmulation.disable'),
    );
  }
  await attemptCleanup(failures, options.timeline, 'page-session.detach', () =>
    options.pageTransport.detach(),
  );
  await attemptCleanup(
    failures,
    options.timeline,
    'browser-session.detach',
    () => options.browserTransport.detach(),
  );
  await attemptCleanup(
    failures,
    options.timeline,
    'artifact-flush',
    () =>
      options.flushArtifacts?.(options.timeline.snapshot()) ??
      Promise.resolve(),
  );
  await attemptCleanup(
    failures,
    options.timeline,
    'browser-process-lease.release',
    options.releaseLease,
  );
  safeAppend(options.timeline, {
    category: 'lifecycle',
    type: 'backend-start-unwind',
    status: failures.length === 0 ? 'succeeded' : 'failed',
    data: { cleanupFailureCount: failures.length },
  });
  options.timeline.close();
}

async function attemptCleanup(
  failures: CleanupFailure[],
  timeline: BluetoothTimeline,
  name: string,
  run: () => Promise<unknown>,
): Promise<boolean> {
  try {
    await run();
    safeAppend(timeline, {
      category: 'lifecycle',
      type: 'cleanup-step',
      status: 'succeeded',
      data: { step: name },
    });
    return true;
  } catch (cause) {
    recordCleanupFailure(failures, timeline, name, cause);
    return false;
  }
}

function recordCleanupFailure(
  failures: CleanupFailure[],
  timeline: BluetoothTimeline,
  name: string,
  cause: unknown,
  status: 'failed' | 'timed-out' = 'failed',
): void {
  failures.push(Object.freeze({ name, cause }));
  safeAppend(timeline, {
    category: 'lifecycle',
    type: 'cleanup-step',
    status,
    data: { reason: operationFailureReason(cause), step: name },
  });
}

async function settleWithinDeadline(
  settlement: Promise<void>,
  scheduler: CdpBackendDeadlineScheduler,
  deadlineMs: number,
): Promise<boolean> {
  let resolveDeadline: ((settled: false) => void) | undefined;
  const expired = new Promise<false>((resolve) => {
    resolveDeadline = resolve;
  });
  if (resolveDeadline === undefined) {
    throw new TypeError('Teardown deadline promise was not initialized.');
  }
  const deadline: unknown = scheduler.schedule(deadlineMs, () => {
    resolveDeadline?.(false);
  });
  assertDeadline(deadline);
  const settled = settlement.then(() => true as const);
  const result = await Promise.race([settled, expired]);
  if (result) deadline.cancel();
  return result;
}

function assertFactoryOptions(
  options: CdpBluetoothBackendFactoryOptions,
): void {
  if (typeof options.browserName !== 'string' || options.browserName === '') {
    throw new TypeError('CDP backend browserName must be non-empty.');
  }
  if (typeof options.inspectWebBluetoothEnvironment !== 'function') {
    throw new TypeError(
      'CDP backend requires a Web Bluetooth environment inspector.',
    );
  }
  if (typeof options.releaseLease !== 'function') {
    throw new TypeError('CDP backend releaseLease must be a function.');
  }
  if (
    options.flushArtifacts !== undefined &&
    typeof options.flushArtifacts !== 'function'
  ) {
    throw new TypeError('CDP backend flushArtifacts must be a function.');
  }
  if (options.commandDeadlineMs !== undefined)
    assertPositiveSafeInteger(
      options.commandDeadlineMs,
      'CDP backend commandDeadlineMs',
    );
  assertPositiveSafeInteger(
    options.operationDeadlineMs,
    'CDP backend operationDeadlineMs',
  );
  assertPositiveSafeInteger(
    options.promptDeadlineMs,
    'CDP backend promptDeadlineMs',
  );
  assertPositiveSafeInteger(
    options.teardownDeadlineMs,
    'CDP backend teardownDeadlineMs',
  );
}

function assertCentralState(state: unknown): asserts state is CentralState {
  if (state === 'absent' || state === 'powered-off' || state === 'powered-on') {
    return;
  }
  throw new TypeError('CDP backend central state is invalid.');
}

function assertDeadline(value: unknown): asserts value is OperationDeadline {
  if (
    typeof value === 'object' &&
    value !== null &&
    'cancel' in value &&
    typeof value.cancel === 'function'
  ) {
    return;
  }
  throw new TypeError(
    'CDP backend deadlineScheduler.schedule() must return a cancellable deadline.',
  );
}

function assertPositiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive safe integer.`);
  }
}

function safeAppend(
  timeline: BluetoothTimeline,
  input: TimelineEventInput,
): void {
  try {
    timeline.append(input);
  } catch {
    // Cleanup must continue even if a diagnostic clock or sink is unavailable.
  }
}

function peripheralReference(address: BluetoothAddress) {
  return Object.freeze({ kind: 'peripheral' as const, address });
}

function operationFailureReason(cause: unknown): string {
  if (cause instanceof BluetoothCancelledError) return 'cancelled';
  if (cause instanceof BluetoothTimeoutError) return 'timed-out';
  if (cause instanceof Error && cause.name.length > 0) return cause.name;
  return 'unknown-failure';
}

function startupFailureReason(cause: unknown): string {
  return cause instanceof BluetoothCancelledError
    ? 'startup-cancelled'
    : operationFailureReason(cause);
}

function cancellationCause(
  signal: CancellationSignal | undefined,
  fallback: unknown,
): unknown {
  if (signal?.cancelled !== true) return fallback;
  try {
    signal.throwIfCancelled();
  } catch (cause) {
    return cause;
  }
  return new BluetoothCancelledError('Bluetooth startup was cancelled.', {
    context: { operation: 'backend-start' },
  });
}

function eventFailureReason(cause: unknown): string {
  if (cause instanceof BluetoothValidationError) {
    const reason = cause.context['reason'];
    if (typeof reason === 'string') return reason;
  }
  return operationFailureReason(cause);
}
