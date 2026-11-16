import { bytes, expect, test } from '@gattlab/playwright';
import {
  createProbePeripheral,
  startApplication,
  stopApplication,
  writePayload,
} from './probe-support.js';

let application: Awaited<ReturnType<typeof startApplication>>;
test.beforeAll(async () => {
  application = await startApplication();
});
test.afterAll(async () => {
  if (application !== undefined) await stopApplication(application);
});

test('B1: Razor click reads/writes through C# and receives native disconnect', async ({
  bluetooth,
  page,
}) => {
  await page.goto(application.url);
  await expect(page.getByTestId('app-ready')).toHaveText('ready');
  // Distinct peripheral per value: each connects once, with no reconnect.
  // A constant response, even the old scripted 73, cannot satisfy both reads.
  for (const [address, battery] of [
    ['47:41:54:54:40:07', 73],
    ['47:41:54:54:40:08', 42],
  ] as const) {
    await test.step(`C# renders scripted read ${String(battery)}%`, async () => {
      const { peripheral, io } = await createProbePeripheral(
        bluetooth,
        address,
      );
      io.reads.queue(bytes([battery]));
      io.writes.queueSuccess();
      const read = io.expectRead();
      const written = io.waitForWrite();
      const prompt = bluetooth.waitForDevicePrompt();
      await page.locator('#connect').click();
      await (await prompt).select(peripheral);
      await read;
      await expect(written).resolves.toEqual({
        data: bytes(writePayload),
        writeType: 'with-response',
      });
      await expect(page.getByTestId('status')).toHaveText('ready');
      await expect(page.getByTestId('battery')).toHaveText(
        `${String(battery)}%`,
      );
      await expect(page.getByTestId('written')).toHaveText('16,32,48');
      for (const field of ['error-category', 'error-name', 'error-message'])
        await expect(page.getByTestId(field)).toHaveText('--');
      expect(peripheral.operations()).toEqual([
        expect.objectContaining({
          request: { type: 'connection' },
          response: { result: 'success' },
          responseDelivery: 'succeeded',
        }),
        expect.objectContaining({
          request: { type: 'discovery' },
          response: { result: 'success' },
          responseDelivery: 'succeeded',
        }),
      ]);
      expect(io.operations()).toEqual([
        expect.objectContaining({
          request: { type: 'read' },
          response: { type: 'read', result: 'success', data: bytes([battery]) },
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
          responseSource: 'queued',
          responseDelivery: 'succeeded',
        }),
      ]);
      await peripheral.disconnect();
      await expect(page.getByTestId('status')).toHaveText('disconnected');
    });
  }
});

test('B2: real chooser cancellation preserves DOMException in C#', async ({
  bluetooth,
  page,
}) => {
  await page.goto(application.url);
  await expect(page.getByTestId('app-ready')).toHaveText('ready');
  const { peripheral, io } = await createProbePeripheral(bluetooth);
  for (const button of ['#cancel', '#connect']) {
    await test.step(`Cancel native chooser from ${button}`, async () => {
      const prompt = bluetooth.waitForDevicePrompt();
      await page.locator(button).click();
      await (await prompt).cancel();
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
    });
  }
});

test('B3: ATT read failure remains operation error and prevents write', async ({
  bluetooth,
  page,
}) => {
  await page.goto(application.url);
  await expect(page.getByTestId('app-ready')).toHaveText('ready');
  const { peripheral, io } = await createProbePeripheral(bluetooth);
  io.reads.queueError('read-not-permitted');
  const prompt = bluetooth.waitForDevicePrompt();
  await page.locator('#connect').click();
  await (await prompt).select(peripheral);
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
