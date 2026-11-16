import {
  BluetoothCapabilityUnsupportedError,
  createBluetoothTimeline,
  normalizeBluetoothAddress,
  validatePeripheralDefinition,
  type BluetoothCapabilities,
} from '@gattlab/core';
import { describe, expect, it, vi } from 'vitest';

import {
  attachGattLabDiagnostics,
  GattLabDiagnosticBuffer,
  gattLabCapabilitiesAttachmentName,
  gattLabDevicesAttachmentName,
  gattLabDiagnosticsAttachmentName,
  gattLabSummaryAttachmentName,
} from '../src/diagnostics.js';
import { normalizeGattLabFixtureOptions } from '../src/options.js';

const validatedCapabilities: BluetoothCapabilities = Object.freeze({
  browserName: 'chromium',
  browserProduct: 'HeadlessChrome/159.0.8154.6',
  browserVersion: '159.0.8154.6',
  protocolVersion: '1.3',
  domains: Object.freeze({ bluetoothEmulation: true, deviceAccess: true }),
  operations: Object.freeze({
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
  }),
});

function playwrightEnvironment(playwrightVersion = '1.65.1') {
  return {
    playwrightVersion,
    headless: true as const,
    connection: 'launch' as const,
  };
}

function captureOneEvent(diagnostics: GattLabDiagnosticBuffer): void {
  const timeline = createBluetoothTimeline({
    limit: 2,
    clock: { now: () => 10 },
  });
  timeline.append({
    category: 'lifecycle',
    type: 'backend-start',
    status: 'succeeded',
  });
  diagnostics.captureTimeline('cdp-backend', timeline.snapshot());
  timeline.close();
}

function attachmentTarget(options: {
  readonly status?: 'passed' | 'failed';
  readonly expectedStatus: 'passed' | 'failed';
  readonly attach?: ReturnType<typeof vi.fn>;
}): {
  readonly status?: 'passed' | 'failed';
  readonly expectedStatus: 'passed' | 'failed';
  readonly attach: ReturnType<typeof vi.fn>;
  readonly annotations: TestAnnotation[];
} {
  const annotations: TestAnnotation[] = [];
  return {
    ...(options.status === undefined ? {} : { status: options.status }),
    expectedStatus: options.expectedStatus,
    attach: options.attach ?? vi.fn(async () => undefined),
    annotations,
  };
}

interface TestAnnotation {
  type: string;
  description?: string;
}

