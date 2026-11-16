import { describe, expect, it, vi } from 'vitest';

import {
  BluetoothCapabilityUnsupportedError,
  BluetoothLabAlreadyActiveError,
} from '@gattlab/core';

import { CdpCapabilityProbe } from '../src/capability-probe.js';
import {
  CdpTransportError,
  createCdpTransport,
  type CdpSessionLike,
} from '../src/transport.js';

interface SentCommand {
  readonly method: string;
  readonly parameters?: object;
}

class ProbeCdpSession implements CdpSessionLike {
  readonly calls: SentCommand[] = [];
  readonly responses = new Map<string, unknown[]>();
  readonly failures = new Map<string, unknown[]>();
  readonly #listeners = new Map<string, Set<(payload: unknown) => void>>();

  async send(method: string, parameters?: object): Promise<unknown> {
    this.calls.push({
      method,
      ...(parameters === undefined ? {} : { parameters }),
    });
    const failure = this.failures.get(method)?.shift();
    if (failure !== undefined) throw failure;
    return this.responses.get(method)?.shift() ?? {};
  }

  on(event: string, listener: (payload: unknown) => void): void {
    const listeners = this.#listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(event, listeners);
  }

  off(event: string, listener: (payload: unknown) => void): void {
    this.#listeners.get(event)?.delete(listener);
  }

  detach(): Promise<void> {
    return Promise.resolve();
  }

