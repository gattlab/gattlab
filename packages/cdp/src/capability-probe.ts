import {
  BluetoothCapabilityUnsupportedError,
  runBestEffortBackendCleanup,
  snapshotBluetoothCapabilities,
  type BluetoothCapabilities,
} from '@gattlab/core';

import { CdpTransportError, type CdpTransport } from './transport.js';
import {
  bluetoothEmulationAlreadyActiveError,
  isBluetoothEmulationAlreadyEnabledError,
} from './domain-conflict.js';

export interface WebBluetoothEnvironment {
  readonly secureContext: boolean;
  readonly navigatorBluetooth: boolean;
}

export interface CdpCapabilityProbeOptions {
  readonly browserName: string;
  readonly browserTransport: CdpTransport<'browser'>;
  readonly pageTransport: CdpTransport<'page'>;
  /** Read the page environment without acquiring a lease; inspector failures become capability diagnostics. */
  readonly inspectWebBluetoothEnvironment: () => Promise<WebBluetoothEnvironment>;
}

interface BrowserIdentity {
  readonly product: string;
  readonly version: string;
  readonly protocolVersion: string;
  readonly platform: BrowserPlatform;
}

type BrowserPlatform = 'linux' | 'macos' | 'windows' | 'unknown';

interface ProbeFailure {
  readonly step: string;
  readonly cause: unknown;
}

const linuxWebBluetoothLaunchArgument = '--enable-features=WebBluetooth';

/** Probes Chromium and both required CDP targets before backend startup. */
export class CdpCapabilityProbe {
  readonly #browserName: string;
  readonly #browserTransport: CdpTransport<'browser'>;
  readonly #pageTransport: CdpTransport<'page'>;
  readonly #inspectWebBluetoothEnvironment: () => Promise<WebBluetoothEnvironment>;

  /** Configure an inactive browser/page session pair; a missing name or inspector throws TypeError synchronously. */
  constructor(options: CdpCapabilityProbeOptions) {
    if (typeof options.browserName !== 'string' || options.browserName === '') {
      throw new TypeError('Capability probe browserName must be non-empty.');
    }
    if (typeof options.inspectWebBluetoothEnvironment !== 'function') {
      throw new TypeError(
        'Capability probe requires a Web Bluetooth environment inspector.',
      );
    }

    this.#browserName = options.browserName;
    this.#browserTransport = options.browserTransport;
    this.#pageTransport = options.pageTransport;
    this.#inspectWebBluetoothEnvironment =
      options.inspectWebBluetoothEnvironment;
  }

  /** Probe required domains reversibly without detaching sessions; return immutable capabilities or reject with typed capability/conflict errors. No probe deadline. */
  async probe(): Promise<BluetoothCapabilities> {
    this.#assertChromium();
    const identity = await this.#readBrowserIdentity();
    const environment = await this.#readWebBluetoothEnvironment(identity);
    this.#assertWebBluetoothEnvironment(environment, identity);
    await this.#probeRequiredProtocolSet(identity);

    return snapshotBluetoothCapabilities({
      browserName: 'chromium',
      browserProduct: identity.product,
      browserVersion: identity.version,
      protocolVersion: identity.protocolVersion,
      domains: {
        bluetoothEmulation: true,
        deviceAccess: true,
      },
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
    });
  }

  #assertChromium(): void {
    if (this.#browserName === 'chromium') return;
    throw new BluetoothCapabilityUnsupportedError(
      `The GattLab native backend supports Chromium only; received ${this.#browserName}.`,
      {
        context: {
          capability: 'browser-engine',
          browserName: this.#browserName,
          supportedBrowserName: 'chromium',
        },
      },
    );
  }

