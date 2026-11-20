import type { Page } from '@playwright/test';

import type { BluetoothLab, PeripheralHandle } from '../src/index.js';
import { expect, publicTest as test } from './fixtures.js';

const service = 'battery_service';
const application = `<!doctype html>
<button type="button">Connect</button>
<output data-testid="status" data-disconnects="0">idle</output>
<output data-testid="battery">--</output>
<script>
  const button = document.querySelector('button');
  const status = document.querySelector('output');
  button.onclick = async () => {
    let timer;
    let device;
    try {
      device = await navigator.bluetooth.requestDevice({
        filters: [{ services: ['${service}'] }],
      });
      device.addEventListener('gattserverdisconnected', () => {
        status.dataset.disconnects = String(Number(status.dataset.disconnects) + 1);
        status.textContent = 'disconnected';
      }, { once: true });
      const connecting = device.gatt.connect();
      status.textContent = 'connecting';
      const timeoutMs = Number(button.dataset.timeout);
      if (timeoutMs > 0) {
        await Promise.race([connecting, new Promise((_, reject) => {
          timer = setTimeout(() => reject(new DOMException('App timeout', 'TimeoutError')), timeoutMs);
        })]);
      } else {
        await connecting;
      }
      const service = await device.gatt.getPrimaryService('battery_service');
      const characteristic = await service.getCharacteristic('battery_level');
      const battery = (await characteristic.readValue()).getUint8(0);
      document.querySelector('[data-testid="battery"]').textContent = String(battery);
      status.textContent = 'ready';
    } catch (error) {
      status.dataset.connected = String(device?.gatt.connected);
      status.textContent = error.name;
    } finally {
      clearTimeout(timer);
    }
  };
</script>`;

async function setup(page: Page, url: string, bluetooth: BluetoothLab) {
  await page.route(url, (route) =>
    route.fulfill({ contentType: 'text/html', body: application }),
  );
  await page.goto(url);
  return bluetooth.createPreconnectedPeripheral({
    address: '70:80:00:00:00:01',
    name: 'Connection sensor',
    advertisement: { rssi: -40 },
    services: [
      {
        uuid: '180f',
        characteristics: [
          { uuid: '2a19', properties: ['read'], initialValue: [73] },
        ],
      },
    ],
  });
}

async function connect(
  page: Page,
  bluetooth: BluetoothLab,
  peripheral: PeripheralHandle,
  advertise = false,
) {
  const prompted = bluetooth.waitForDevicePrompt();
  await page.getByRole('button', { name: 'Connect' }).click();
  const prompt = await prompted;
  if (advertise) await peripheral.advertise();
  await prompt.select(peripheral);
}

test('held GATT connection resumes an application reconnect', async ({
  page,
  applicationUrl,
  bluetooth,
}) => {
  const peripheral = await setup(page, applicationUrl, bluetooth);
  const status = page.getByTestId('status');
  const battery = page.getByTestId('battery');
  const characteristic = peripheral.characteristic('180f', '2a19');
  characteristic.reads.queue([73]);
  characteristic.reads.queue([42]);
  await connect(page, bluetooth, peripheral);
  await expect(status).toHaveText('ready');
  await expect(battery).toHaveText('73');
  await peripheral.disconnect();
  await expect(status).toHaveText('disconnected');

  const held = peripheral.connection.holdNext();
  await connect(page, bluetooth, peripheral, true);
  await held.waitForRequest();
  await expect(status).toHaveText('connecting');
  await expect(battery).toHaveText('73');
  expect(
    peripheral
      .operations()
      .filter(({ request }) => request.type === 'connection'),
  ).toHaveLength(1);
  expect(characteristic.operations()).toHaveLength(1);
  await held.resume();
  await expect(status).toHaveText('ready');
  await expect(battery).toHaveText('42');
  expect(
    peripheral
      .operations()
      .filter(({ request }) => request.type === 'connection'),
  ).toMatchObject([
    { responseSource: 'default', responseDelivery: 'succeeded' },
    { responseSource: 'queued', responseDelivery: 'succeeded' },
  ]);
});

test('held GATT connection fails natively when the device disconnects', async ({
  page,
  applicationUrl,
  bluetooth,
}) => {
  const peripheral = await setup(page, applicationUrl, bluetooth);
  const status = page.getByTestId('status');
  await connect(page, bluetooth, peripheral);
  await expect(status).toHaveText('ready');
  await peripheral.disconnect();
  await expect(status).toHaveText('disconnected');

  const held = peripheral.connection.holdNext();
  await connect(page, bluetooth, peripheral, true);
  await held.waitForRequest();
  await peripheral.disconnect();

  await expect(status).toHaveText('NetworkError');
  await expect(status).toHaveAttribute('data-connected', 'false');
  await expect(status).toHaveAttribute('data-disconnects', '1');
  await expect(held.resume()).rejects.toMatchObject({
    code: 'BLUETOOTH_CANCELLED',
  });
  expect(
    peripheral
      .operations()
      .filter(({ request }) => request.type === 'connection'),
  ).toMatchObject([
    { responseSource: 'default', responseDelivery: 'succeeded' },
    { responseSource: 'queued', responseDelivery: 'failed' },
  ]);
});

test('held GATT connection lets the application show its own timeout', async ({
  page,
  applicationUrl,
  bluetooth,
}) => {
  const peripheral = await setup(page, applicationUrl, bluetooth);
  await page.clock.install();
  await page.getByRole('button', { name: 'Connect' }).evaluate((button) => {
    button.setAttribute('data-timeout', '30000');
  });
  const held = peripheral.connection.holdNext();
  await connect(page, bluetooth, peripheral);
  await held.waitForRequest();
  await expect(page.getByTestId('status')).toHaveText('connecting');
  await page.clock.fastForward(30_000);
  await expect(page.getByTestId('status')).toHaveText('TimeoutError');
  expect(peripheral.operations()).toEqual([]);
});
