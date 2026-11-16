import {
  GattLabError,
  type BluetoothCapabilities,
  type BluetoothTimelineEvent,
  type DiagnosticValue,
  type GattLabErrorCode,
  type NormalizedAdvertisement,
  type NormalizedCharacteristic,
  type NormalizedDescriptor,
  type NormalizedManufacturerDataEntry,
  type NormalizedPeripheral,
  type NormalizedService,
} from '@gattlab/core';
import type { TestInfo } from '@playwright/test';

import {
  snapshotCapabilityDiagnostics,
  type GattLabCapabilityDiagnostics,
  type GattLabCompatibilityAssessment,
  type GattLabPlaywrightEnvironment,
} from './compatibility.js';
import type {
  NormalizedGattLabFixtureOptions,
  NormalizedGattLabPayloadLoggingOptions,
} from './options.js';

export const gattLabDiagnosticsAttachmentName =
  'gattlab-diagnostics.json' as const;
export const gattLabSummaryAttachmentName = 'gattlab-summary.md' as const;
export const gattLabDevicesAttachmentName = 'gattlab-devices.json' as const;
export const gattLabCapabilitiesAttachmentName =
  'gattlab-capabilities.json' as const;

export type GattLabTimelineOwner = 'cdp-backend' | 'playwright-runtime';

export type GattLabRuntimeFailureStage =
  'runtime-preparation' | 'runtime-start' | 'runtime-stop';

export interface GattLabTimelineCapture {
  readonly owner: GattLabTimelineOwner;
  readonly events: readonly BluetoothTimelineEvent[];
}

export interface GattLabRuntimeFailure {
  readonly stage: GattLabRuntimeFailureStage;
  readonly name: string;
  readonly message: string;
  readonly code?: GattLabErrorCode;
  readonly context?: Readonly<Record<string, DiagnosticValue>>;
}

export interface GattLabPayloadDiagnostic {
  readonly byteLength: number;
  readonly previewHex?: string;
  readonly truncated?: boolean;
}

export interface GattLabManufacturerDataDiagnostic {
  readonly companyId: number;
  readonly data: GattLabPayloadDiagnostic;
}

export interface GattLabDescriptorDiagnostic {
  readonly uuid: string;
  readonly initialValue?: GattLabPayloadDiagnostic;
}

export interface GattLabCharacteristicDiagnostic {
  readonly uuid: string;
  readonly properties: readonly string[];
  readonly initialValue?: GattLabPayloadDiagnostic;
  readonly descriptors: readonly GattLabDescriptorDiagnostic[];
}

export interface GattLabServiceDiagnostic {
  readonly uuid: string;
  readonly isPrimary: boolean;
  readonly characteristics: readonly GattLabCharacteristicDiagnostic[];
}

export interface GattLabAdvertisementDiagnostic {
  readonly rssi: number;
  readonly name: string;
  readonly serviceUuids: readonly string[];
  readonly appearance?: number;
  readonly txPower?: number;
  readonly manufacturerData: readonly GattLabManufacturerDataDiagnostic[];
}

export interface GattLabPeripheralDiagnostic {
  readonly address: string;
  readonly name: string;
  readonly knownServiceUuids: readonly string[];
  readonly manufacturerData: readonly GattLabManufacturerDataDiagnostic[];
  readonly advertisement?: GattLabAdvertisementDiagnostic;
  readonly services: readonly GattLabServiceDiagnostic[];
  readonly defaults: Readonly<{ connection: string; discovery: string }>;
}

export interface GattLabDiagnosticSnapshot {
  readonly timelines: readonly GattLabTimelineCapture[];
  readonly runtimeFailures: readonly GattLabRuntimeFailure[];
  readonly devices: readonly GattLabPeripheralDiagnostic[];
  readonly capabilityDiagnostics?: GattLabCapabilityDiagnostics;
}

export interface GattLabDiagnosticDocument {
  readonly schemaVersion: 1;
  readonly timelines: readonly GattLabTimelineCapture[];
  readonly runtimeFailures: readonly GattLabRuntimeFailure[];
}

export interface GattLabDevicesDocument {
  readonly schemaVersion: 1;
  readonly payloadLogging: NormalizedGattLabPayloadLoggingOptions;
  readonly devices: readonly GattLabPeripheralDiagnostic[];
}

