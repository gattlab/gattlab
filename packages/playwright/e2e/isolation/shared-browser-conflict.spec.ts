import {
  applicationCharacteristicUuid,
  applicationServiceUuid,
} from '../support/application-server.js';
import { bytes, expect, test } from './fixtures.js';
import { countRendezvous, markRendezvous } from './rendezvous.js';

test.describe.configure({ mode: 'parallel' });

test('keeps the holder lab alive after a competing client is rejected', async ({
  applicationUrl,
  bluetooth,
  page,
}, testInfo) => {
  const scope = `shared-${String(testInfo.repeatEachIndex)}`;
  await page.goto(applicationUrl);
  const sensor = await bluetooth.createPeripheral({
    address: '51:51:51:51:51:51',
    name: 'Shared browser holder',
    services: [
      {
        uuid: applicationServiceUuid,
        characteristics: [
          {
            uuid: applicationCharacteristicUuid,
            properties: ['read'],
          },
        ],
      },
    ],
  });
  const characteristic = sensor.characteristic(
    applicationServiceUuid,
    applicationCharacteristicUuid,
  );
  characteristic.reads.queue(bytes([73]));
  await markRendezvous(scope, 'holder-active');
  await expect
    .poll(() => countRendezvous(scope, 'competitor-rejected'))
    .toBe(1);
  expect(await countRendezvous(scope, 'competitor-rejected')).toBe(1);

  const promptPromise = bluetooth.waitForDevicePrompt();
  await page
    .getByRole('button', { name: 'Connect and read fixture sensor' })
    .click();
  await (await promptPromise).select(sensor);
  await expect(page.getByTestId('battery')).toHaveText('73%');
  await characteristic.expectRead();
  await bluetooth.dispose();
});

test('reports the shared process conflict through the public fixture', async ({
  applicationUrl,
  bluetooth,
  page,
}, testInfo) => {
  const scope = `shared-${String(testInfo.repeatEachIndex)}`;
  await expect.poll(() => countRendezvous(scope, 'holder-active')).toBe(1);
  await page.goto(applicationUrl);

  const error = await bluetooth.adapter
    .setState('powered-on')
    .catch((cause: unknown) => cause);
  await markRendezvous(scope, 'competitor-rejected');

  expect(error).toMatchObject({
    name: 'BluetoothLabAlreadyActiveError',
    code: 'BLUETOOTH_LAB_ALREADY_ACTIVE',
    context: {
      leaseScope: 'browser-process',
      remediation: 'use-separate-browser-process',
      detection: 'cdp-domain-conflict',
    },
    cause: {
      name: 'CdpTransportError',
      target: 'browser',
    },
  });
});
