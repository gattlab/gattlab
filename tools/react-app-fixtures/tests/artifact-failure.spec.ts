import { bytes, expect, test } from '@gattlab/playwright';
import {
  createProbePeripheral,
  startApplication,
  stopApplication,
} from './probe-support.js';

let application: Awaited<ReturnType<typeof startApplication>>;
test.beforeAll(async () => {
  application = await startApplication('production');
});
test.afterAll(async () => {
  if (application !== undefined) await stopApplication(application);
});

test('intentional-react-mismatch: preserves the original wrong rendered value and redacted artifacts', async ({
  bluetooth,
  page,
}) => {
  await page.goto(application.url);
  await expect(page.getByTestId('status')).toHaveText('app-ready');
  const { peripheral, io } = await createProbePeripheral(bluetooth);
  io.reads.queue(bytes([73]));
  const read = io.expectRead();
  const write = io.waitForWrite();
  const prompted = bluetooth.waitForDevicePrompt();
  await page.locator('#connect').click();
  await (await prompted).select(peripheral);
  await Promise.all([read, write]);
  await expect(page.getByTestId('status')).toHaveText('ready');
  await expect(
    page.getByTestId('battery'),
    'intentional-react-mismatch',
  ).toHaveText('74%', { timeout: 250 });
});