describe('GattLab diagnostic buffering', () => {
  it('retains frozen timeline and structured runtime-failure snapshots', () => {
    const diagnostics = new GattLabDiagnosticBuffer();
    captureOneEvent(diagnostics);
    diagnostics.captureRuntimeFailure(
      'runtime-start',
      new BluetoothCapabilityUnsupportedError('Unsupported browser.', {
        context: { actualBrowserName: 'webkit' },
      }),
    );

    const snapshot = diagnostics.snapshot();

    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.timelines)).toBe(true);
    expect(Object.isFrozen(snapshot.timelines[0]?.events)).toBe(true);
    expect(snapshot).toMatchObject({
      timelines: [
        {
          owner: 'cdp-backend',
          events: [{ category: 'lifecycle', type: 'backend-start' }],
        },
      ],
      runtimeFailures: [
        {
          stage: 'runtime-start',
          name: 'BluetoothCapabilityUnsupportedError',
          message: 'Unsupported browser.',
          code: 'BLUETOOTH_CAPABILITY_UNSUPPORTED',
          context: { actualBrowserName: 'webkit' },
        },
      ],
    });
  });

  it('attaches a buffered early-disposal snapshot after an unexpected outcome', async () => {
    const diagnostics = new GattLabDiagnosticBuffer();
    captureOneEvent(diagnostics);
    const target = attachmentTarget({
      status: 'failed',
      expectedStatus: 'passed',
    });

    await attachGattLabDiagnostics(diagnostics, target);

    expect(target.attach).toHaveBeenCalledTimes(2);
    const [name, attachment] = target.attach.mock.calls[0] ?? [];
    expect(name).toBe(gattLabDiagnosticsAttachmentName);
    expect(attachment).toMatchObject({ contentType: 'application/json' });
    expect(JSON.parse(String(attachment?.body))).toMatchObject({
      schemaVersion: 1,
      timelines: [{ owner: 'cdp-backend' }],
    });
    expect(target.attach.mock.calls[1]?.[0]).toBe(gattLabSummaryAttachmentName);
  });

  it.each([
    { status: 'passed', expectedStatus: 'passed' },
    { status: 'failed', expectedStatus: 'failed' },
  ] as const)(
    'does not retain ordinary captures for $status/$expectedStatus',
    async ({ status, expectedStatus }) => {
      const diagnostics = new GattLabDiagnosticBuffer();
      captureOneEvent(diagnostics);
      const target = attachmentTarget({ status, expectedStatus });

      await attachGattLabDiagnostics(diagnostics, target);

      expect(target.attach).not.toHaveBeenCalled();
    },
  );

  it('does not manufacture an empty artifact for an idle failed test', async () => {
    const diagnostics = new GattLabDiagnosticBuffer();
    const target = attachmentTarget({
      status: 'failed',
      expectedStatus: 'passed',
    });

    await attachGattLabDiagnostics(diagnostics, target);

    expect(target.attach).not.toHaveBeenCalled();
  });

  it('honors always and off retention without manufacturing idle artifacts', async () => {
    const always = new GattLabDiagnosticBuffer();
    always.configure(normalizeGattLabFixtureOptions({ artifacts: 'always' }));
    captureOneEvent(always);
    const passing = attachmentTarget({
      status: 'passed',
      expectedStatus: 'passed',
    });
    await attachGattLabDiagnostics(always, passing);
    expect(passing.attach).toHaveBeenCalledTimes(2);

    const off = new GattLabDiagnosticBuffer();
    off.configure(normalizeGattLabFixtureOptions({ artifacts: 'off' }));
    captureOneEvent(off);
    const failing = attachmentTarget({
      status: 'failed',
      expectedStatus: 'passed',
    });
    await attachGattLabDiagnostics(off, failing);
    expect(failing.attach).not.toHaveBeenCalled();

    const idle = new GattLabDiagnosticBuffer();
    idle.configure(normalizeGattLabFixtureOptions({ artifacts: 'always' }));
    const idleTarget = attachmentTarget({
      status: 'passed',
      expectedStatus: 'passed',
    });
    await attachGattLabDiagnostics(idle, idleTarget);
    expect(idleTarget.attach).not.toHaveBeenCalled();
  });

  it('bounds successful unverified retention to the compatibility evidence', async () => {
    const diagnostics = new GattLabDiagnosticBuffer(
      playwrightEnvironment('1.66.0'),
    );
    diagnostics.captureCapabilities({
      ...validatedCapabilities,
      browserProduct: 'HeadlessChrome/154.0.0.0',
      browserVersion: '154.0.0.0',
    });
    const target = attachmentTarget({
      status: 'passed',
      expectedStatus: 'passed',
    });

    await attachGattLabDiagnostics(diagnostics, target);

    expect(target.annotations).toEqual([
      expect.objectContaining({ type: 'gattlab-compatibility' }),
    ]);
    expect(target.attach.mock.calls.map(([name]) => name)).toEqual([
      gattLabCapabilitiesAttachmentName,
    ]);
    const capabilityBody = target.attach.mock.calls[0]?.[1]?.body;
    expect(JSON.parse(String(capabilityBody))).toMatchObject({
      schemaVersion: 1,
      compatibility: {
        status: 'unverified',
        mismatches: [
          'playwright-version',
          'browser-product',
          'browser-version',
        ],
      },
    });

    const failingTarget = attachmentTarget({
      status: 'failed',
      expectedStatus: 'passed',
    });
    await attachGattLabDiagnostics(diagnostics, failingTarget);
    expect(failingTarget.attach.mock.calls.map(([name]) => name)).toEqual([
      gattLabDiagnosticsAttachmentName,
      gattLabSummaryAttachmentName,
      gattLabCapabilitiesAttachmentName,
    ]);
  });

  it('marks the exact pinned headless baseline as validated', () => {
    const diagnostics = new GattLabDiagnosticBuffer(playwrightEnvironment());

    expect(
      diagnostics.captureCapabilities(validatedCapabilities),
    ).toMatchObject({
      status: 'validated',
      mismatches: [],
      validated: {
        headlessMode:
          'Playwright bundled Chromium headless shell with headless: true',
      },
    });
    expect(diagnostics.requiresFullRetention()).toBe(false);
  });

  it('uses the observed HeadlessChrome product when Playwright omits its default', () => {
    const diagnostics = new GattLabDiagnosticBuffer({
      playwrightVersion: '1.65.1',
      headless: 'unknown',
      connection: 'launch',
    });

    expect(
      diagnostics.captureCapabilities(validatedCapabilities),
    ).toMatchObject({
      status: 'validated',
      observed: { headless: true },
    });
  });

  it('does not validate headed, channel, custom, or connected executions', () => {
    const diagnostics = new GattLabDiagnosticBuffer({
      playwrightVersion: '1.65.1',
      headless: false,
      channel: 'chromium',
      executablePath: '/custom/chromium',
      connection: 'connect',
    });

    expect(
      diagnostics.captureCapabilities(validatedCapabilities),
    ).toMatchObject({
      status: 'unverified',
      mismatches: [
        'headless-mode',
        'browser-channel',
        'custom-executable',
        'remote-browser',
      ],
    });
  });

  it('redacts payloads by default and exposes only an explicit bounded preview', () => {
    const validation = validatePeripheralDefinition({
      address: '01:02:03:04:05:06',
      name: 'Private sensor',
      manufacturerData: [{ companyId: 1, data: [1, 2, 3, 4] }],
      services: [
        {
          uuid: '180f',
          characteristics: [
            {
              uuid: '2a19',
              properties: ['read'],
              initialValue: [10, 11, 12, 13],
            },
          ],
        },
      ],
    });
    expect(validation.success).toBe(true);
    if (!validation.success) return;

    const redacted = new GattLabDiagnosticBuffer();
    redacted.capturePeripheral(validation.value);
    expect(redacted.snapshot().devices[0]).toMatchObject({
      manufacturerData: [{ data: { byteLength: 4 } }],
      services: [
        {
          characteristics: [{ initialValue: { byteLength: 4 } }],
        },
      ],
    });
    expect(
      redacted.snapshot().devices[0]?.manufacturerData[0]?.data,
    ).not.toHaveProperty('previewHex');
    expect(Object.isFrozen(redacted.snapshot().devices)).toBe(true);
    expect(Object.isFrozen(redacted.snapshot().devices[0])).toBe(true);
    const redactedInitialValue =
      redacted.snapshot().devices[0]?.services[0]?.characteristics[0]
        ?.initialValue;
    expect(redactedInitialValue).toEqual({ byteLength: 4 });
    expect(Object.isFrozen(redactedInitialValue)).toBe(true);

    const truncated = new GattLabDiagnosticBuffer();
    truncated.configure(
      normalizeGattLabFixtureOptions({
        payloadLogging: { mode: 'truncated', maxBytes: 2 },
      }),
    );
    truncated.capturePeripheral(validation.value);
    expect(truncated.snapshot().devices[0]?.manufacturerData[0]?.data).toEqual({
      byteLength: 4,
      previewHex: '01 02',
      truncated: true,
    });
  });

  it('attaches an actionable summary and sanitized device model on failure', async () => {
    const validation = validatePeripheralDefinition({
      address: '01:02:03:04:05:06',
      name: 'Sensor',
      services: [{ uuid: '180f' }],
    });
    expect(validation.success).toBe(true);
    if (!validation.success) return;
    const diagnostics = new GattLabDiagnosticBuffer(playwrightEnvironment());
    captureOneEvent(diagnostics);
    diagnostics.captureCapabilities(validatedCapabilities);
    diagnostics.capturePeripheral(validation.value);
    diagnostics.captureRuntimeFailure(
      'runtime-start',
      new BluetoothCapabilityUnsupportedError('Use a secure page.'),
    );
    const target = attachmentTarget({
      status: 'failed',
      expectedStatus: 'passed',
    });

    await attachGattLabDiagnostics(diagnostics, target);

    expect(target.attach.mock.calls.map(([name]) => name)).toEqual([
      gattLabDiagnosticsAttachmentName,
      gattLabSummaryAttachmentName,
      gattLabDevicesAttachmentName,
      gattLabCapabilitiesAttachmentName,
    ]);
    const summary = String(target.attach.mock.calls[1]?.[1]?.body);
    expect(summary).toContain('BLUETOOTH_CAPABILITY_UNSUPPORTED');
    expect(summary).toContain('Use Chromium on HTTPS or localhost');
    expect(summary).toContain('Compatibility: validated');
  });

  it('keeps the last operation visible when teardown events follow it', async () => {
    let now = 0;
    const timeline = createBluetoothTimeline({
      limit: 10,
      clock: { now: () => now++ },
    });
    timeline.append({
      category: 'gatt',
      type: 'operation-pending',
      entity: {
        kind: 'peripheral',
        address: normalizeBluetoothAddress('01:02:03:04:05:06'),
      },
      status: 'pending',
    });
    for (let index = 0; index < 6; index += 1) {
      timeline.append({
        category: 'lifecycle',
        type: 'cleanup-step',
        status: 'succeeded',
      });
    }
    const diagnostics = new GattLabDiagnosticBuffer();
    diagnostics.captureTimeline('cdp-backend', timeline.snapshot());
    const target = attachmentTarget({
      status: 'failed',
      expectedStatus: 'passed',
    });

    await attachGattLabDiagnostics(diagnostics, target);

    const summary = String(target.attach.mock.calls[1]?.[1]?.body);
    expect(summary).toContain('gatt/operation-pending — pending');
    expect(summary).toContain('01:02:03:04:05:06');
    expect(summary).toContain('Inspect the last gatt/operation-pending event');
    expect(summary).not.toContain('lifecycle/cleanup-step');
  });

  it('retains preparation and teardown failures before status propagation', async () => {
    for (const stage of ['runtime-preparation', 'runtime-stop'] as const) {
      const diagnostics = new GattLabDiagnosticBuffer();
      diagnostics.captureRuntimeFailure(stage, new Error(`${stage} failed`));
      const target = attachmentTarget({ expectedStatus: 'passed' });

      await attachGattLabDiagnostics(diagnostics, target);

      expect(target.attach).toHaveBeenCalledTimes(2);
    }
  });

  it('does not retain a caught startup failure for a successful test', async () => {
    const diagnostics = new GattLabDiagnosticBuffer();
    diagnostics.captureRuntimeFailure(
      'runtime-start',
      new Error('caught startup failure'),
    );
    const target = attachmentTarget({
      status: 'passed',
      expectedStatus: 'passed',
    });

    await attachGattLabDiagnostics(diagnostics, target);

    expect(target.attach).not.toHaveBeenCalled();
  });

  it('does not replace a teardown failure when attachment rejects', async () => {
    const diagnostics = new GattLabDiagnosticBuffer();
    diagnostics.captureRuntimeFailure(
      'runtime-stop',
      new Error('primary teardown failure'),
    );
    const target = attachmentTarget({
      expectedStatus: 'passed',
      attach: vi.fn(async () => {
        throw new Error('attachment failed');
      }),
    });

    await expect(
      attachGattLabDiagnostics(diagnostics, target),
    ).resolves.toBeUndefined();
    expect(target.attach).toHaveBeenCalledOnce();
  });

  it('does not replace a test failure when diagnostic rendering rejects', async () => {
    const diagnostics = new GattLabDiagnosticBuffer();
    diagnostics.captureTimeline('cdp-backend', [
      {
        sequence: 1,
        monotonicMs: 1,
        elapsedMs: 0,
        category: 'diagnostic',
        type: 'invalid-test-event',
        data: { invalid: 1n },
      } as never,
    ]);
    const target = attachmentTarget({
      status: 'failed',
      expectedStatus: 'passed',
    });

    await expect(
      attachGattLabDiagnostics(diagnostics, target),
    ).resolves.toBeUndefined();
    expect(target.attach).not.toHaveBeenCalled();
  });

  it('does not let malformed diagnostic inputs replace runtime teardown', () => {
    const diagnostics = new GattLabDiagnosticBuffer();
    const events = new Proxy([], {
      get(target, property, receiver) {
        if (property === Symbol.iterator) throw new Error('hostile iterator');
        return Reflect.get(target, property, receiver);
      },
    });
    const cause = new Error('primary');
    Object.defineProperty(cause, 'message', {
      get() {
        throw new Error('hostile message');
      },
    });

    expect(() =>
      diagnostics.captureTimeline('cdp-backend', events as readonly never[]),
    ).not.toThrow();
    expect(() =>
      diagnostics.captureRuntimeFailure('runtime-stop', cause),
    ).not.toThrow();
    expect(diagnostics.snapshot()).toEqual({
      timelines: [],
      runtimeFailures: [],
      devices: [],
    });
  });
});
