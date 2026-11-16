import { bytes, expect, test } from '@gattlab/playwright';
import type { Locator, Page } from '@playwright/test';
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

// After Bluetooth use no case navigates, reloads, closes the page,
// or opens another one. Components are unmounted and remounted in place.
async function openApplication(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  await page.goto(application.url);
  await expect(page.getByTestId('app-ready')).toHaveText('ready');
  return errors;
}

function lifecycle(page: Page): Locator {
  return page.getByTestId('lifecycle-log').locator('li');
}

async function expectErrorFields(
  page: Page,
  category: string,
  name: string,
): Promise<void> {
  await expect(page.getByTestId('error-category')).toHaveText(category);
  await expect(page.getByTestId('error-name')).toHaveText(name);
  await expect(page.getByTestId('error-message')).not.toHaveText(/^(?:--)?$/u);
}

async function expectNoError(page: Page): Promise<void> {
  for (const field of ['error-category', 'error-name', 'error-message'])
    await expect(page.getByTestId(field)).toHaveText('--');
}

async function remountPanel(page: Page, disposedSession: number) {
  await page.locator('#hide-panel').click();
  await expect(lifecycle(page).last()).toHaveText(
    `disposed ${String(disposedSession)}`,
  );
  await page.locator('#show-panel').click();
  await expect(page.getByTestId('app-ready')).toHaveText('ready');
  await expect(page.getByTestId('session')).toHaveText(
    String(disposedSession + 1),
  );
}

function count(
  operations: readonly { readonly request: { readonly type: string } }[],
  type: string,
): number {
  return operations.filter(({ request }) => request.type === type).length;
}

test('E1: availability crosses interop as a C# value', async ({
  bluetooth,
  page,
}) => {
  await openApplication(page);
  const { peripheral, io } = await createProbePeripheral(bluetooth);
  const expected = ['created 1'];
  for (const [state, status] of [
    ['powered-on', 'available'],
    ['absent', 'unavailable'],
    ['powered-off', 'available'],
  ] as const) {
    await test.step(`${state} renders ${status}`, async () => {
      await bluetooth.adapter.setState(state);
      await page.locator('#availability').click();
      expected.push('request 1 availability', 'result 1 success');
      // The log proves this click settled, even when the status text repeats.
      await expect(lifecycle(page)).toHaveText(expected);
      await expect(page.getByTestId('status')).toHaveText(status);
      await expectNoError(page);
    });
  }
  expect(peripheral.operations()).toEqual([]);
  expect(io.operations()).toEqual([]);
});

test('E2: native subscribe and unsubscribe handshakes through C#', async ({
  bluetooth,
  page,
}) => {
  await openApplication(page);
  const { peripheral, notification } = await createProbePeripheral(bluetooth);
  const prompt = bluetooth.waitForDevicePrompt();
  await page.locator('#subscribe').click();
  await (await prompt).select(peripheral);
  await expect(page.getByTestId('status')).toHaveText('subscribed');
  await notification.expectSubscription();

  await page.locator('#unsubscribe').click();
  await expect(page.getByTestId('status')).toHaveText('unsubscribed');
  await notification.expectUnsubscription();
  await expectNoError(page);
  expect(notification.operations()).toEqual([
    expect.objectContaining({
      request: { type: 'subscribe-to-notifications' },
      response: { type: 'subscribe-to-notifications', result: 'success' },
      responseDelivery: 'succeeded',
    }),
    expect.objectContaining({
      request: { type: 'unsubscribe-from-notifications' },
      response: { type: 'unsubscribe-from-notifications', result: 'success' },
      responseDelivery: 'succeeded',
    }),
  ]);
  await expect(lifecycle(page)).toHaveText([
    'created 1',
    'request 1 subscribe',
    'result 1 success',
    'request 1 unsubscribe',
    'result 1 success',
  ]);
});

