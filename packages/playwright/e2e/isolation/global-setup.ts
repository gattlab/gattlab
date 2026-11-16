import process from 'node:process';
import { rm } from 'node:fs/promises';

import { chromium } from '@playwright/test';

import {
  rendezvousDirectory,
  sharedBrowserEndpoint,
  sharedBrowserPath,
  sharedBrowserPort,
} from './constants.js';

export default async function globalSetup(): Promise<() => Promise<void>> {
  await rm(rendezvousDirectory, { force: true, recursive: true });
  const server = await chromium.launchServer({
    headless: true,
    host: '127.0.0.1',
    port: sharedBrowserPort,
    wsPath: sharedBrowserPath,
    args:
      process.platform === 'linux' ? ['--enable-features=WebBluetooth'] : [],
  });
  if (server.wsEndpoint() !== sharedBrowserEndpoint) {
    await server.close();
    throw new Error(
      `Expected shared browser endpoint ${sharedBrowserEndpoint}, received ${server.wsEndpoint()}.`,
    );
  }

  return async (): Promise<void> => {
    await server.close();
  };
}
