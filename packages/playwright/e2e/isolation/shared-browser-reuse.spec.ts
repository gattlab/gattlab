import { expect, test } from './fixtures.js';
import {
  releaseRendezvousLock,
  tryAcquireRendezvousLock,
} from './rendezvous.js';

test('reuses the shared browser cleanly after the holder teardown', async ({
  applicationUrl,
  bluetooth,
  page,
}) => {
  await expect.poll(() => tryAcquireRendezvousLock('shared-reuse')).toBe(true);
  try {
    await page.goto(applicationUrl);
    await bluetooth.adapter.setState('powered-on');

    const promptPromise = bluetooth.waitForDevicePrompt();
    await page.getByRole('button', { name: 'Choose fixture sensor' }).click();
    const prompt = await promptPromise;
    expect(prompt.devices).toEqual([]);
    await prompt.cancel();
  } finally {
    await bluetooth.dispose();
    await releaseRendezvousLock('shared-reuse');
  }
});