test('E3: subscription failures keep their DOMException names in C#', async ({
  bluetooth,
  page,
}) => {
  await openApplication(page);
  const { peripheral, notification } = await createProbePeripheral(bluetooth);
  notification.subscriptions.queueError('unlikely-error');
  const failing = bluetooth.waitForDevicePrompt();
  await page.locator('#subscribe').click();
  await (await failing).select(peripheral);
  await expect(page.getByTestId('status')).toHaveText('subscription-error');
  await expectErrorFields(page, 'operation', 'NotSupportedError');
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

  const fresh = bluetooth.waitForDevicePrompt();
  await page.locator('#subscribe').click();
  await (await fresh).select(peripheral);
  await expect(page.getByTestId('status')).toHaveText('subscribed');
  await notification.expectSubscription();
  await peripheral.disconnect();
  await expect(page.getByTestId('status')).toHaveText('disconnected');

  await page.locator('#unsubscribe').click();
  await expect(page.getByTestId('status')).toHaveText('unsubscription-error');
  await expectErrorFields(page, 'operation', 'NetworkError');
  expect(
    count(notification.operations(), 'unsubscribe-from-notifications'),
  ).toBe(0);
});

test('E4: a rejected write keeps the successful read in the C# result', async ({
  bluetooth,
  page,
}) => {
  await openApplication(page);
  const { peripheral, io } = await createProbePeripheral(bluetooth);
  io.reads.queue(bytes([61]));
  io.writes.queueError('write-not-permitted');
  const prompt = bluetooth.waitForDevicePrompt();
  await page.locator('#connect').click();
  await (await prompt).select(peripheral);

  await expect(page.getByTestId('status')).toHaveText('write-error');
  await expect(page.getByTestId('battery')).toHaveText('61%');
  await expect(page.getByTestId('written')).toHaveText('--');
  await expectErrorFields(page, 'operation', 'NotSupportedError');
  expect(io.operations()).toEqual([
    expect.objectContaining({
      request: { type: 'read' },
      response: { type: 'read', result: 'success', data: bytes([61]) },
      responseSource: 'queued',
      responseDelivery: 'succeeded',
    }),
    expect.objectContaining({
      request: {
        type: 'write',
        data: bytes(writePayload),
        writeType: 'with-response',
      },
      response: {
        type: 'write',
        result: 'error',
        error: 'write-not-permitted',
      },
      responseSource: 'queued',
      responseDelivery: 'succeeded',
    }),
  ]);
});

test('E5: reconnects through a new chooser after a scripted disconnect', async ({
  bluetooth,
  page,
}) => {
  await openApplication(page);
  const { peripheral, io } = await createProbePeripheral(bluetooth);
  io.reads.queue(bytes([87]));
  io.reads.queue(bytes([42]));
  io.writes.queueSuccess();
  io.writes.queueSuccess();

  const first = bluetooth.waitForDevicePrompt();
  await page.locator('#connect').click();
  await (await first).select(peripheral);
  await expect(page.getByTestId('battery')).toHaveText('87%');
  await expect(page.getByTestId('status')).toHaveText('ready');
  await peripheral.disconnect();
  await expect(page.getByTestId('status')).toHaveText('disconnected');

  const second = bluetooth.waitForDevicePrompt();
  await page.locator('#connect').click();
  const prompt = await second;
  expect(prompt.devices).toEqual([]);
  await peripheral.advertise();
  await prompt.select(peripheral);
  await expect(page.getByTestId('status')).toHaveText('ready');
  await expect(page.getByTestId('battery')).toHaveText('42%');
  await expect(page.getByTestId('written')).toHaveText('16,32,48');
  expect(count(peripheral.operations(), 'connection')).toBe(2);
  expect(count(peripheral.operations(), 'discovery')).toBe(2);
  expect(count(io.operations(), 'read')).toBe(2);
});

test('L1: rerendering during the chooser starts no second request', async ({
  bluetooth,
  page,
}) => {
  await openApplication(page);
  const { peripheral, io } = await createProbePeripheral(bluetooth);
  io.reads.queue(bytes([87]));
  io.writes.queueSuccess();
  const pending = bluetooth.waitForDevicePrompt();
  await page.locator('#connect').click();
  const prompt = await pending;
  for (let tick = 1; tick <= 3; tick += 1) {
    await page.locator('#tick').click();
    await expect(page.getByTestId('ticks')).toHaveText(String(tick));
    await expect(page.locator('#connect')).toBeDisabled();
    await expect(page.locator('#cancel')).toBeDisabled();
    await expect(page.getByTestId('status')).toHaveText('pending');
  }
  await prompt.select(peripheral);
  await expect(page.getByTestId('status')).toHaveText('ready');
  await expect(page.getByTestId('battery')).toHaveText('87%');
  await expect(lifecycle(page)).toHaveText([
    'created 1',
    'request 1 connect',
    'result 1 success',
  ]);
  expect(count(peripheral.operations(), 'connection')).toBe(1);
  expect(count(io.operations(), 'read')).toBe(1);
});

