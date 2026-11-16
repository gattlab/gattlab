import { expect } from '@playwright/test';

import { gattLabBaseTest } from '../src/fixtures.js';
import { test as gattLabPublicTest } from '../src/index.js';
import {
  startApplicationServer,
  stopApplicationServer,
} from './support/application-server.js';

interface ApplicationWorkerFixtures {
  readonly applicationUrl: string;
}

export const test = gattLabBaseTest.extend<object, ApplicationWorkerFixtures>({
  applicationUrl: [
    async ({}, use): Promise<void> => {
      const application = await startApplicationServer();
      try {
        await use(application.url);
      } finally {
        await stopApplicationServer(application.server);
      }
    },
    { scope: 'worker' },
  ],
});

export const publicTest = gattLabPublicTest.extend<
  object,
  ApplicationWorkerFixtures
>({
  applicationUrl: [
    async ({}, use): Promise<void> => {
      const application = await startApplicationServer();
      try {
        await use(application.url);
      } finally {
        await stopApplicationServer(application.server);
      }
    },
    { scope: 'worker' },
  ],
});

export { expect };
