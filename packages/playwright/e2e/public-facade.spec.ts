import type { Page } from '@playwright/test';

import { bytes } from '../src/index.js';
import { expect, publicTest as test } from './fixtures.js';
import {
  applicationCharacteristicUuid,
  applicationServiceUuid,
  duplicateNameCharacteristicUuid,
  duplicateNameServiceUuid,
} from './support/application-server.js';

interface ApplicationState {
  readonly outcome:
    'idle' | 'pending' | 'selected' | 'cancelled' | 'read' | 'failed';
  readonly battery?: number;
  readonly deviceName?: string;
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

test.describe.serial('public BluetoothLab facade', () => {
  test('receives the fixture on about:blank without eager startup', async ({
    bluetooth,
    page,
  }) => {
    expect(page.url()).toBe('about:blank');
    expect(bluetooth.adapter).toBeDefined();
    await bluetooth.dispose();
    expect(page.isClosed()).toBe(false);
  });

  test('lazily controls the adapter and cancels a real chooser', async ({
    applicationUrl,
    bluetooth,
    page,
  }) => {
    await page.goto(applicationUrl);
    await bluetooth.adapter.setState('powered-off');
    await bluetooth.adapter.setState('powered-on');

    const promptPromise = bluetooth.waitForDevicePrompt();
    await page.getByRole('button', { name: 'Choose fixture sensor' }).click();
    const prompt = await promptPromise;

    expect(prompt.devices).toEqual([]);
    expect(Object.isFrozen(prompt.devices)).toBe(true);
    expect(prompt.settled).toBe(false);
    await prompt.cancel();
    expect(prompt.settled).toBe(true);
    await expect
      .poll(() => readApplicationState(page))
      .toEqual({ outcome: 'cancelled', errorName: 'NotFoundError' });
  });

  test('disposes a live lab early without closing the consumer page', async ({
    applicationUrl,
    bluetooth,
    page,
  }) => {
    await page.goto(applicationUrl);
    await bluetooth.adapter.setState('powered-on');

    await bluetooth.dispose();
    await bluetooth.dispose();

    expect(page.isClosed()).toBe(false);
    await expect(
      bluetooth.adapter.setState('powered-off'),
    ).rejects.toMatchObject({ code: 'BLUETOOTH_BACKEND_STOPPED' });
  });

  test('runs the public chooser, connection, discovery, and read journey', async ({
    applicationUrl,
    bluetooth,
    page,
  }) => {
    await page.goto(applicationUrl);
    const sensor = await bluetooth.createPeripheral({
      address: '09:09:09:09:09:09',
      name: 'Battery Sensor',
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
    const batteryLevel = sensor.characteristic(
      applicationServiceUuid,
      applicationCharacteristicUuid,
    );
    batteryLevel.reads.queue(bytes([87]));

    const promptPromise = bluetooth.waitForDevicePrompt();
    await page
      .getByRole('button', { name: 'Connect and read fixture sensor' })
      .click();
    await (await promptPromise).select(sensor);

    await expect(page.getByTestId('battery')).toHaveText('87%');
    await batteryLevel.expectRead();
    expect(batteryLevel.operations()).toMatchObject([
      {
        request: { type: 'read' },
        response: { type: 'read', result: 'success', data: bytes([87]) },
        responseSource: 'queued',
        responseDelivery: 'succeeded',
      },
    ]);
    expect(sensor.operations().length).toBeGreaterThanOrEqual(2);
  });

  test('selects duplicate names by address and rejects stale candidates before mutation', async ({
    applicationUrl,
    bluetooth,
    page,
  }) => {
    await page.goto(applicationUrl);
    const sharedName = 'Duplicate Sensor';
    const first = await bluetooth.createPeripheral({
      address: '09:09:09:09:09:11',
      name: sharedName,
      services: [{ uuid: applicationServiceUuid, characteristics: [] }],
    });
    const second = await bluetooth.createPeripheral({
      address: '09:09:09:09:09:12',
      name: sharedName,
      services: [
        { uuid: applicationServiceUuid, characteristics: [] },
        {
          uuid: duplicateNameServiceUuid,
          characteristics: [
            {
              uuid: duplicateNameCharacteristicUuid,
              properties: ['read'],
            },
          ],
        },
      ],
    });
    const selectedValue = second.characteristic(
      duplicateNameServiceUuid,
      duplicateNameCharacteristicUuid,
    );
    selectedValue.reads.queue(bytes([62]));

    await expect(
      bluetooth.createPeripheral({
        address: '09:09:09:09:09:11',
        name: 'Duplicate address',
      }),
    ).rejects.toMatchObject({
      code: 'BLUETOOTH_PERIPHERAL_ALREADY_REGISTERED',
    });

    const promptPromise = bluetooth.waitForDevicePrompt();
    await page
      .getByRole('button', { name: 'Connect duplicate sensor' })
      .click();
    const prompt = await promptPromise;
    await expect
      .poll(() => prompt.devices)
      .toEqual([
        { id: first.address, name: '' },
        { id: second.address, name: '' },
      ]);

    await expect(
      prompt.select({ address: '09:09:09:09:09:99' } as never),
    ).rejects.toMatchObject({ code: 'BLUETOOTH_PROMPT_DEVICE_NOT_FOUND' });
    expect(prompt.settled).toBe(false);
    await prompt.select(second);

    await expect(page.getByTestId('duplicate-name')).toHaveText(sharedName);
    await expect(page.getByTestId('duplicate-value')).toHaveText('62');
    await selectedValue.expectRead();
    expect(first.operations()).toEqual([]);
    expect(second.operations().length).toBeGreaterThanOrEqual(2);
  });

  test('reacquires the process lease after the previous fixture teardown', async ({
    applicationUrl,
    bluetooth,
    page,
  }) => {
    await page.goto(applicationUrl);
    await bluetooth.adapter.setState('powered-on');
    expect(page.isClosed()).toBe(false);
  });
});
