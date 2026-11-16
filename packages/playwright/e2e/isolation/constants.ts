import { fileURLToPath } from 'node:url';

export const sharedBrowserPort = 35_505;
export const sharedBrowserPath = '/gattlab-isolation';
export const sharedBrowserEndpoint = `ws://127.0.0.1:${String(sharedBrowserPort)}${sharedBrowserPath}`;
export const rendezvousDirectory = fileURLToPath(
  new URL('../../../../../test-results/isolation-rendezvous/', import.meta.url),
);
