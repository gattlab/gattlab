import type { Page } from '@playwright/test';

import type { BluetoothLab } from '../../src/index.js';

import { applicationServiceUuid } from '../support/application-server.js';
import { expect, test } from './fixtures.js';

test('bounds an uncontrolled chooser in a second BrowserContext', async ({
  applicationUrl,
  bluetooth,
  browser,
  page,
}) => {
  await page.goto(applicationUrl);
  await bluetooth.createPeripheral({
    address: '52:52:52:52:52:52',
    name: 'Context-shared sensor',
    services: [{ uuid: applicationServiceUuid, characteristics: [] }],
  });

  const secondContext = await browser.newContext();
  try {
    const secondPage = await secondContext.newPage();
    await assertUncontrolledChooser(bluetooth, secondPage, applicationUrl);
  } finally {
    await secondContext.close();
  }
});

test('bounds an uncontrolled chooser in a second page', async ({
  applicationUrl,
  bluetooth,
  context,
  page,
}) => {
  await page.goto(applicationUrl);
  await bluetooth.createPeripheral({
    address: '53:53:53:53:53:53',
    name: 'Page-shared sensor',
    services: [{ uuid: applicationServiceUuid, characteristics: [] }],
  });

  const secondPage = await context.newPage();
  try {
    await assertUncontrolledChooser(bluetooth, secondPage, applicationUrl);
  } finally {
    await secondPage.close();
  }
});

async function assertUncontrolledChooser(
  bluetooth: BluetoothLab,
  page: Page,
  applicationUrl: string,
): Promise<void> {
  await page.goto(applicationUrl);
  expect(
    await page.evaluate(() =>
      (
        navigator as Navigator & {
          readonly bluetooth: { getAvailability(): Promise<boolean> };
        }
      ).bluetooth.getAvailability(),
    ),
  ).toBe(true);

  let promptSettled = false;
  const promptOutcome = bluetooth.waitForDevicePrompt().then(
    (prompt) => {
      promptSettled = true;
      return prompt;
    },
    (cause: unknown) => {
      promptSettled = true;
      return cause;
    },
  );
  await page.getByRole('button', { name: 'Choose fixture sensor' }).click();
  await expect.poll(() => requestsStarted(page)).toBe(1);
  expect(promptSettled).toBe(false);

  const error = await promptOutcome;
  expect(error).toMatchObject({
    name: 'BluetoothTimeoutError',
    code: 'BLUETOOTH_TIMEOUT',
    context: {
      operation: 'waitForDevicePrompt',
      operationLayer: 'playwright',
      deadlineKind: 'prompt',
      timeoutPhase: 'operation',
      detection: 'live',
      userGestureReminder: expect.stringContaining(
        'only the chooser opened by the fixture page',
      ),
    },
  });
  expect(await requestOutcome(page)).toBe('pending');
}

function requestsStarted(page: Page): Promise<number> {
  return page.evaluate(() => {
    return (globalThis as unknown as { readonly requestsStarted: number })
      .requestsStarted;
  });
}

function requestOutcome(page: Page): Promise<string> {
  return page.evaluate(() => {
    return (
      globalThis as unknown as {
        readonly fixtureState: { readonly outcome: string };
      }
    ).fixtureState.outcome;
  });
}