  async #readBrowserIdentity(): Promise<BrowserIdentity> {
    try {
      const result: unknown =
        await this.#browserTransport.send('Browser.getVersion');
      return parseBrowserIdentity(result);
    } catch (cause) {
      if (isClosedSessionError(cause)) {
        throw closedSessionCapabilityError(cause, 'Browser.getVersion');
      }
      throw new BluetoothCapabilityUnsupportedError(
        'Chromium browser identity could not be read through CDP.',
        {
          cause,
          context: {
            capability: 'required-cdp-capability-set',
            step: 'Browser.getVersion',
          },
        },
      );
    }
  }

  async #readWebBluetoothEnvironment(
    identity: BrowserIdentity,
  ): Promise<WebBluetoothEnvironment> {
    try {
      const result: unknown = await this.#inspectWebBluetoothEnvironment();
      return parseWebBluetoothEnvironment(result);
    } catch (cause) {
      throw new BluetoothCapabilityUnsupportedError(
        'The page Web Bluetooth environment could not be inspected.',
        {
          cause,
          context: {
            capability: 'navigator.bluetooth',
            step: 'inspect page environment',
            browserProduct: identity.product,
            browserVersion: identity.version,
          },
        },
      );
    }
  }

  #assertWebBluetoothEnvironment(
    environment: WebBluetoothEnvironment,
    identity: BrowserIdentity,
  ): void {
    if (!environment.secureContext) {
      throw new BluetoothCapabilityUnsupportedError(
        'Web Bluetooth requires a secure page context. Use HTTPS or localhost before creating the lab.',
        {
          context: {
            capability: 'secure-context',
            browserProduct: identity.product,
            browserVersion: identity.version,
            secureContext: false,
          },
        },
      );
    }
    if (environment.navigatorBluetooth) return;
    if (identity.platform !== 'linux') {
      throw new BluetoothCapabilityUnsupportedError(
        'navigator.bluetooth is unavailable. Confirm that Web Bluetooth is enabled and permitted for this Chromium build and platform.',
        {
          context: {
            capability: 'navigator.bluetooth',
            browserProduct: identity.product,
            browserVersion: identity.version,
            browserPlatform: identity.platform,
          },
        },
      );
    }
    throw new BluetoothCapabilityUnsupportedError(
      `navigator.bluetooth is unavailable. On Linux, launch Chromium with ${linuxWebBluetoothLaunchArgument}.`,
      {
        context: {
          capability: 'navigator.bluetooth',
          browserProduct: identity.product,
          browserVersion: identity.version,
          browserPlatform: identity.platform,
          launchArgument: linuxWebBluetoothLaunchArgument,
        },
      },
    );
  }

  async #probeRequiredProtocolSet(identity: BrowserIdentity): Promise<void> {
    let bluetoothEmulationEnabled = false;
    let deviceAccessEnabled = false;
    let failure: ProbeFailure | undefined;

    try {
      await this.#browserTransport.send('BluetoothEmulation.enable', {
        state: 'powered-off',
        leSupported: true,
      });
      bluetoothEmulationEnabled = true;
    } catch (cause) {
      failure = { step: 'BluetoothEmulation.enable', cause };
    }

    if (failure === undefined) {
      try {
        await this.#pageTransport.send('DeviceAccess.enable');
        deviceAccessEnabled = true;
      } catch (cause) {
        failure = { step: 'DeviceAccess.enable', cause };
      }
    }

    const cleanupFailures = await runBestEffortBackendCleanup([
      ...(deviceAccessEnabled
        ? [
            {
              name: 'DeviceAccess.disable',
              run: () => this.#pageTransport.send('DeviceAccess.disable'),
            },
          ]
        : []),
      ...(bluetoothEmulationEnabled
        ? [
            {
              name: 'BluetoothEmulation.disable',
              run: () =>
                this.#browserTransport.send('BluetoothEmulation.disable'),
            },
          ]
        : []),
    ]);

    if (failure === undefined && cleanupFailures.length === 0) return;

    if (
      failure?.step === 'BluetoothEmulation.enable' &&
      isBluetoothEmulationAlreadyEnabledError(failure.cause)
    ) {
      throw bluetoothEmulationAlreadyActiveError(failure.cause);
    }

    const causes = [
      ...(failure === undefined ? [] : [failure.cause]),
      ...cleanupFailures.map(({ cause }) => cause),
    ];
    const cause =
      causes.length === 1
        ? causes[0]
        : new AggregateError(causes, 'CDP capability probe cleanup failed.');
    const closedSessionError = causes.find(isClosedSessionError);
    if (closedSessionError !== undefined) {
      throw closedSessionCapabilityError(
        closedSessionError,
        failure?.step ?? 'cleanup',
        cause,
        identity,
        cleanupFailures.map(({ name }) => name),
      );
    }
    throw new BluetoothCapabilityUnsupportedError(
      'Chromium does not provide the complete experimental CDP capability set required by GattLab.',
      {
        cause,
        context: {
          capability: 'required-cdp-capability-set',
          step: failure?.step ?? 'cleanup',
          browserProduct: identity.product,
          browserVersion: identity.version,
          cleanupFailures: cleanupFailures.map(({ name }) => name),
        },
      },
    );
  }
}

