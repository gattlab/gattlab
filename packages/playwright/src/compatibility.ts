import {
  snapshotBluetoothCapabilities,
  type BluetoothCapabilities,
} from '@gattlab/core';

export const validatedPlaywrightVersion = '1.65.1' as const;
export const validatedBrowserProduct = 'HeadlessChrome/159.0.8154.6' as const;
export const validatedBrowserVersion = '159.0.8154.6' as const;
export const validatedProtocolVersion = '1.3' as const;
export const validatedHeadlessMode =
  'Playwright bundled Chromium headless shell with headless: true' as const;

export type GattLabCompatibilityStatus = 'validated' | 'unverified';

export type GattLabCompatibilityMismatch =
  | 'playwright-version'
  | 'headless-mode'
  | 'browser-channel'
  | 'custom-executable'
  | 'remote-browser'
  | 'browser-product'
  | 'browser-version'
  | 'protocol-version';

export interface GattLabCompatibilityAssessment {
  readonly status: GattLabCompatibilityStatus;
  readonly mismatches: readonly GattLabCompatibilityMismatch[];
  readonly observed: Readonly<{
    playwrightVersion: string;
    headless: boolean | 'unknown';
    channel?: string;
    customExecutable: boolean;
    connection: 'launch' | 'connect' | 'unknown';
    browserProduct: string;
    browserVersion: string;
    protocolVersion?: string;
  }>;
  readonly validated: Readonly<{
    playwrightVersion: typeof validatedPlaywrightVersion;
    browserProduct: typeof validatedBrowserProduct;
    browserVersion: typeof validatedBrowserVersion;
    protocolVersion: typeof validatedProtocolVersion;
    headlessMode: typeof validatedHeadlessMode;
  }>;
}

export interface GattLabPlaywrightEnvironment {
  readonly playwrightVersion: string;
  readonly headless: boolean | 'unknown';
  readonly channel?: string;
  readonly executablePath?: string;
  readonly connection: 'launch' | 'connect' | 'unknown';
}

export interface GattLabCapabilityDiagnostics {
  readonly capabilities: BluetoothCapabilities;
  readonly compatibility: GattLabCompatibilityAssessment;
}

/** Classifies a capable runtime as validated or unverified against the baseline. */
export function assessGattLabCompatibility(
  environment: GattLabPlaywrightEnvironment,
  capabilities: BluetoothCapabilities,
): GattLabCompatibilityAssessment {
  const mismatches: GattLabCompatibilityMismatch[] = [];
  const observedHeadless =
    environment.headless === 'unknown' &&
    capabilities.browserProduct.startsWith('HeadlessChrome/')
      ? true
      : environment.headless;
  if (environment.playwrightVersion !== validatedPlaywrightVersion) {
    mismatches.push('playwright-version');
  }
  if (observedHeadless !== true) mismatches.push('headless-mode');
  if (environment.channel !== undefined) mismatches.push('browser-channel');
  if (environment.executablePath !== undefined) {
    mismatches.push('custom-executable');
  }
  if (environment.connection !== 'launch') mismatches.push('remote-browser');
  if (capabilities.browserProduct !== validatedBrowserProduct) {
    mismatches.push('browser-product');
  }
  if (capabilities.browserVersion !== validatedBrowserVersion) {
    mismatches.push('browser-version');
  }
  if (capabilities.protocolVersion !== validatedProtocolVersion) {
    mismatches.push('protocol-version');
  }

  return Object.freeze({
    status: mismatches.length === 0 ? 'validated' : 'unverified',
    mismatches: Object.freeze(mismatches),
    observed: Object.freeze({
      playwrightVersion: environment.playwrightVersion,
      headless: observedHeadless,
      ...(environment.channel === undefined
        ? {}
        : { channel: environment.channel }),
      customExecutable: environment.executablePath !== undefined,
      connection: environment.connection,
      browserProduct: capabilities.browserProduct,
      browserVersion: capabilities.browserVersion,
      ...(capabilities.protocolVersion === undefined
        ? {}
        : { protocolVersion: capabilities.protocolVersion }),
    }),
    validated: Object.freeze({
      playwrightVersion: validatedPlaywrightVersion,
      browserProduct: validatedBrowserProduct,
      browserVersion: validatedBrowserVersion,
      protocolVersion: validatedProtocolVersion,
      headlessMode: validatedHeadlessMode,
    }),
  });
}

/** Freezes capability and compatibility evidence for diagnostics. */
export function snapshotCapabilityDiagnostics(
  environment: GattLabPlaywrightEnvironment,
  capabilities: BluetoothCapabilities,
): GattLabCapabilityDiagnostics {
  return Object.freeze({
    capabilities: snapshotBluetoothCapabilities(capabilities),
    compatibility: assessGattLabCompatibility(environment, capabilities),
  });
}