for (const [id, settle] of [
  ['L2a', 'cancel'],
  ['L2b', 'select'],
] as const) {
  test(`${id}: a panel disposed with its chooser open ignores the later ${settle}`, async ({
    bluetooth,
    page,
  }) => {
    const errors = await openApplication(page);
    const { peripheral, io } = await createProbePeripheral(bluetooth);
    io.reads.queue(bytes([87]));
    io.writes.queueSuccess();
    const abandoned = bluetooth.waitForDevicePrompt();
    await page.locator('#connect').click();
    const oldPrompt = await abandoned;
    // Session 2 exists before the old prompt settles, so shared state would leak.
    await remountPanel(page, 1);
    if (settle === 'cancel') await oldPrompt.cancel();
    else await oldPrompt.select(peripheral);
    await expect(lifecycle(page)).toHaveText([
      'created 1',
      'request 1 connect',
      'disposed 1',
      'created 2',
      'settled 1 disposed',
    ]);
    await expect(page.getByTestId('status')).toHaveText('idle');
    await expect(page.getByTestId('battery')).toHaveText('--');
    expect(peripheral.operations()).toEqual([]);

    const fresh = bluetooth.waitForDevicePrompt();
    await page.locator('#connect').click();
    await (await fresh).select(peripheral);
    await expect(page.getByTestId('status')).toHaveText('ready');
    await expect(page.getByTestId('battery')).toHaveText('87%');
    await expect(lifecycle(page)).toHaveText([
      'created 1',
      'request 1 connect',
      'disposed 1',
      'created 2',
      'settled 1 disposed',
      'request 2 connect',
      'result 2 success',
    ]);
    expect(count(peripheral.operations(), 'connection')).toBe(1);
    expect(count(io.operations(), 'read')).toBe(1);
    expect(errors).toEqual([]);
  });
}

test('L3: a panel disposed while connected releases its native listener', async ({
  bluetooth,
  page,
}) => {
  const errors = await openApplication(page);
  const { peripheral, io } = await createProbePeripheral(bluetooth);
  io.reads.queue(bytes([87]));
  io.reads.queue(bytes([42]));
  io.writes.queueSuccess();
  io.writes.queueSuccess();
  const first = bluetooth.waitForDevicePrompt();
  await page.locator('#connect').click();
  await (await first).select(peripheral);
  await expect(page.getByTestId('battery')).toHaveText('87%');

  // Session 1 removes its listener, then disconnects the shared device object.
  await remountPanel(page, 1);
  const second = bluetooth.waitForDevicePrompt();
  await page.locator('#connect').click();
  const prompt = await second;
  // Deliverable 1: an application-initiated disconnect keeps the device listed.
  expect(prompt.devices).toEqual([{ id: peripheral.address, name: '' }]);
  await prompt.select(peripheral);
  await expect(page.getByTestId('battery')).toHaveText('42%');

  // The same BluetoothDevice object is returned to session 2, so a leaked
  // session-1 listener would fire here as well as at session 1's own release.
  await peripheral.disconnect();
  await expect(page.getByTestId('status')).toHaveText('disconnected');
  await expect(lifecycle(page)).toHaveText([
    'created 1',
    'request 1 connect',
    'result 1 success',
    'disposed 1',
    'created 2',
    'request 2 connect',
    'result 2 success',
    'native-event 2 gattserverdisconnected',
    'callback 2 disconnected',
  ]);
  // Deliverable 1: reconnecting after an application disconnect adds no
  // connection record; the scripted disconnect is the only one after it.
  expect(count(peripheral.operations(), 'connection')).toBe(1);
  expect(count(io.operations(), 'read')).toBe(2);
  expect(errors).toEqual([]);
});