export interface GattLabCapabilitiesDocument {
  readonly schemaVersion: 1;
  readonly capabilities: BluetoothCapabilities;
  readonly compatibility: GattLabCompatibilityAssessment;
}

interface DiagnosticAttachmentTarget {
  readonly status?: TestInfo['status'];
  readonly expectedStatus: TestInfo['expectedStatus'];
  readonly annotations?: TestInfo['annotations'];
  attach(
    name: string,
    options: { readonly body: string; readonly contentType: string },
  ): Promise<void>;
}

const defaultDiagnosticOptions: Pick<
  NormalizedGattLabFixtureOptions,
  'artifacts' | 'payloadLogging'
> = Object.freeze({
  artifacts: 'retain-on-failure',
  payloadLogging: Object.freeze({ mode: 'redacted' }),
});

/** Collects bounded runtime evidence and materializes policy-selected artifacts. */
export class GattLabDiagnosticBuffer {
  readonly #playwrightEnvironment: GattLabPlaywrightEnvironment;
  readonly #timelines: GattLabTimelineCapture[] = [];
  readonly #runtimeFailures: GattLabRuntimeFailure[] = [];
  readonly #devices = new Map<string, GattLabPeripheralDiagnostic>();
  #capabilityDiagnostics: GattLabCapabilityDiagnostics | undefined;
  #options = defaultDiagnosticOptions;

  constructor(
    playwrightEnvironment: GattLabPlaywrightEnvironment = {
      playwrightVersion: 'unknown',
      headless: 'unknown',
      connection: 'unknown',
    },
  ) {
    this.#playwrightEnvironment = Object.freeze({ ...playwrightEnvironment });
  }

