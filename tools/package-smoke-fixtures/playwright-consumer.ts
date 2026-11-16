import { bytes, expect, test } from '@gattlab/playwright';

test('reads the battery level through the public package surface', async ({
  page,
  bluetooth,
}) => {
  await page.goto('http://127.0.0.1:4173/');

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
});
