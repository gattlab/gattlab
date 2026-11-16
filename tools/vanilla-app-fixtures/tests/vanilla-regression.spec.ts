import {
  bytes,
  expect,
  test,
  type CharacteristicWrite,
} from '@gattlab/playwright';

import {
  descriptorWritePayload,
  firmwareCharacteristicUuid,
  ioDescriptorUuid,
  serviceUuid,
  withoutResponsePayload,
  writePayload,
} from '../app/dist/bluetooth-profile.js';
import {
  createProbePeripheral,
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

test.use({
  gattlab: {
    artifacts: 'retain-on-failure',
    operationHistoryLimit: 32,
    operationTimeoutMs: 5_000,
    promptTimeoutMs: 5_000,
    teardownTimeoutMs: 5_000,
  },
});

test.describe('Vanilla regression', () => {
  test('R1: powered-off differs from absent and recovers to powered-on', async ({
    bluetooth,
    page,
  }) => {
    await page.goto(application.url);
    const { peripheral, io } = await createProbePeripheral(bluetooth);
    await bluetooth.adapter.setState('powered-off');
    await page
      .getByRole('button', { name: 'Check adapter availability' })
      .click();
    await expect(page.getByTestId('status')).toHaveText('available');
    await expect(page.getByTestId('error-name')).toHaveText('--');

    const offPromptPromise = bluetooth.waitForDevicePrompt();
    await page
      .getByRole('button', { name: 'Open chooser for cancellation' })
      .click();
    const offPrompt = await offPromptPromise;
    expect(offPrompt.devices).toEqual([{ id: peripheral.address, name: '' }]);
    await offPrompt.cancel();
    expect(offPrompt.settled).toBe(true);
    await expect(page.getByTestId('status')).toHaveText('chooser-error');
    await expect(page.getByTestId('error-name')).toHaveText('NotFoundError');
    expect(peripheral.operations()).toEqual([]);

    await bluetooth.adapter.setState('absent');
    await page
      .getByRole('button', { name: 'Check adapter availability' })
      .click();
    await expect(page.getByTestId('status')).toHaveText('unavailable');
    await expect(page.getByTestId('error-name')).toHaveText('--');
    await expect(page.getByTestId('error-message')).toHaveText('--');
    expect(io.operations()).toEqual([]);

    await bluetooth.adapter.setState('powered-off');
    await bluetooth.adapter.setState('powered-on');
    io.reads.queue(bytes([73]));
    const writePromise = io.waitForWrite();
    const promptPromise = bluetooth.waitForDevicePrompt();
    await page
      .getByRole('button', { name: 'Connect, read, and write' })
      .click();
    const prompt = await promptPromise;
    await peripheral.advertise();
    // Chooser candidates cross browser/page CDP sessions after advertising;
    // there is no GattLab candidate-update wait API.
    await expect
      .poll(() => prompt.devices.map(({ id }) => id))
      .toEqual([peripheral.address]);
    await prompt.select(peripheral);
    await expect(writePromise).resolves.toEqual({
      data: bytes(writePayload),
      writeType: 'with-response',
    });
    await io.expectRead();
    await expect(page.getByTestId('status')).toHaveText('ready');
    await expect(page.getByTestId('battery')).toHaveText('73%');
    await expect(page.getByTestId('written')).toHaveText(
      writePayload.join(','),
    );
    expect(
      peripheral
        .operations()
        .map(({ request, response }) => ({ request, response })),
    ).toEqual([
      { request: { type: 'connection' }, response: { result: 'success' } },
      { request: { type: 'discovery' }, response: { result: 'success' } },
    ]);
  });

  test('R2: reads two independent characteristics in one connection and discovery', async ({
    bluetooth,
    page,
  }) => {
    await page.goto(application.url);
    const { peripheral, io } = await createProbePeripheral(bluetooth);
    const firmware = peripheral.characteristic(
      serviceUuid,
      firmwareCharacteristicUuid,
    );
    io.reads.queue(bytes([61]));
    firmware.reads.queue(new TextEncoder().encode('beta-502'));
    const reads = Promise.all([io.expectRead(), firmware.expectRead()]);
    const promptPromise = bluetooth.waitForDevicePrompt();
    await page
      .getByRole('button', { name: 'Read both characteristics' })
      .click();
    await (await promptPromise).select(peripheral);
    await Promise.all([
      reads,
      expect(page.getByTestId('status')).toHaveText('both-read'),
      expect(page.getByTestId('regression-battery')).toHaveText('61%'),
      expect(page.getByTestId('firmware')).toHaveText('beta-502'),
    ]);
    expect(peripheral.operations().map(({ request }) => request.type)).toEqual([
      'connection',
      'discovery',
    ]);
    expect(io.operations()).toEqual([
      expect.objectContaining({
        request: { type: 'read' },
        response: { type: 'read', result: 'success', data: bytes([61]) },
        responseSource: 'queued',
        responseDelivery: 'succeeded',
      }),
    ]);
    expect(firmware.operations()).toEqual([
      expect.objectContaining({
        request: { type: 'read' },
        response: {
          type: 'read',
          result: 'success',
          data: new TextEncoder().encode('beta-502'),
        },
        responseSource: 'queued',
        responseDelivery: 'succeeded',
      }),
    ]);
  });

  test('R3: reads and writes the descriptor and isolates its ATT error', async ({
    bluetooth,
    page,
  }) => {
    await page.goto(application.url);
    const { peripheral, io } = await createProbePeripheral(bluetooth);
    const descriptor = io.descriptor(ioDescriptorUuid);
    descriptor.reads.queue(bytes([0, 127, 128, 255]));
    descriptor.writes.queueSuccess();
    const promptPromise = bluetooth.waitForDevicePrompt();
    await page
      .getByRole('button', { name: 'Read descriptor', exact: true })
      .click();
    await (await promptPromise).select(peripheral);
    await expect(page.getByTestId('status')).toHaveText('descriptor-read');
    await expect(page.getByTestId('descriptor-read')).toHaveText(
      '0,127,128,255',
    );
    const writePromise = descriptor.waitForWrite();
    await page
      .getByRole('button', { name: 'Write descriptor', exact: true })
      .click();
    await expect(writePromise).resolves.toEqual({
      data: bytes(descriptorWritePayload),
    });
    await expect(page.getByTestId('status')).toHaveText('descriptor-written');
    await expect(page.getByTestId('descriptor-written')).toHaveText(
      descriptorWritePayload.join(','),
    );
    expect(
      io.operations().filter(({ request }) => request.type === 'write'),
    ).toEqual([]);

    descriptor.reads.queueError('read-not-permitted');
    await page
      .getByRole('button', { name: 'Read descriptor', exact: true })
      .click();
    await expect(page.getByTestId('status')).toHaveText('operation-error');
    await expect(page.getByTestId('error-name')).toHaveText(
      'NotSupportedError',
    );
    expect(descriptor.operations()).toEqual([
      expect.objectContaining({
        request: { type: 'read' },
        response: {
          type: 'read',
          result: 'success',
          data: bytes([0, 127, 128, 255]),
        },
        responseSource: 'queued',
        responseDelivery: 'succeeded',
      }),
      expect.objectContaining({
        request: { type: 'write', data: bytes(descriptorWritePayload) },
        response: { type: 'write', result: 'success' },
        responseSource: 'queued',
        responseDelivery: 'succeeded',
      }),
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
    ]);
    expect(
      peripheral
        .operations()
        .filter(({ request }) => request.type === 'connection'),
    ).toHaveLength(1);
  });

  test('R4: preserves without-response intent and resolves despite scripted ATT failure', async ({
    bluetooth,
    page,
  }) => {
    await page.goto(application.url);
    const { peripheral, io } = await createProbePeripheral(bluetooth);
    io.writes.queueSuccess();
    const writePromise = io.waitForWrite();
    const promptPromise = bluetooth.waitForDevicePrompt();
    await page
      .getByRole('button', { name: 'Write without response', exact: true })
      .click();
    await (await promptPromise).select(peripheral);
    await expect(writePromise).resolves.toEqual({
      data: bytes(withoutResponsePayload),
      writeType: 'without-response',
    });
    await expect(page.getByTestId('status')).toHaveText(
      'without-response-written',
    );
    await expect(page.getByTestId('without-response-written')).toHaveText(
      withoutResponsePayload.join(','),
    );

    io.writes.queueError('write-not-permitted');
    const errorWrite = io.waitForWrite();
    await page
      .getByRole('button', { name: 'Write without response', exact: true })
      .click();
    await expect(errorWrite).resolves.toEqual({
      data: bytes(withoutResponsePayload),
      writeType: 'without-response',
    });
    await expect(page.getByTestId('status')).toHaveText(
      'without-response-written',
    );
    await expect(page.getByTestId('without-response-written')).toHaveText(
      withoutResponsePayload.join(','),
    );
    await expect(page.getByTestId('error-name')).toHaveText('--');
    expect(io.operations()).toEqual([
      expect.objectContaining({
        request: {
          type: 'write',
          writeType: 'without-response',
          data: bytes(withoutResponsePayload),
        },
        response: { type: 'write', result: 'success' },
        responseSource: 'queued',
        responseDelivery: 'succeeded',
      }),
      expect.objectContaining({
        request: {
          type: 'write',
          writeType: 'without-response',
          data: bytes(withoutResponsePayload),
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

  test('R5: collects each ordered burst write with one next-write waiter', async ({
    bluetooth,
    page,
  }) => {
    await page.goto(application.url);
    const { peripheral, io } = await createProbePeripheral(bluetooth);
    const payloads = [
      [1, 161],
      [2, 162],
      [3, 163],
      [4, 164],
      [5, 165],
    ];
    expect(payloads.length).toBeGreaterThanOrEqual(5);
    expect(payloads.length).toBeLessThan(32);
    payloads.forEach(() => io.writes.queueSuccess());
    // Start immediately: the first waiter precedes the click. Each awaited
    // result arms the next waiter before the sequential app sends another write.
    const collected = (async () => {
      const writes: CharacteristicWrite[] = [];
      while (writes.length < payloads.length) {
        writes.push(await io.waitForWrite());
      }
      return writes;
    })();
    const promptPromise = bluetooth.waitForDevicePrompt();
    await page
      .getByRole('button', { name: 'Send ordered burst', exact: true })
      .click();
    await (await promptPromise).select(peripheral);
    expect(await collected).toEqual(
      payloads.map((payload) => ({
        data: bytes(payload),
        writeType: 'with-response',
      })),
    );
    await expect(page.getByTestId('status')).toHaveText('burst-written');
    await expect(page.getByTestId('burst-completed')).toHaveText('5');
    const writes = io
      .operations()
      .filter(({ request }) => request.type === 'write');
    expect(writes).toHaveLength(payloads.length);
    expect(writes.map(({ request }) => request)).toEqual(
      payloads.map((payload) => ({
        type: 'write',
        writeType: 'with-response',
        data: bytes(payload),
      })),
    );
    let previousSequence = -1;
    for (const write of writes) {
      expect(write.response).toEqual({ type: 'write', result: 'success' });
      expect(write.responseSource).toBe('queued');
      expect(write.responseDelivery).toBe('succeeded');
      expect(write.sequence).toBeGreaterThan(previousSequence);
      previousSequence = write.sequence;
    }
  });

  test('R6: recovers from one characteristic failure on the same connection', async ({
    bluetooth,
    page,
  }) => {
    await page.goto(application.url);
    const { peripheral, io } = await createProbePeripheral(bluetooth);
    const descriptor = io.descriptor(ioDescriptorUuid);
    io.reads.queueError('unlikely-error');
    descriptor.reads.queue(bytes([42, 0, 255]));
    const promptPromise = bluetooth.waitForDevicePrompt();
    await page
      .getByRole('button', { name: 'Read both characteristics' })
      .click();
    await (await promptPromise).select(peripheral);
    await expect(page.getByTestId('status')).toHaveText('operation-error');
    await expect(page.getByTestId('error-name')).toHaveText(
      'NotSupportedError',
    );
    expect(descriptor.operations()).toEqual([]);
    await page
      .getByRole('button', { name: 'Read descriptor', exact: true })
      .click();
    await expect(page.getByTestId('status')).toHaveText('descriptor-read');
    await expect(page.getByTestId('descriptor-read')).toHaveText('42,0,255');
    await expect(page.getByTestId('error-name')).toHaveText('--');
    expect(io.operations()).toEqual([
      expect.objectContaining({
        request: { type: 'read' },
        response: { type: 'read', result: 'error', error: 'unlikely-error' },
        responseSource: 'queued',
        responseDelivery: 'succeeded',
      }),
    ]);
    expect(descriptor.operations()).toEqual([
      expect.objectContaining({
        request: { type: 'read' },
        response: {
          type: 'read',
          result: 'success',
          data: bytes([42, 0, 255]),
        },
        responseSource: 'queued',
        responseDelivery: 'succeeded',
      }),
    ]);
    expect(
      peripheral
        .operations()
        .filter(({ request }) => request.type === 'connection'),
    ).toHaveLength(1);
  });
});
