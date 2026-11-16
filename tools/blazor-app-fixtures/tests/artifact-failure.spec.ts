import { expect, test } from '@gattlab/playwright';

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

test('6: preserves the original failing Razor assertion and redacted artifacts', async ({
  bluetooth,
  page,
}) => {
  await page.goto(application.url);
  await expect(page.getByTestId('app-ready')).toHaveText('ready');
  await createProbePeripheral(bluetooth);

  await expect(page.getByTestId('status')).toHaveText(
    'intentional-blazor-mismatch',
    { timeout: 250 },
  );
});
