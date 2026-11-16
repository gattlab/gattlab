import { BluetoothLabAlreadyActiveError } from '@gattlab/core';
import type { Browser } from '@playwright/test';

export interface BrowserProcessLease {
  release(): Promise<void>;
}

const activeLeases = new WeakMap<Browser, symbol>();

/** Acquires the single GattLab lease allowed for a Playwright browser process. */
export function acquireBrowserProcessLease(
  browser: Browser,
): BrowserProcessLease {
  if (activeLeases.has(browser)) {
    throw new BluetoothLabAlreadyActiveError(
      'A GattLab runtime is already active in this browser process. Use a separate Playwright worker or browser process for an independent concurrent lab.',
      {
        context: {
          leaseScope: 'browser-process',
          remediation: 'use-separate-browser-process',
          detection: 'in-process-lease',
        },
      },
    );
  }

  const token = Symbol('gattlab-browser-process-lease');
  activeLeases.set(browser, token);
  let released = false;

  return Object.freeze({
    release(): Promise<void> {
      if (released) return Promise.resolve();
      released = true;
      if (activeLeases.get(browser) === token) activeLeases.delete(browser);
      return Promise.resolve();
    },
  });
}
