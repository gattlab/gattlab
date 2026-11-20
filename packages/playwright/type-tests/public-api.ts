import {
  BluetoothLab,
  bytes,
  expect,
  test,
  type GattLabFixtureOptions,
  type HeldConnection,
} from '../src/index.js';

export const defaultOptions = {} satisfies GattLabFixtureOptions;

export const configuredOptions = {
  centralState: 'powered-on',
  operationTimeoutMs: 5_000,
  promptTimeoutMs: 5_000,
  teardownTimeoutMs: 5_000,
  historyLimit: 1_000,
  operationHistoryLimit: 1_000,
  artifacts: 'retain-on-failure',
  payloadLogging: { mode: 'truncated', maxBytes: 16 },
} satisfies GattLabFixtureOptions;

export function readOnlyOptions(options: GattLabFixtureOptions): void {
  // @ts-expect-error Public configuration is immutable to consumers.
  options.historyLimit = 2;
  // @ts-expect-error Handle-history configuration is immutable to consumers.
  options.operationHistoryLimit = 2;
  // @ts-expect-error Artifact configuration is immutable to consumers.
  options.artifacts = 'off';
}

export const rejectedState = {
  // @ts-expect-error Fixture central state uses the closed core union.
  centralState: 'sleeping',
} satisfies GattLabFixtureOptions;

export const rejectedPayloadLogging = {
  payloadLogging: {
    mode: 'redacted',
    // @ts-expect-error Redacted payload policy cannot accept a preview length.
    maxBytes: 1,
  },
} satisfies GattLabFixtureOptions;

export const bytePayload = bytes([0, 127, 255]);

test.use({ gattlab: configuredOptions });

test('public fixture contract', async ({ page, bluetooth }) => {
  await page.goto('https://example.test/');
  await bluetooth.adapter.setState('powered-on');
  const prompt = await bluetooth.waitForDevicePrompt();
  expect(prompt.devices).toEqual([]);
  await prompt.cancel();
  await bluetooth.dispose();

  // @ts-expect-error Explicit startup is not public.
  await bluetooth.start();
});

test('public peripheral read contract', async ({ page, bluetooth }) => {
  await page.goto('https://example.test/');
  const sensor = await bluetooth.createPeripheral({
    address: '09:09:09:09:09:09',
    name: 'Battery Sensor',
    services: [
      {
        uuid: '180f',
        characteristics: [{ uuid: '2a19', properties: ['read'] }],
      },
    ],
  });
  const batteryLevel = sensor.characteristic('180f', '2a19');
  batteryLevel.reads.queue(bytes([87]));
  const promptPromise = bluetooth.waitForDevicePrompt();
  await page.getByRole('button', { name: 'Connect' }).click();
  await (await promptPromise).select(sensor);
  await expect(page.getByTestId('battery')).toHaveText('87%');
  await batteryLevel.expectRead();
  const operation = batteryLevel.operations()[0];
  if (operation !== undefined) {
    // @ts-expect-error Backend correlation ids are not public handle state.
    void operation.operationId;
  }

  // @ts-expect-error Named ATT errors are a closed public union.
  batteryLevel.reads.queueError('made-up-att-error');
  // @ts-expect-error Operation snapshots are immutable.
  batteryLevel.operations().push(undefined);
});

export async function exerciseHeldConnection(
  held: HeldConnection,
): Promise<void> {
  await held.waitForRequest();
  await held.resume();
  // @ts-expect-error Consumer handles do not expose correlation ids.
  void held.operationId;
}

test('internal fixture is hidden', ({
  // @ts-expect-error The diagnostic buffer is not a consumer fixture.
  _gattlabDiagnostics,
  // @ts-expect-error The runtime controller is not a consumer fixture.
  _gattlabRuntime,
}) => {
  void _gattlabDiagnostics;
  void _gattlabRuntime;
});

// @ts-expect-error The fixture owns construction.
new BluetoothLab();

// @ts-expect-error Manual BrowserContext attachment is excluded from 0.1.
export const manualAttachment = BluetoothLab.attach;

// @ts-expect-error The runtime controller remains package-private.
export type { GattLabRuntimeController } from '../src/index.js';
