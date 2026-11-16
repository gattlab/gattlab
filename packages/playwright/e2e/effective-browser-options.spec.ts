import process from 'node:process';

import { chromium } from '@playwright/test';

import { expect, test } from './fixtures.js';

const customExecutable = chromium.executablePath();

test.use({
  launchOptions: {
    executablePath: customExecutable,
    args:
      process.platform === 'linux' ? ['--enable-features=WebBluetooth'] : [],
  },
});

test('classifies an effective test.use custom executable as unverified', async ({
  applicationUrl,
  page,
  _gattlabDiagnostics,
  _gattlabRuntime,
}) => {
  await page.goto(applicationUrl);
  await _gattlabRuntime.start();

  const compatibility =
    _gattlabDiagnostics.snapshot().capabilityDiagnostics?.compatibility;
  expect(compatibility).toMatchObject({
    status: 'unverified',
    mismatches: expect.arrayContaining(['custom-executable']),
    observed: {
      customExecutable: true,
      connection: 'launch',
    },
  });
  expect(JSON.stringify(compatibility)).not.toContain(customExecutable);
});