function parseBrowserIdentity(value: unknown): BrowserIdentity {
  if (value === null || typeof value !== 'object') {
    throw new TypeError('Browser.getVersion returned a non-object result.');
  }
  const record = value as Readonly<Record<string, unknown>>;
  const product = record['product'];
  const protocolVersion = record['protocolVersion'];
  const userAgent = record['userAgent'];
  if (typeof product !== 'string' || typeof protocolVersion !== 'string') {
    throw new TypeError(
      'Browser.getVersion returned invalid product or protocolVersion fields.',
    );
  }
  const separator = product.lastIndexOf('/');
  if (separator < 1 || separator === product.length - 1) {
    throw new TypeError(
      'Browser.getVersion returned an invalid product field.',
    );
  }
  return Object.freeze({
    product,
    version: product.slice(separator + 1),
    protocolVersion,
    platform:
      typeof userAgent === 'string'
        ? parseBrowserPlatform(userAgent)
        : 'unknown',
  });
}

function parseBrowserPlatform(userAgent: string): BrowserPlatform {
  if (/\bLinux\b/u.test(userAgent)) return 'linux';
  if (/\b(?:Macintosh|Mac OS X)\b/u.test(userAgent)) return 'macos';
  if (/\bWindows\b/u.test(userAgent)) return 'windows';
  return 'unknown';
}

function isClosedSessionError(cause: unknown): cause is CdpTransportError {
  return cause instanceof CdpTransportError && cause.kind === 'session-closed';
}

function closedSessionCapabilityError(
  sessionError: CdpTransportError,
  step: string,
  cause: unknown = sessionError,
  identity?: BrowserIdentity,
  cleanupFailures: readonly string[] = [],
): BluetoothCapabilityUnsupportedError {
  return new BluetoothCapabilityUnsupportedError(
    `The ${sessionError.target} CDP session closed while GattLab was probing browser capabilities. Keep the browser, context, and page alive until lab creation completes.`,
    {
      cause,
      context: {
        capability: 'cdp-session',
        step,
        transportErrorKind: sessionError.kind,
        transportTarget: sessionError.target,
        transportMethod: sessionError.method,
        ...(identity === undefined
          ? {}
          : {
              browserProduct: identity.product,
              browserVersion: identity.version,
            }),
        cleanupFailures: [...cleanupFailures],
      },
    },
  );
}

function parseWebBluetoothEnvironment(value: unknown): WebBluetoothEnvironment {
  if (value === null || typeof value !== 'object') {
    throw new TypeError('Web Bluetooth environment result must be an object.');
  }
  const record = value as Readonly<Record<string, unknown>>;
  if (
    typeof record['secureContext'] !== 'boolean' ||
    typeof record['navigatorBluetooth'] !== 'boolean'
  ) {
    throw new TypeError(
      'Web Bluetooth environment result must contain boolean secureContext and navigatorBluetooth fields.',
    );
  }
  return Object.freeze({
    secureContext: record['secureContext'],
    navigatorBluetooth: record['navigatorBluetooth'],
  });
}
