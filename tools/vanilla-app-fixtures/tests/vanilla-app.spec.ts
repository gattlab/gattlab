import { bytes, expect, test } from '@gattlab/playwright';

import { writePayload } from '../app/dist/bluetooth-profile.js';
import {
  createProbePeripheral,
  createSecondProbePeripheral,
  startApplication,
  stopApplication,
} from './probe-support.js';

let application: Awaited<ReturnType<typeof startApplication>>;

test.beforeAll(async () => {
  application = await startApplication();
});

test.afterAll(async () => {
  if (application !== undefined) await stopApplication(application);
});

test.describe.serial('Vanilla JavaScript application', () => {
  test('1: selects, connects, discovers, reads, and writes', async ({
    bluetooth,
    page,
  }) => {
    await page.goto(application.url);
    const { peripheral, io } = await createProbePeripheral(bluetooth);
    io.reads.queue(bytes([87]));
    const writePromise = io.waitForWrite();

    const promptPromise = bluetooth.waitForDevicePrompt();
    await page
      .getByRole('button', { name: 'Connect, read, and write' })
      .click();
    await (await promptPromise).select(peripheral);

    await expect(page.getByTestId('status')).toHaveText('ready');
    await expect(page.getByTestId('battery')).toHaveText('87%');
    await expect(page.getByTestId('written')).toHaveText(
      writePayload.join(','),
    );
    await io.expectRead();
    await expect(writePromise).resolves.toEqual({
      data: bytes(writePayload),
      writeType: 'with-response',
    });
    expect(peripheral.operations()).toEqual(
      expect.arrayContaining([
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
      ]),
    );
  });

  test('2: handles chooser cancellation as NotFoundError', async ({
    bluetooth,
    page,
  }) => {
    await page.goto(application.url);
    await createProbePeripheral(bluetooth);

    const promptPromise = bluetooth.waitForDevicePrompt();
    await page
      .getByRole('button', { name: 'Open chooser for cancellation' })
      .click();
    const prompt = await promptPromise;
    expect(prompt.settled).toBe(false);
    await prompt.cancel();
    expect(prompt.settled).toBe(true);

    await expect(page.getByTestId('status')).toHaveText('chooser-error');
    await expect(page.getByTestId('error-name')).toHaveText('NotFoundError');
  });

  test('3: surfaces a scripted ATT read failure in the application', async ({
    bluetooth,
    page,
  }) => {
    await page.goto(application.url);
    const { peripheral, io } = await createProbePeripheral(bluetooth);
    io.reads.queueError('read-not-permitted');

    const promptPromise = bluetooth.waitForDevicePrompt();
    await page
      .getByRole('button', { name: 'Connect, read, and write' })
      .click();
    await (await promptPromise).select(peripheral);

    await expect(page.getByTestId('status')).toHaveText('operation-error');
    await expect(page.getByTestId('error-name')).toHaveText(
      'NotSupportedError',
    );
    expect(io.operations()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          request: { type: 'read' },
          response: {
            type: 'read',
            result: 'error',
            error: 'read-not-permitted',
          },
          responseSource: 'queued',
          responseDelivery: 'succeeded',
        }),
      ]),
    );
  });

  test('4: observes a scripted GATT disconnect', async ({
    bluetooth,
    page,
  }) => {
    await page.goto(application.url);
    const { peripheral, io } = await createProbePeripheral(bluetooth);
    io.reads.queue(bytes([87]));
    const writePromise = io.waitForWrite();

    const promptPromise = bluetooth.waitForDevicePrompt();
    await page
      .getByRole('button', { name: 'Connect, read, and write' })
      .click();
    await (await promptPromise).select(peripheral);
    await expect(page.getByTestId('status')).toHaveText('ready');
    await writePromise;

    await peripheral.disconnect();
    await expect(page.getByTestId('status')).toHaveText('disconnected');
  });

  test('5: reports an absent adapter as unavailable', async ({
    bluetooth,
    page,
  }) => {
    await page.goto(application.url);
    await bluetooth.adapter.setState('absent');

    await page
      .getByRole('button', { name: 'Check adapter availability' })
      .click();

    await expect(page.getByTestId('status')).toHaveText('unavailable');
    await expect(page.getByTestId('error-name')).toHaveText('--');
  });

  test('7a: completes native subscription and unsubscription handshakes', async ({
    bluetooth,
    page,
  }) => {
    await page.goto(application.url);
    const { peripheral, notification } = await createProbePeripheral(bluetooth);

    const promptPromise = bluetooth.waitForDevicePrompt();
    await page
      .getByRole('button', { name: 'Subscribe to notifications' })
      .click();
    await (await promptPromise).select(peripheral);

    await expect(page.getByTestId('status')).toHaveText('subscribed');
    await notification.expectSubscription();
    await page
      .getByRole('button', { name: 'Unsubscribe from notifications' })
      .click();
    await expect(page.getByTestId('status')).toHaveText('unsubscribed');
    await notification.expectUnsubscription();
    expect(notification.operations()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          request: { type: 'subscribe-to-notifications' },
          response: {
            type: 'subscribe-to-notifications',
            result: 'success',
          },
        }),
        expect.objectContaining({
          request: { type: 'unsubscribe-from-notifications' },
          response: {
            type: 'unsubscribe-from-notifications',
            result: 'success',
          },
        }),
      ]),
    );
  });

  test('7b: surfaces a scripted ATT subscription failure', async ({
    bluetooth,
    page,
  }) => {
    await page.goto(application.url);
    const { peripheral, notification } = await createProbePeripheral(bluetooth);
    notification.subscriptions.queueError('unlikely-error');

    const promptPromise = bluetooth.waitForDevicePrompt();
    await page
      .getByRole('button', { name: 'Subscribe to notifications' })
      .click();
    await (await promptPromise).select(peripheral);

    await expect(page.getByTestId('status')).toHaveText('subscription-error');
    await expect(page.getByTestId('error-name')).toHaveText(
      'NotSupportedError',
    );
    expect(notification.operations()).toEqual([
      expect.objectContaining({
        request: { type: 'subscribe-to-notifications' },
        response: {
          type: 'subscribe-to-notifications',
          result: 'error',
          error: 'unlikely-error',
        },
        responseSource: 'queued',
        responseDelivery: 'succeeded',
      }),
    ]);
  });

  test('8: reconnects and reads a new value after explicit re-advertisement', async ({
    bluetooth,
    page,
  }) => {
    await page.goto(application.url);
    const { peripheral, io } = await createProbePeripheral(bluetooth);
    io.reads.queue(bytes([87]));
    io.reads.queue(bytes([42]));
    const firstWrite = io.waitForWrite();

    const firstPromptPromise = bluetooth.waitForDevicePrompt();
    await page
      .getByRole('button', { name: 'Connect, read, and write' })
      .click();
    await (await firstPromptPromise).select(peripheral);
    await expect(page.getByTestId('status')).toHaveText('ready');
    await expect(page.getByTestId('battery')).toHaveText('87%');
    await firstWrite;

    await peripheral.disconnect();
    await expect(page.getByTestId('status')).toHaveText('disconnected');

    const secondWrite = io.waitForWrite();
    const secondPromptPromise = bluetooth.waitForDevicePrompt();
    await page
      .getByRole('button', { name: 'Connect, read, and write' })
      .click();
    const secondPrompt = await secondPromptPromise;
    expect(secondPrompt.devices).toEqual([]);
    await peripheral.advertise();
    expect(secondPrompt.devices).toEqual([
      { id: peripheral.address, name: '' },
    ]);
    await secondPrompt.select(peripheral);

    await expect(page.getByTestId('status')).toHaveText('ready');
    await expect(page.getByTestId('battery')).toHaveText('42%');
    await secondWrite;
    expect(
      peripheral
        .operations()
        .filter(({ request }) => request.type === 'connection'),
    ).toHaveLength(2);
    expect(
      peripheral
        .operations()
        .filter(({ request }) => request.type === 'discovery'),
    ).toHaveLength(2);
  });

  test('9: selects the intended device when two candidates offer the service', async ({
    bluetooth,
    page,
  }) => {
    await page.goto(application.url);
    const { io: firstIo } = await createProbePeripheral(bluetooth);
    const { peripheral: second, io: secondIo } =
      await createSecondProbePeripheral(bluetooth);
    firstIo.reads.queue(bytes([87]));
    secondIo.reads.queue(bytes([13]));

    const promptPromise = bluetooth.waitForDevicePrompt();
    await page
      .getByRole('button', { name: 'Connect, read, and write' })
      .click();
    const prompt = await promptPromise;
    expect(prompt.devices).toHaveLength(2);
    await prompt.select(second);

    await expect(page.getByTestId('status')).toHaveText('ready');
    await expect(page.getByTestId('battery')).toHaveText('13%');
    await secondIo.expectRead();
    expect(firstIo.operations()).toEqual([]);
  });

  test('10: keeps the successful read when the follow-up write is rejected', async ({
    bluetooth,
    page,
  }) => {
    await page.goto(application.url);
    const { peripheral, io } = await createProbePeripheral(bluetooth);
    io.reads.queue(bytes([87]));
    io.writes.queueError('write-not-permitted');

    const promptPromise = bluetooth.waitForDevicePrompt();
    await page
      .getByRole('button', { name: 'Connect, read, and write' })
      .click();
    await (await promptPromise).select(peripheral);

    await expect(page.getByTestId('status')).toHaveText('operation-error');
    await expect(page.getByTestId('battery')).toHaveText('87%');
    await expect(page.getByTestId('written')).toHaveText('--');
    await expect(page.getByTestId('error-name')).toHaveText(
      'NotSupportedError',
    );
    expect(io.operations()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          request: { type: 'read' },
          response: { type: 'read', result: 'success', data: bytes([87]) },
        }),
        expect.objectContaining({
          request: expect.objectContaining({ type: 'write' }),
          response: {
            type: 'write',
            result: 'error',
            error: 'write-not-permitted',
          },
          responseSource: 'queued',
        }),
      ]),
    );
  });

  test('11: reports an unsubscribe attempt after the device disconnected', async ({
    bluetooth,
    page,
  }) => {
    await page.goto(application.url);
    const { peripheral, notification } = await createProbePeripheral(bluetooth);

    const promptPromise = bluetooth.waitForDevicePrompt();
    await page
      .getByRole('button', { name: 'Subscribe to notifications' })
      .click();
    await (await promptPromise).select(peripheral);
    await expect(page.getByTestId('status')).toHaveText('subscribed');
    await notification.expectSubscription();

    await peripheral.disconnect();
    await expect(page.getByTestId('status')).toHaveText('disconnected');

    await page
      .getByRole('button', { name: 'Unsubscribe from notifications' })
      .click();
    await expect(page.getByTestId('status')).toHaveText('unsubscription-error');
    await expect(page.getByTestId('error-name')).toHaveText('NetworkError');
    expect(
      notification
        .operations()
        .filter(
          ({ request }) => request.type === 'unsubscribe-from-notifications',
        ),
    ).toEqual([]);
  });

  test('12: shows the connecting state while a reconnect is held', async ({
    bluetooth,
    page,
  }) => {
    await page.goto(application.url);
    const { peripheral, io } = await createProbePeripheral(bluetooth);
    io.reads.queue(bytes([87]));
    io.reads.queue(bytes([42]));
    const connect = page.getByRole('button', {
      name: 'Connect, read, and write',
    });
    const status = page.getByTestId('status');
    const battery = page.getByTestId('battery');

    const firstPrompt = bluetooth.waitForDevicePrompt();
    await connect.click();
    await (await firstPrompt).select(peripheral);
    await expect(status).toHaveText('ready');
    await expect(battery).toHaveText('87%');
    await io.expectRead();
    await peripheral.disconnect();
    await expect(status).toHaveText('disconnected');

    const held = peripheral.connection.holdNext();
    const secondPrompt = bluetooth.waitForDevicePrompt();
    await connect.click();
    const prompt = await secondPrompt;
    await peripheral.advertise();
    await prompt.select(peripheral);
    await held.waitForRequest();
    await expect(status).toHaveText('connecting');
    await expect(battery).toHaveText('87%');
    expect(
      io.operations().filter(({ request }) => request.type === 'read'),
    ).toHaveLength(1);

    await held.resume();
    await expect(status).toHaveText('ready');
    await expect(battery).toHaveText('42%');
  });
});
