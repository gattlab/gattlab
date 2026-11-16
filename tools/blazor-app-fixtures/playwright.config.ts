import process from 'node:process';
import { defineConfig } from '@playwright/test';
import type { GattLabFixtureOptions } from '@gattlab/playwright';

export default defineConfig<{ gattlab: GattLabFixtureOptions }>({
  testDir: './tests',
  testMatch: '**/*.spec.ts',
  forbidOnly: true,
  fullyParallel: false,
  retries: 0,
  workers: 1,
  outputDir: './test-results',
  projects: [
    {
      name: 'chromium',
      use: {
        browserName: 'chromium',
        headless: true,
        gattlab: {
          artifacts: 'retain-on-failure',
          operationTimeoutMs: 5_000,
          promptTimeoutMs: 5_000,
          teardownTimeoutMs: 5_000,
        },
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
