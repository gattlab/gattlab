import type { Page } from '@playwright/test';

import {
  applicationCharacteristicUuid,
  applicationServiceUuid,
} from '../support/application-server.js';
import { bytes, expect, test } from './fixtures.js';
import { countRendezvous, markRendezvous } from './rendezvous.js';

interface ApplicationState {
  readonly outcome: string;
  readonly battery?: number;
}

const cases = [
  { label: 'alpha', value: 41 },
  { label: 'beta', value: 82 },
] as const;

test.describe.configure({ mode: 'parallel' });

for (const testCase of cases) {
  test(`keeps the ${testCase.label} worker lab independent`, async ({
    applicationUrl,
    bluetooth,
    page,
  }, testInfo) => {
    const scope = `parallel-${String(testInfo.repeatEachIndex)}`;
    await page.goto(applicationUrl);
    const sensor = await bluetooth.createPeripheral({
      address: '50:50:50:50:50:50',
      name: 'Same worker sensor',
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
    characteristic.reads.queue(bytes([testCase.value]));
    if (testCase.label === 'beta') {
      await expect
        .poll(() => countRendezvous(scope, 'alpha-about-to-wait'))
        .toBe(1);
      await bluetooth.adapter.setState('powered-off');
      await bluetooth.adapter.setState('powered-on');
    } else {
      await markRendezvous(scope, 'alpha-about-to-wait');
    }

    await markRendezvous(scope, `active-${testCase.label}`);
    await expect
      .poll(() => countRendezvous(scope, 'active-'))
      .toBe(cases.length);
    expect(await countRendezvous(scope, 'active-')).toBe(cases.length);

    const promptPromise = bluetooth.waitForDevicePrompt();
    await page
      .getByRole('button', { name: 'Connect and read fixture sensor' })
      .click();
    const prompt = await promptPromise;
    expect(prompt.devices).toEqual([{ id: sensor.address, name: '' }]);
    await prompt.select(sensor);

    await expect(page.getByTestId('battery')).toHaveText(
      `${String(testCase.value)}%`,
    );
    await characteristic.expectRead();
    expect(await readApplicationState(page)).toMatchObject({
      outcome: 'read',
      battery: testCase.value,
    });
    expect(characteristic.operations()).toHaveLength(1);
    expect(
      sensor
        .operations()
        .filter(({ request }) => request.type === 'connection'),
    ).toHaveLength(1);
  });
}

function readApplicationState(page: Page): Promise<ApplicationState> {
  return page.evaluate(() => {
    return (
      globalThis as unknown as {
        readonly fixtureState: ApplicationState;
      }
    ).fixtureState;
  });
}
