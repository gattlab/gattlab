import {
  test as playwrightTest,
  type PlaywrightTestArgs,
  type PlaywrightTestOptions,
  type PlaywrightWorkerArgs,
  type PlaywrightWorkerOptions,
  type TestType,
} from '@playwright/test';

import type { GattLabFixtureOptions } from './options.js';
import { BluetoothLab, createBluetoothLab } from './bluetooth-lab.js';
import {
  attachGattLabDiagnostics,
  GattLabDiagnosticBuffer,
} from './diagnostics.js';
import {
  prepareGattLabRuntime,
  type GattLabRuntimeController,
} from './runtime.js';

export interface GattLabOptionFixtures {
  readonly gattlab: GattLabFixtureOptions;
}

export interface GattLabInternalFixtures {
  readonly _gattlabDiagnostics: GattLabDiagnosticBuffer;
  readonly _gattlabRuntime: GattLabRuntimeController;
}

export interface GattLabFixtures {
  readonly bluetooth: BluetoothLab;
}

export const gattLabBaseTest: TestType<
  PlaywrightTestArgs &
    PlaywrightTestOptions &
    GattLabOptionFixtures &
    GattLabInternalFixtures,
  PlaywrightWorkerArgs & PlaywrightWorkerOptions
> = playwrightTest.extend<GattLabOptionFixtures & GattLabInternalFixtures>({
  gattlab: [{}, { option: true }],
  _gattlabDiagnostics: async (
    { headless, channel, launchOptions, connectOptions },
    use,
    testInfo,
  ): Promise<void> => {
    const diagnostics = new GattLabDiagnosticBuffer({
      playwrightVersion: testInfo.config.version,
      headless,
      ...(channel === undefined ? {} : { channel }),
      ...(launchOptions.executablePath === undefined
        ? {}
        : { executablePath: launchOptions.executablePath }),
      connection: connectOptions === undefined ? 'launch' : 'connect',
    });
    try {
      await use(diagnostics);
    } finally {
      await attachGattLabDiagnostics(diagnostics, testInfo);
    }
  },
  _gattlabRuntime: async (
    { browserName, browser, context, page, gattlab, _gattlabDiagnostics },
    use,
  ): Promise<void> => {
    let runtime: GattLabRuntimeController;
    try {
      runtime = prepareGattLabRuntime({
        browserName,
        browser,
        context,
        page,
        options: gattlab,
        diagnostics: _gattlabDiagnostics,
      });
    } catch (cause) {
      _gattlabDiagnostics.captureRuntimeFailure('runtime-preparation', cause);
      throw cause;
    }
    try {
      await use(runtime);
    } finally {
      if (runtime.state !== 'stopped') await runtime.stop();
    }
  },
});

const extendedGattLabTest = gattLabBaseTest.extend<GattLabFixtures>({
  bluetooth: async ({ _gattlabRuntime }, use): Promise<void> => {
    const bluetooth = createBluetoothLab(_gattlabRuntime);
    try {
      await use(bluetooth);
    } finally {
      await bluetooth.dispose();
    }
  },
});

export const test: TestType<
  PlaywrightTestArgs &
    PlaywrightTestOptions &
    GattLabOptionFixtures &
    GattLabFixtures,
  PlaywrightWorkerArgs & PlaywrightWorkerOptions
> = extendedGattLabTest;
