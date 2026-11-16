import { bytes, expect, test } from '@gattlab/playwright';
import type { Page } from '@playwright/test';
import {
  createProbePeripheral,
  startApplication,
  stopApplication,
  writePayload,
} from './probe-support.js';

let production: Awaited<ReturnType<typeof startApplication>>;
let development: Awaited<ReturnType<typeof startApplication>>;
let browserErrors: string[];

test.beforeAll(async () => {
  production = await startApplication('production');
  development = await startApplication('development');
});

test.afterAll(async () => {
  try {
    if (development !== undefined) await stopApplication(development);
  } finally {
    if (production !== undefined) await stopApplication(production);
  }
});

test.beforeEach(async ({ page }) => {
  browserErrors = [];
  page.on('pageerror', (error) => browserErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') browserErrors.push(message.text());
  });
});

test.afterEach(() => {
  expect(browserErrors).toEqual([]);
});

async function assertReady(page: Page, value: number) {
  await expect(page.getByTestId('status')).toHaveText('ready');
  await expect(page.getByTestId('battery')).toHaveText(`${value}%`);
  await expect(page.getByTestId('written')).toHaveText(writePayload.join(','));
  for (const field of ['error-category', 'error-name', 'error-message']) {
    await expect(page.getByTestId(field)).toHaveText('--');
  }
}

function expectedIo(value: number) {
  return [
    expect.objectContaining({
      request: { type: 'read' },
      response: { type: 'read', result: 'success', data: bytes([value]) },
      responseSource: 'queued',
      responseDelivery: 'succeeded',
    }),
    expect.objectContaining({
      request: {
        type: 'write',
        data: bytes(writePayload),
        writeType: 'with-response',
      },
      response: { type: 'write', result: 'success' },
      responseDelivery: 'succeeded',
    }),
  ];
}

test('R1: reconnects the same peripheral and renders two distinct read values', async ({
  bluetooth,
  page,
}) => {
  await page.goto(production.url);
  await expect(page.getByTestId('status')).toHaveText('app-ready');
  const { peripheral, io } = await createProbePeripheral(bluetooth);
  io.reads.queue(bytes([73]));
  io.reads.queue(bytes([42]));

  for (const [index, value] of [73, 42].entries()) {
    // expectRead retains historical reads. Arm the next successful journal
    // occurrence so the second journey cannot reuse the first read's evidence.
    const read = expect
      .poll(
        () =>
          io
            .operations()
            .filter(
              ({ request, response, responseDelivery }) =>
                request.type === 'read' &&
                response.result === 'success' &&
                responseDelivery === 'succeeded',
            ).length,
      )
      .toBe(index + 1);
    const write = io.waitForWrite();
    const prompted = bluetooth.waitForDevicePrompt();
    await page.locator('#connect').click();
    const prompt = await prompted;
    if (index === 1) {
      expect(prompt.devices).toEqual([]);
      await peripheral.advertise();
      expect(prompt.devices).toEqual([{ id: peripheral.address, name: '' }]);
    }
    await prompt.select(peripheral);
    await read;
    await expect(write).resolves.toEqual({
      data: bytes(writePayload),
      writeType: 'with-response',
    });
    await assertReady(page, value);
    expect(io.operations()).toEqual(
      index === 0 ? expectedIo(73) : [...expectedIo(73), ...expectedIo(42)],
    );
    for (const type of ['connection', 'discovery']) {
      expect(
        peripheral.operations().filter(({ request }) => request.type === type),
      ).toEqual(
        Array.from({ length: index + 1 }, () =>
          expect.objectContaining({
            request: { type },
            response: { result: 'success' },
            responseDelivery: 'succeeded',
          }),
        ),
      );
    }
    await peripheral.disconnect();
    await expect(page.getByTestId('status')).toHaveText('disconnected');
    await expect(page.getByTestId('disconnect-events')).toHaveText(
      String(index + 1),
    );
  }
});

test('R2: preserves chooser cancellation from both actions without GATT operations', async ({
  bluetooth,
  page,
}) => {
  await page.goto(production.url);
  await expect(page.getByTestId('status')).toHaveText('app-ready');
  const { peripheral, io } = await createProbePeripheral(bluetooth);
  for (const action of ['#cancel', '#connect']) {
    const prompted = bluetooth.waitForDevicePrompt();
    await page.locator(action).click();
    await (await prompted).cancel();
    await expect(page.getByTestId('status')).toHaveText('chooser-error');
    await expect(page.getByTestId('error-category')).toHaveText('chooser');
    await expect(page.getByTestId('error-name')).toHaveText('NotFoundError');
    await expect(page.getByTestId('error-message')).not.toHaveText(
      /^(?:--)?$/u,
    );
    await expect(page.getByTestId('battery')).toHaveText('--');
    await expect(page.getByTestId('written')).toHaveText('--');
    expect(peripheral.operations()).toEqual([]);
    expect(io.operations()).toEqual([]);
  }
});

test('R3: preserves the ATT read failure and never writes or renders success', async ({
  bluetooth,
  page,
}) => {
  await page.goto(production.url);
  await expect(page.getByTestId('status')).toHaveText('app-ready');
  const { peripheral, io } = await createProbePeripheral(bluetooth);
  io.reads.queueError('read-not-permitted');
  const prompted = bluetooth.waitForDevicePrompt();
  await page.locator('#connect').click();
  await (await prompted).select(peripheral);
  await expect(page.getByTestId('status')).toHaveText('operation-error');
  await expect(page.getByTestId('error-category')).toHaveText('operation');
  await expect(page.getByTestId('error-name')).toHaveText('NotSupportedError');
  await expect(page.getByTestId('error-message')).not.toHaveText(/^(?:--)?$/u);
  await expect(page.getByTestId('battery')).toHaveText('--');
  await expect(page.getByTestId('written')).toHaveText('--');
  expect(io.operations()).toEqual([
    expect.objectContaining({
      request: { type: 'read' },
      response: { type: 'read', result: 'error', error: 'read-not-permitted' },
      responseSource: 'queued',
      responseDelivery: 'succeeded',
    }),
  ]);
});

test('R4: development StrictMode keeps one native disconnect listener', async ({
  bluetooth,
  page,
}) => {
  await page.goto(development.url);
  await expect(page.getByTestId('status')).toHaveText('app-ready');
  const { peripheral, io } = await createProbePeripheral(bluetooth);
  io.reads.queue(bytes([73]));
  const read = io.expectRead();
  const write = io.waitForWrite();
  const prompted = bluetooth.waitForDevicePrompt();
  await page.locator('#connect').click();
  await (await prompted).select(peripheral);
  await read;
  await expect(write).resolves.toEqual({
    data: bytes(writePayload),
    writeType: 'with-response',
  });
  await assertReady(page, 73);
  expect(io.operations()).toEqual(expectedIo(73));
  await peripheral.disconnect();
  await expect(page.getByTestId('status')).toHaveText('disconnected');
  await expect(page.getByTestId('disconnect-events')).toHaveText('1');
});