  configure(options: NormalizedGattLabFixtureOptions): void {
    this.#options = Object.freeze({
      artifacts: options.artifacts,
      payloadLogging: options.payloadLogging,
    });
  }

  captureTimeline(
    owner: GattLabTimelineOwner,
    events: readonly BluetoothTimelineEvent[],
  ): void {
    try {
      this.#timelines.push(
        Object.freeze({ owner, events: Object.freeze([...events]) }),
      );
    } catch {
      // Diagnostic capture is best effort and never changes runtime teardown.
    }
  }

  captureRuntimeFailure(
    stage: GattLabRuntimeFailureStage,
    cause: unknown,
  ): void {
    try {
      this.#runtimeFailures.push(snapshotRuntimeFailure(stage, cause));
    } catch {
      // A hostile thrown value must not replace the original runtime failure.
    }
  }

  captureCapabilities(
    capabilities: BluetoothCapabilities,
  ): GattLabCompatibilityAssessment | undefined {
    try {
      this.#capabilityDiagnostics = snapshotCapabilityDiagnostics(
        this.#playwrightEnvironment,
        capabilities,
      );
      return this.#capabilityDiagnostics.compatibility;
    } catch {
      return undefined;
    }
  }

  capturePeripheral(peripheral: NormalizedPeripheral): void {
    try {
      this.#devices.set(
        peripheral.address,
        snapshotPeripheral(peripheral, this.#options.payloadLogging),
      );
    } catch {
      // Device diagnostics must never change successful registration.
    }
  }

  snapshot(): GattLabDiagnosticSnapshot {
    return Object.freeze({
      timelines: Object.freeze([...this.#timelines]),
      runtimeFailures: Object.freeze([...this.#runtimeFailures]),
      devices: Object.freeze([...this.#devices.values()]),
      ...(this.#capabilityDiagnostics === undefined
        ? {}
        : { capabilityDiagnostics: this.#capabilityDiagnostics }),
    });
  }

  artifactRetention(): NormalizedGattLabFixtureOptions['artifacts'] {
    return this.#options.artifacts;
  }

  payloadLogging(): NormalizedGattLabPayloadLoggingOptions {
    return this.#options.payloadLogging;
  }

  requiresFullRetention(): boolean {
    return this.#runtimeFailures.some(
      ({ stage }) =>
        stage === 'runtime-preparation' || stage === 'runtime-stop',
    );
  }
}

/** @internal */
export async function attachGattLabDiagnostics(
  diagnostics: GattLabDiagnosticBuffer,
  testInfo: DiagnosticAttachmentTarget,
): Promise<void> {
  const snapshot = diagnostics.snapshot();
  reportCompatibility(snapshot.capabilityDiagnostics, testInfo);

  const hasDiagnostics =
    snapshot.timelines.length > 0 ||
    snapshot.runtimeFailures.length > 0 ||
    snapshot.devices.length > 0 ||
    snapshot.capabilityDiagnostics !== undefined;
  if (!hasDiagnostics || diagnostics.artifactRetention() === 'off') return;

  const failedUnexpectedly =
    testInfo.status !== undefined &&
    testInfo.status !== testInfo.expectedStatus;
  const retainFullSet =
    diagnostics.artifactRetention() === 'always' ||
    failedUnexpectedly ||
    diagnostics.requiresFullRetention();
  const retainCompatibilityOnly =
    snapshot.capabilityDiagnostics?.compatibility.status === 'unverified';
  if (!retainFullSet && !retainCompatibilityOnly) return;

  try {
    const attachments: (readonly [
      string,
      Readonly<{ body: string; contentType: string }>,
    ])[] = [];
    if (retainFullSet) {
      const document: GattLabDiagnosticDocument = Object.freeze({
        schemaVersion: 1,
        timelines: snapshot.timelines,
        runtimeFailures: snapshot.runtimeFailures,
      });
      attachments.push(
        [
          gattLabDiagnosticsAttachmentName,
          {
            body: `${JSON.stringify(document, undefined, 2)}\n`,
            contentType: 'application/json',
          },
        ],
        [
          gattLabSummaryAttachmentName,
          {
            body: renderGattLabSummary(snapshot, testInfo),
            contentType: 'text/markdown',
          },
        ],
      );
    }
    if (retainFullSet && snapshot.devices.length > 0) {
      const devices: GattLabDevicesDocument = Object.freeze({
        schemaVersion: 1,
        payloadLogging: diagnostics.payloadLogging(),
        devices: snapshot.devices,
      });
      attachments.push([
        gattLabDevicesAttachmentName,
        {
          body: `${JSON.stringify(devices, undefined, 2)}\n`,
          contentType: 'application/json',
        },
      ]);
    }
    if (snapshot.capabilityDiagnostics !== undefined) {
      const capabilities: GattLabCapabilitiesDocument = Object.freeze({
        schemaVersion: 1,
        ...snapshot.capabilityDiagnostics,
      });
      attachments.push([
        gattLabCapabilitiesAttachmentName,
        {
          body: `${JSON.stringify(capabilities, undefined, 2)}\n`,
          contentType: 'application/json',
        },
      ]);
    }

    for (const [name, attachment] of attachments) {
      await testInfo.attach(name, attachment);
    }
  } catch {
    // A diagnostics failure must not replace the failure selecting retention.
  }
}

function reportCompatibility(
  capabilityDiagnostics: GattLabCapabilityDiagnostics | undefined,
  testInfo: DiagnosticAttachmentTarget,
): void {
  const assessment = capabilityDiagnostics?.compatibility;
  if (
    assessment?.status !== 'unverified' ||
    testInfo.annotations === undefined
  ) {
    return;
  }
  try {
    testInfo.annotations.push({
      type: 'gattlab-compatibility',
      description: `Unverified Playwright/Chromium baseline (${assessment.mismatches.join(', ')}).`,
    });
  } catch {
    // Reporter annotations are best effort like diagnostic attachments.
  }
}

function renderGattLabSummary(
  snapshot: GattLabDiagnosticSnapshot,
  testInfo: Pick<DiagnosticAttachmentTarget, 'status' | 'expectedStatus'>,
): string {
  const lines = [
    '# GattLab diagnostic summary',
    '',
    `- Test outcome: ${inline(testInfo.status ?? 'unknown')} (expected ${inline(testInfo.expectedStatus)})`,
  ];
  const compatibility = snapshot.capabilityDiagnostics?.compatibility;
  if (compatibility !== undefined) {
    lines.push(
      `- Compatibility: ${compatibility.status}`,
      `- Observed: Playwright ${inline(compatibility.observed.playwrightVersion)}, ${inline(compatibility.observed.browserProduct)}, CDP ${inline(compatibility.observed.protocolVersion ?? 'unknown')}`,
      `- Browser mode: headless=${String(compatibility.observed.headless)}, ${compatibility.observed.connection}${compatibility.observed.channel === undefined ? '' : `, channel=${inline(compatibility.observed.channel)}`}${compatibility.observed.customExecutable ? ', custom executable' : ''}`,
      `- Validated: Playwright ${compatibility.validated.playwrightVersion}, ${compatibility.validated.browserProduct}, CDP ${compatibility.validated.protocolVersion}`,
    );
  }
  lines.push(`- Virtual peripherals: ${String(snapshot.devices.length)}`);

  lines.push('', '## Runtime failures', '');
  if (snapshot.runtimeFailures.length === 0) {
    lines.push('None captured.');
  } else {
    for (const failure of snapshot.runtimeFailures) {
      lines.push(
        `- ${inline(failure.stage)}: ${inline(failure.code ?? failure.name)} — ${inline(failure.message)}`,
      );
    }
  }

  const allEvents = snapshot.timelines.flatMap(({ owner, events }) =>
    events.map((event) => ({ owner, event })),
  );
  const operationEvents = allEvents.filter(
    ({ event }) => event.category !== 'lifecycle',
  );
  const recentEvents = (
    operationEvents.length === 0 ? allEvents : operationEvents
  ).slice(-5);
  lines.push('', '## Recent Bluetooth events', '');
  if (recentEvents.length === 0) {
    lines.push('None captured.');
  } else {
    for (const { owner, event } of recentEvents) {
      lines.push(
        `- ${inline(owner)} #${String(event.sequence)}: ${inline(event.category)}/${inline(event.type)}${event.status === undefined ? '' : ` — ${inline(event.status)}`}${formatEntity(event)}`,
      );
    }
  }

  lines.push('', '## Troubleshooting hints', '');
  for (const hint of troubleshootingHints(snapshot)) lines.push(`- ${hint}`);
  return `${lines.join('\n')}\n`;
}

function troubleshootingHints(
  snapshot: GattLabDiagnosticSnapshot,
): readonly string[] {
  const hints: string[] = [];
  const failures = snapshot.runtimeFailures;
  if (failures.some(({ code }) => code === 'BLUETOOTH_TIMEOUT')) {
    hints.push(
      'Arm chooser or write waits before the application action, then inspect the last pending operation and its identifiers.',
    );
  }
  if (
    failures.some(({ code }) => code === 'BLUETOOTH_CAPABILITY_UNSUPPORTED')
  ) {
    hints.push(
      'Use Chromium on HTTPS or localhost; on Linux also enable `--enable-features=WebBluetooth`, then compare the capability artifact with the validated baseline.',
    );
  }
  if (snapshot.capabilityDiagnostics?.compatibility.status === 'unverified') {
    hints.push(
      `Reproduce on ${snapshot.capabilityDiagnostics.compatibility.validated.browserProduct} with Playwright ${snapshot.capabilityDiagnostics.compatibility.validated.playwrightVersion} before reporting a GattLab regression.`,
    );
  }
  const allEvents = snapshot.timelines.flatMap(({ events }) => events);
  const lastEvent =
    allEvents.findLast(
      ({ category, status }) =>
        category !== 'lifecycle' &&
        (status === 'pending' || status === 'timed-out' || status === 'failed'),
    ) ?? allEvents.findLast(({ category }) => category !== 'lifecycle');
  if (
    lastEvent?.status === 'pending' ||
    lastEvent?.status === 'requested' ||
    lastEvent?.status === 'timed-out'
  ) {
    hints.push(
      `Inspect the last ${inline(lastEvent.category)}/${inline(lastEvent.type)} event and verify the scripted response targets the same peripheral and UUID path.`,
    );
  }
  if (hints.length === 0) {
    hints.push(
      'Compare the final application action with the recent Bluetooth events; the timeline shows what Chromium requested and what GattLab completed.',
    );
  }
  return Object.freeze(hints);
}

function formatEntity(event: BluetoothTimelineEvent): string {
  const entity = event.entity;
  if (entity === undefined) return '';
  const identifiers: string[] = [entity.address];
  if ('serviceUuid' in entity) identifiers.push(entity.serviceUuid);
  if ('characteristicUuid' in entity) {
    identifiers.push(entity.characteristicUuid);
  }
  if ('descriptorUuid' in entity) identifiers.push(entity.descriptorUuid);
  return ` (${identifiers.map(inline).join(' / ')})`;
}

function inline(value: string): string {
  return value.replaceAll('`', '\\`').replaceAll(/\s+/g, ' ').trim();
}

function snapshotPeripheral(
  peripheral: NormalizedPeripheral,
  policy: NormalizedGattLabPayloadLoggingOptions,
): GattLabPeripheralDiagnostic {
  return Object.freeze({
    address: peripheral.address,
    name: peripheral.name,
    knownServiceUuids: Object.freeze([...peripheral.knownServiceUuids]),
    manufacturerData: snapshotManufacturerData(
      peripheral.manufacturerData,
      policy,
    ),
    ...(peripheral.advertisement === undefined
      ? {}
      : {
          advertisement: snapshotAdvertisement(
            peripheral.advertisement,
            policy,
          ),
        }),
    services: Object.freeze(
      peripheral.services.map((service) => snapshotService(service, policy)),
    ),
    defaults: Object.freeze({ ...peripheral.defaults }),
  });
}

function snapshotAdvertisement(
  advertisement: NormalizedAdvertisement,
  policy: NormalizedGattLabPayloadLoggingOptions,
): GattLabAdvertisementDiagnostic {
  return Object.freeze({
    rssi: advertisement.rssi,
    name: advertisement.name,
    serviceUuids: Object.freeze([...advertisement.serviceUuids]),
    ...(advertisement.appearance === undefined
      ? {}
      : { appearance: advertisement.appearance }),
    ...(advertisement.txPower === undefined
      ? {}
      : { txPower: advertisement.txPower }),
    manufacturerData: snapshotManufacturerData(
      advertisement.manufacturerData,
      policy,
    ),
  });
}

function snapshotManufacturerData(
  entries: readonly NormalizedManufacturerDataEntry[],
  policy: NormalizedGattLabPayloadLoggingOptions,
): readonly GattLabManufacturerDataDiagnostic[] {
  return Object.freeze(
    entries.map((entry) =>
      Object.freeze({
        companyId: entry.companyId,
        data: snapshotPayload(entry.data, policy),
      }),
    ),
  );
}

function snapshotService(
  service: NormalizedService,
  policy: NormalizedGattLabPayloadLoggingOptions,
): GattLabServiceDiagnostic {
  return Object.freeze({
    uuid: service.uuid,
    isPrimary: service.isPrimary,
    characteristics: Object.freeze(
      service.characteristics.map((characteristic) =>
        snapshotCharacteristic(characteristic, policy),
      ),
    ),
  });
}

function snapshotCharacteristic(
  characteristic: NormalizedCharacteristic,
  policy: NormalizedGattLabPayloadLoggingOptions,
): GattLabCharacteristicDiagnostic {
  return Object.freeze({
    uuid: characteristic.uuid,
    properties: Object.freeze([...characteristic.properties]),
    ...(characteristic.initialValue === undefined
      ? {}
      : { initialValue: snapshotPayload(characteristic.initialValue, policy) }),
    descriptors: Object.freeze(
      characteristic.descriptors.map((descriptor) =>
        snapshotDescriptor(descriptor, policy),
      ),
    ),
  });
}

function snapshotDescriptor(
  descriptor: NormalizedDescriptor,
  policy: NormalizedGattLabPayloadLoggingOptions,
): GattLabDescriptorDiagnostic {
  return Object.freeze({
    uuid: descriptor.uuid,
    ...(descriptor.initialValue === undefined
      ? {}
      : { initialValue: snapshotPayload(descriptor.initialValue, policy) }),
  });
}

function snapshotPayload(
  payload: Uint8Array,
  policy: NormalizedGattLabPayloadLoggingOptions,
): GattLabPayloadDiagnostic {
  if (policy.mode === 'redacted') {
    return Object.freeze({ byteLength: payload.byteLength });
  }
  const preview = payload.subarray(0, policy.maxBytes);
  return Object.freeze({
    byteLength: payload.byteLength,
    previewHex: [...preview]
      .map((value) => value.toString(16).padStart(2, '0'))
      .join(' '),
    truncated: payload.byteLength > preview.byteLength,
  });
}

function snapshotRuntimeFailure(
  stage: GattLabRuntimeFailureStage,
  cause: unknown,
): GattLabRuntimeFailure {
  if (cause instanceof GattLabError) {
    return Object.freeze({
      stage,
      name: cause.name,
      message: cause.message,
      code: cause.code,
      context: cause.context,
    });
  }
  if (cause instanceof Error) {
    return Object.freeze({
      stage,
      name: cause.name,
      message: cause.message,
    });
  }
  return Object.freeze({
    stage,
    name: 'NonErrorFailure',
    message: 'A non-Error value was thrown.',
  });
}