  close(): void {
    for (const listener of this.#listeners.get('close') ?? []) listener({});
  }
}

function createProbe(
  options: Readonly<{
    browserName?: string;
    environment?: Readonly<{
      secureContext: boolean;
      navigatorBluetooth: boolean;
    }>;
    userAgent?: string;
  }> = {},
): Readonly<{
  browserSession: ProbeCdpSession;
  pageSession: ProbeCdpSession;
  inspectEnvironment: ReturnType<typeof vi.fn>;
  probe: CdpCapabilityProbe;
}> {
  const browserSession = new ProbeCdpSession();
  browserSession.responses.set('Browser.getVersion', [
    {
      protocolVersion: '1.3',
      product: 'HeadlessChrome/151.0.7922.34',
      revision: '@revision',
      userAgent:
        options.userAgent ??
        'Mozilla/5.0 (X11; Linux x86_64) HeadlessChrome/151.0.7922.34',
      jsVersion: '15.1',
    },
  ]);
  const pageSession = new ProbeCdpSession();
  const inspectEnvironment = vi.fn(async () =>
    Promise.resolve(
      options.environment ?? {
        secureContext: true,
        navigatorBluetooth: true,
      },
    ),
  );
  const probe = new CdpCapabilityProbe({
    browserName: options.browserName ?? 'chromium',
    browserTransport: createCdpTransport('browser', browserSession),
    pageTransport: createCdpTransport('page', pageSession),
    inspectWebBluetoothEnvironment: inspectEnvironment,
  });
  return { browserSession, pageSession, inspectEnvironment, probe };
}

describe('CdpCapabilityProbe', () => {
  it('returns a frozen capability snapshot after reverse domain cleanup', async () => {
    const { browserSession, pageSession, probe } = createProbe();

    const capabilities = await probe.probe();

    expect(capabilities).toEqual({
      browserName: 'chromium',
      browserProduct: 'HeadlessChrome/151.0.7922.34',
      browserVersion: '151.0.7922.34',
      protocolVersion: '1.3',
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
    expect(Object.isFrozen(capabilities)).toBe(true);
    expect(Object.isFrozen(capabilities.domains)).toBe(true);
    expect(Object.isFrozen(capabilities.operations)).toBe(true);
    expect(browserSession.calls).toEqual([
      { method: 'Browser.getVersion' },
      {
        method: 'BluetoothEmulation.enable',
        parameters: { state: 'powered-off', leSupported: true },
      },
      { method: 'BluetoothEmulation.disable' },
    ]);
    expect(pageSession.calls).toEqual([
      { method: 'DeviceAccess.enable' },
      { method: 'DeviceAccess.disable' },
    ]);
  });

  it('rejects a non-Chromium engine before inspecting or mutating', async () => {
    const { browserSession, pageSession, inspectEnvironment, probe } =
      createProbe({ browserName: 'firefox' });

    await expect(probe.probe()).rejects.toMatchObject({
      code: 'BLUETOOTH_CAPABILITY_UNSUPPORTED',
      context: {
        capability: 'browser-engine',
        browserName: 'firefox',
        supportedBrowserName: 'chromium',
      },
    } satisfies Partial<BluetoothCapabilityUnsupportedError>);
    expect(inspectEnvironment).not.toHaveBeenCalled();
    expect(browserSession.calls).toEqual([]);
    expect(pageSession.calls).toEqual([]);
  });

  it('explains the secure-context requirement before domain mutation', async () => {
    const { browserSession, pageSession, probe } = createProbe({
      environment: { secureContext: false, navigatorBluetooth: false },
    });

    await expect(probe.probe()).rejects.toMatchObject({
      message: expect.stringContaining('HTTPS or localhost'),
      context: {
        capability: 'secure-context',
        secureContext: false,
      },
    });
    expect(browserSession.calls).toEqual([{ method: 'Browser.getVersion' }]);
    expect(pageSession.calls).toEqual([]);
  });

  it('names the required Linux feature when navigator.bluetooth is absent', async () => {
    const { browserSession, pageSession, probe } = createProbe({
      environment: { secureContext: true, navigatorBluetooth: false },
    });

    await expect(probe.probe()).rejects.toMatchObject({
      message: expect.stringContaining('--enable-features=WebBluetooth'),
      context: {
        capability: 'navigator.bluetooth',
        browserPlatform: 'linux',
        launchArgument: '--enable-features=WebBluetooth',
      },
    });
    expect(browserSession.calls).toEqual([{ method: 'Browser.getVersion' }]);
    expect(pageSession.calls).toEqual([]);
  });

  it.each([
    {
      platform: 'macos',
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) HeadlessChrome/151.0.7922.34',
    },
    {
      platform: 'windows',
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) HeadlessChrome/151.0.7922.34',
    },
  ])(
    'does not recommend a Linux launch argument on $platform',
    async (testCase) => {
      const { browserSession, pageSession, probe } = createProbe({
        environment: { secureContext: true, navigatorBluetooth: false },
        userAgent: testCase.userAgent,
      });

      const error = await probe.probe().catch((cause: unknown) => cause);

      expect(error).toMatchObject({
        code: 'BLUETOOTH_CAPABILITY_UNSUPPORTED',
        context: {
          capability: 'navigator.bluetooth',
          browserPlatform: testCase.platform,
        },
      });
      expect(error).toBeInstanceOf(BluetoothCapabilityUnsupportedError);
      expect(
        (error as BluetoothCapabilityUnsupportedError).context,
      ).not.toHaveProperty('launchArgument');
      expect((error as Error).message).not.toContain(
        '--enable-features=WebBluetooth',
      );
      expect(browserSession.calls).toEqual([{ method: 'Browser.getVersion' }]);
      expect(pageSession.calls).toEqual([]);
    },
  );

  it.each([
    {
      description: 'a missing userAgent',
      versionResult: {
        protocolVersion: '1.3',
        product: 'HeadlessChrome/151.0.7922.34',
      },
    },
    {
      description: 'a non-string userAgent',
      versionResult: {
        protocolVersion: '1.3',
        product: 'HeadlessChrome/151.0.7922.34',
        userAgent: 151,
      },
    },
    {
      description: 'an unrecognized userAgent',
      versionResult: {
        protocolVersion: '1.3',
        product: 'HeadlessChrome/151.0.7922.34',
        userAgent: 'ReducedAgent/151',
      },
    },
  ])(
    'uses platform-agnostic guidance for $description',
    async ({ versionResult }) => {
      const { browserSession, pageSession, probe } = createProbe({
        environment: { secureContext: true, navigatorBluetooth: false },
      });
      browserSession.responses.set('Browser.getVersion', [versionResult]);

      const error = await probe.probe().catch((cause: unknown) => cause);

      expect(error).toMatchObject({
        code: 'BLUETOOTH_CAPABILITY_UNSUPPORTED',
        context: {
          capability: 'navigator.bluetooth',
          browserPlatform: 'unknown',
        },
      });
      expect(error).toBeInstanceOf(BluetoothCapabilityUnsupportedError);
      expect(
        (error as BluetoothCapabilityUnsupportedError).context,
      ).not.toHaveProperty('launchArgument');
      expect((error as Error).message).not.toContain(
        '--enable-features=WebBluetooth',
      );
      expect(browserSession.calls).toEqual([{ method: 'Browser.getVersion' }]);
      expect(pageSession.calls).toEqual([]);
    },
  );

  it('distinguishes a closed browser session from missing CDP capabilities', async () => {
    const { browserSession, pageSession, probe } = createProbe();
    browserSession.close();

    const error = await probe.probe().catch((cause: unknown) => cause);

    expect(error).toMatchObject({
      code: 'BLUETOOTH_CAPABILITY_UNSUPPORTED',
      context: {
        capability: 'cdp-session',
        step: 'Browser.getVersion',
        transportErrorKind: 'session-closed',
        transportTarget: 'browser',
        transportMethod: 'Browser.getVersion',
      },
      cause: {
        name: 'CdpTransportError',
        kind: 'session-closed',
      },
    });
    expect((error as Error).message).toContain('browser CDP session closed');
    expect((error as Error).message).not.toContain('capability set');
    expect(browserSession.calls).toEqual([]);
    expect(pageSession.calls).toEqual([]);
  });

  it('distinguishes a closed page session during domain probing', async () => {
    const { browserSession, pageSession, inspectEnvironment, probe } =
      createProbe();
    inspectEnvironment.mockImplementationOnce(async () => {
      pageSession.close();
      return { secureContext: true, navigatorBluetooth: true };
    });

    const error = await probe.probe().catch((cause: unknown) => cause);

    expect(error).toMatchObject({
      code: 'BLUETOOTH_CAPABILITY_UNSUPPORTED',
      context: {
        capability: 'cdp-session',
        step: 'DeviceAccess.enable',
        transportErrorKind: 'session-closed',
        transportTarget: 'page',
        transportMethod: 'DeviceAccess.enable',
        cleanupFailures: [],
      },
      cause: {
        name: 'CdpTransportError',
        kind: 'session-closed',
      },
    });
    expect((error as Error).message).toContain('page CDP session closed');
    expect(browserSession.calls.at(-1)).toEqual({
      method: 'BluetoothEmulation.disable',
    });
    expect(pageSession.calls).toEqual([]);
  });

  it('preserves an opaque domain failure and cleans earlier ownership', async () => {
    const { browserSession, pageSession, probe } = createProbe();
    const rawCause = new Error("method wasn't found");
    pageSession.failures.set('DeviceAccess.enable', [rawCause]);

    const error = await probe.probe().catch((cause: unknown) => cause);

    expect(error).toMatchObject({
      code: 'BLUETOOTH_CAPABILITY_UNSUPPORTED',
      context: {
        capability: 'required-cdp-capability-set',
        step: 'DeviceAccess.enable',
        cleanupFailures: [],
      },
      cause: {
        name: 'CdpTransportError',
        kind: 'command-failed',
        method: 'DeviceAccess.enable',
        cause: rawCause,
      },
    });
    expect((error as Error).message).not.toContain("wasn't found");
    expect(browserSession.calls.at(-1)).toEqual({
      method: 'BluetoothEmulation.disable',
    });
    expect(pageSession.calls).toEqual([{ method: 'DeviceAccess.enable' }]);
  });

  it('maps the exact competing enable failure without disabling a foreign domain', async () => {
    const { browserSession, pageSession, probe } = createProbe();
    const rawCause = new Error(
      'Protocol error (BluetoothEmulation.enable): BluetoothEmulation already enabled',
    );
    browserSession.failures.set('BluetoothEmulation.enable', [rawCause]);

    const error = await probe.probe().catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(BluetoothLabAlreadyActiveError);
    expect(error).toMatchObject({
      code: 'BLUETOOTH_LAB_ALREADY_ACTIVE',
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
    expect((error as Error).message).toMatch(/connectOptions|shared browser/u);
    expect(browserSession.calls).toEqual([
      { method: 'Browser.getVersion' },
      {
        method: 'BluetoothEmulation.enable',
        parameters: { state: 'powered-off', leSupported: true },
      },
    ]);
    expect(pageSession.calls).toEqual([]);
  });

  it('keeps an unrelated enable failure as a capability error', async () => {
    const { browserSession, pageSession, probe } = createProbe();
    const rawCause = new Error(
      'Protocol error (BluetoothEmulation.enable): another rejection',
    );
    browserSession.failures.set('BluetoothEmulation.enable', [rawCause]);

    await expect(probe.probe()).rejects.toMatchObject({
      name: 'BluetoothCapabilityUnsupportedError',
      code: 'BLUETOOTH_CAPABILITY_UNSUPPORTED',
      context: {
        step: 'BluetoothEmulation.enable',
        cleanupFailures: [],
      },
      cause: {
        name: 'CdpTransportError',
        cause: rawCause,
      },
    });
    expect(browserSession.calls.at(-1)).toEqual({
      method: 'BluetoothEmulation.enable',
      parameters: { state: 'powered-off', leSupported: true },
    });
    expect(pageSession.calls).toEqual([]);
  });

  it('attempts all owned cleanup steps and reports cleanup capability failure', async () => {
    const { browserSession, pageSession, probe } = createProbe();
    pageSession.failures.set('DeviceAccess.disable', [
      new Error('page cleanup failed'),
    ]);

    await expect(probe.probe()).rejects.toMatchObject({
      code: 'BLUETOOTH_CAPABILITY_UNSUPPORTED',
      context: {
        capability: 'required-cdp-capability-set',
        step: 'cleanup',
        cleanupFailures: ['DeviceAccess.disable'],
      },
      cause: expect.any(CdpTransportError),
    });
    expect(pageSession.calls.at(-1)).toEqual({
      method: 'DeviceAccess.disable',
    });
    expect(browserSession.calls.at(-1)).toEqual({
      method: 'BluetoothEmulation.disable',
    });
  });
});
