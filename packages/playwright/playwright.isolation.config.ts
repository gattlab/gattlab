import process from 'node:process';

import { defineConfig } from '@playwright/test';

import type { GattLabOptionFixtures } from './src/fixtures.js';
import { sharedBrowserEndpoint } from './e2e/isolation/constants.js';

const launchOptions = {
  args: process.platform === 'linux' ? ['--enable-features=WebBluetooth'] : [],
};
const sharedBrowserUse = {
  browserName: 'chromium' as const,
  connectOptions: { wsEndpoint: sharedBrowserEndpoint },
  gattlab: { artifacts: 'always' as const },
};

export default defineConfig<GattLabOptionFixtures>({
  testDir: './e2e/isolation',
  testMatch: '**/*.spec.ts',
  globalSetup: './e2e/isolation/global-setup.ts',
  outputDir: '../../test-results/isolation',
  reporter: [['line'], ['./e2e/isolation/diagnostics-reporter.ts']],
  forbidOnly: true,
  fullyParallel: true,
  retries: 0,
  workers: 2,
  projects: [
    {
      name: 'parallel-workers',
      testMatch: 'parallel-workers.spec.ts',
      use: { browserName: 'chromium', launchOptions },
    },
    {
      name: 'shared-browser-conflict',
      testMatch: 'shared-browser-conflict.spec.ts',
      use: sharedBrowserUse,
    },
    {
      name: 'shared-browser-reuse',
      testMatch: 'shared-browser-reuse.spec.ts',
      dependencies: ['shared-browser-conflict'],
      use: sharedBrowserUse,
    },
    {
      name: 'uncontrolled-pages',
      testMatch: 'uncontrolled-pages.spec.ts',
      fullyParallel: false,
      use: {
        browserName: 'chromium',
        launchOptions,
        gattlab: { promptTimeoutMs: 500 },
      },
    },
  ],
});
