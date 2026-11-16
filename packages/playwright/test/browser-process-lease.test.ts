import { BluetoothLabAlreadyActiveError } from '@gattlab/core';
import type { Browser } from '@playwright/test';
import { describe, expect, it } from 'vitest';

import { acquireBrowserProcessLease } from '../src/browser-process-lease.js';

function browserIdentity(): Browser {
  return Object.freeze({}) as Browser;
}

describe('browser-process lease', () => {
  it('rejects a concurrent lease for the same Browser with stable context', async () => {
    const browser = browserIdentity();
    const lease = acquireBrowserProcessLease(browser);

    let conflict: unknown;
    try {
      acquireBrowserProcessLease(browser);
    } catch (cause) {
      conflict = cause;
    }

    expect(conflict).toBeInstanceOf(BluetoothLabAlreadyActiveError);
    expect((conflict as BluetoothLabAlreadyActiveError).context).toEqual({
      leaseScope: 'browser-process',
      remediation: 'use-separate-browser-process',
      detection: 'in-process-lease',
    });
    expect((conflict as Error).message).toMatch(/worker|browser process/u);
    await lease.release();
  });

  it('allows independent Browser objects and sequential reacquisition', async () => {
    const firstBrowser = browserIdentity();
    const secondBrowser = browserIdentity();
    const first = acquireBrowserProcessLease(firstBrowser);
    const second = acquireBrowserProcessLease(secondBrowser);

    await first.release();
    const reacquired = acquireBrowserProcessLease(firstBrowser);

    await Promise.all([second.release(), reacquired.release()]);
  });

  it('makes repeated and stale release harmless to a newer owner', async () => {
    const browser = browserIdentity();
    const oldLease = acquireBrowserProcessLease(browser);
    await oldLease.release();
    const currentLease = acquireBrowserProcessLease(browser);

    await oldLease.release();
    expect(() => acquireBrowserProcessLease(browser)).toThrow(
      BluetoothLabAlreadyActiveError,
    );

    await currentLease.release();
    const finalLease = acquireBrowserProcessLease(browser);
    await finalLease.release();
  });
});
