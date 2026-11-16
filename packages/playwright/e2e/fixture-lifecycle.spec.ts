import {
  normalizeBluetoothAddress,
  validatePeripheralDefinition,
} from '@gattlab/core';
import type { Browser, Page } from '@playwright/test';

import { prepareGattLabRuntime } from '../src/runtime.js';
import { applicationServiceUuid } from './support/application-server.js';
import { expect, test } from './fixtures.js';

const peripheralAddress = normalizeBluetoothAddress('40:40:40:40:41:01');

interface ApplicationState {
  readonly outcome: 'idle' | 'pending' | 'selected' | 'cancelled';
  readonly errorName?: string;
}

async function readApplicationState(page: Page): Promise<ApplicationState> {
  return page.evaluate(() => {
    return (
      globalThis as unknown as {
        readonly fixtureState: ApplicationState;
      }
    ).fixtureState;
  });
}

test('prepares the project option on about:blank without runtime side effects', async ({
  page,
  _gattlabRuntime,
}) => {
  expect(page.url()).toBe('about:blank');
  expect(_gattlabRuntime.state).toBe('idle');
  expect(_gattlabRuntime.options).toEqual({
    centralState: 'powered-on',
    operationTimeoutMs: 6_101,
    promptTimeoutMs: 5_000,
    teardownTimeoutMs: 5_000,
    historyLimit: 1_000,
    operationHistoryLimit: 1_000,
    artifacts: 'retain-on-failure',
    payloadLogging: { mode: 'redacted' },
  });
});

test('captures real backend teardown in the test-scoped diagnostics buffer', async ({
  applicationUrl,
  page,
  _gattlabDiagnostics,
  _gattlabRuntime,
}) => {
  await page.goto(applicationUrl);
  const backend = await _gattlabRuntime.start();

  await _gattlabRuntime.stop();

  expect(backend.timeline.closed).toBe(true);
  const snapshot = _gattlabDiagnostics.snapshot();
  expect(snapshot.timelines).toHaveLength(1);
  expect(snapshot.timelines[0]?.owner).toBe('cdp-backend');
  expect(snapshot.timelines[0]?.events.length).toBeGreaterThan(0);
  expect(Object.isFrozen(snapshot.timelines[0]?.events)).toBe(true);
  expect(snapshot.capabilityDiagnostics).toMatchObject({
    capabilities: {
      browserProduct: 'HeadlessChrome/159.0.8154.6',
      browserVersion: '159.0.8154.6',
      protocolVersion: '1.3',
    },
    compatibility: { status: 'validated', mismatches: [] },
  });
  expect(snapshot.timelines[0]?.events).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        category: 'diagnostic',
        type: 'compatibility-baseline',
        data: expect.objectContaining({ status: 'validated' }),
      }),
    ]),
  );
});

test('captures production-backend startup unwind on an unsafe page', async ({
  page,
  _gattlabDiagnostics,
  _gattlabRuntime,
}) => {
  expect(page.url()).toBe('about:blank');

  await expect(_gattlabRuntime.start()).rejects.toMatchObject({
    code: 'BLUETOOTH_CAPABILITY_UNSUPPORTED',
  });

  expect(_gattlabRuntime.state).toBe('stopped');
  const snapshot = _gattlabDiagnostics.snapshot();
  expect(snapshot.timelines).toHaveLength(1);
  expect(snapshot.timelines[0]?.owner).toBe('cdp-backend');
  expect(snapshot.runtimeFailures).toEqual([
    expect.objectContaining({
      stage: 'runtime-start',
      code: 'BLUETOOTH_CAPABILITY_UNSUPPORTED',
    }),
  ]);
});

test.describe('test.use option path', () => {
  test.use({
    gattlab: {
      centralState: 'powered-off',
      historyLimit: 17,
      operationHistoryLimit: 19,
      artifacts: 'retain-on-failure',
      payloadLogging: { mode: 'redacted' },
    },
  });

  test('normalizes through the same immutable shape', ({ _gattlabRuntime }) => {
    expect(_gattlabRuntime.options).toEqual({
      centralState: 'powered-off',
      operationTimeoutMs: 5_000,
      promptTimeoutMs: 5_000,
      teardownTimeoutMs: 5_000,
      historyLimit: 17,
      operationHistoryLimit: 19,
      artifacts: 'retain-on-failure',
      payloadLogging: { mode: 'redacted' },
    });
    expect(Object.isFrozen(_gattlabRuntime.options)).toBe(true);
  });
});

test('rejects a second context in the same Browser without disturbing the first runtime', async ({
  applicationUrl,
  browser,
  browserName,
  gattlab,
  page,
  _gattlabRuntime,
}) => {
  await page.goto(applicationUrl);
  const firstBackend = await _gattlabRuntime.start();
  expect(firstBackend.capabilities.browserName).toBe('chromium');

  const secondContext = await browser.newContext();
  try {
    const secondPage = await secondContext.newPage();
    await secondPage.goto(applicationUrl);
    const competitor = prepareGattLabRuntime({
      browserName,
      browser,
      context: secondContext,
      page: secondPage,
      options: gattlab,
    });

    await expect(competitor.start()).rejects.toMatchObject({
      code: 'BLUETOOTH_LAB_ALREADY_ACTIVE',
      context: {
        leaseScope: 'browser-process',
        remediation: 'use-separate-browser-process',
        detection: 'in-process-lease',
      },
    });
    await competitor.stop();
    expect(firstBackend.timeline.closed).toBe(false);
  } finally {
    await secondContext.close();
  }
});

test.describe.serial('sequential browser-process lease', () => {
  let firstBrowser: Browser | undefined;

  test('registers one service-backed chooser candidate', async ({
    applicationUrl,
    browser,
    page,
    _gattlabRuntime,
  }) => {
    firstBrowser = browser;
    await page.goto(applicationUrl);
    const backend = await _gattlabRuntime.start();
    const validation = validatePeripheralDefinition({
      address: peripheralAddress,
      name: 'Fixture sensor',
      services: [{ uuid: applicationServiceUuid, characteristics: [] }],
    });
    if (!validation.success) {
      throw new Error('Expected a valid service-backed fixture peripheral.');
    }
    await backend.addPeripheral(validation.value);

    const promptPromise = backend.waitForDevicePrompt();
    await page.getByRole('button', { name: 'Choose fixture sensor' }).click();
    const prompt = await promptPromise;
    await expect
      .poll(() => prompt.devices)
      .toEqual([{ id: peripheralAddress, name: '' }]);
    await prompt.cancel();
    await expect
      .poll(() => readApplicationState(page))
      .toEqual({
        outcome: 'cancelled',
        errorName: 'NotFoundError',
      });
  });

  test('reuses the Browser after teardown with no leaked candidates', async ({
    applicationUrl,
    browser,
    page,
    _gattlabRuntime,
  }) => {
    expect(browser).toBe(firstBrowser);
    await page.goto(applicationUrl);
    const backend = await _gattlabRuntime.start();

    const promptPromise = backend.waitForDevicePrompt();
    await page.getByRole('button', { name: 'Choose fixture sensor' }).click();
    const prompt = await promptPromise;
    expect(prompt.devices).toEqual([]);
    await prompt.cancel();
    await expect
      .poll(() => readApplicationState(page))
      .toEqual({
        outcome: 'cancelled',
        errorName: 'NotFoundError',
      });
  });
});
