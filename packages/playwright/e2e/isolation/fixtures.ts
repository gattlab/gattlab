import { bytes, expect, test as publicTest } from '../../src/index.js';
import {
  startApplicationServer,
  stopApplicationServer,
} from '../support/application-server.js';

interface ApplicationWorkerFixtures {
  readonly applicationUrl: string;
}

export const test = publicTest.extend<object, ApplicationWorkerFixtures>({
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

export { bytes, expect };
