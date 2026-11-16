import process from 'node:process';

import { defineConfig } from '@playwright/test';

import type { GattLabOptionFixtures } from './src/fixtures.js';

export default defineConfig<GattLabOptionFixtures>({
  testDir: './e2e',
  testMatch: '**/*.spec.ts',
  testIgnore: 'isolation/**/*.spec.ts',
  forbidOnly: true,
  fullyParallel: false,
  retries: 0,
  workers: 1,
  projects: [
    {
      name: 'chromium',
      use: {
        browserName: 'chromium',
        gattlab: { operationTimeoutMs: 6_101 },
        launchOptions: {
          args:
            process.platform === 'linux'
              ? ['--enable-features=WebBluetooth']
              : [],
        },
      },
    },
  ],
});
