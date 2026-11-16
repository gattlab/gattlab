import process from 'node:process';

import { chromium } from 'playwright';
import { describe, expect, it } from 'vitest';

import { CdpTransportError, createCdpTransport } from '../src/index.js';

describe('CdpTransport real Chromium contract', () => {
  it('routes both Bluetooth domains through their proven session targets', async () => {
    const browser = await chromium.launch({
      headless: true,
      ...(process.platform === 'linux'
        ? { args: ['--enable-features=WebBluetooth'] }
        : {}),
    });
    const context = await browser.newContext();
    const page = await context.newPage();
    const rawPageSession = await context.newCDPSession(page);
    const rawBrowserSession = await browser.newBrowserCDPSession();
    const browserTransport = createCdpTransport('browser', rawBrowserSession);
    const pageTransport = createCdpTransport('page', rawPageSession);
    let bluetoothEnabled = false;
    let deviceAccessEnabled = false;

    try {
      await browserTransport.send('BluetoothEmulation.enable', {
        state: 'powered-on',
        leSupported: true,
      });
      bluetoothEnabled = true;
      await pageTransport.send('DeviceAccess.enable');
      deviceAccessEnabled = true;

      expect(browserTransport.closed).toBe(false);
      expect(pageTransport.closed).toBe(false);

      const wrongTarget = createCdpTransport('browser', rawPageSession);
      const wrongTargetError = await wrongTarget
        .send('BluetoothEmulation.setSimulatedCentralState', {
          state: 'powered-off',
        })
        .catch((error: unknown) => error);
      expect(wrongTargetError).toMatchObject({
        name: 'CdpTransportError',
        kind: 'command-failed',
        target: 'browser',
        method: 'BluetoothEmulation.setSimulatedCentralState',
      } satisfies Partial<CdpTransportError>);
      if (!(wrongTargetError instanceof CdpTransportError)) {
        throw new TypeError('Expected a typed CDP transport error.');
      }
      expect(Object.hasOwn(wrongTargetError.cause as object, 'code')).toBe(
        false,
      );
    } finally {
      if (deviceAccessEnabled) {
        await pageTransport.send('DeviceAccess.disable');
      }
      if (bluetoothEnabled) {
        await browserTransport.send('BluetoothEmulation.disable');
      }
      await pageTransport.detach();
      await browserTransport.detach();
      await context.close();
      await browser.close();
    }
  });

  it('observes a page CDP session closed outside the transport', async () => {
    const browser = await chromium.launch({
      headless: true,
      ...(process.platform === 'linux'
        ? { args: ['--enable-features=WebBluetooth'] }
        : {}),
    });
    const context = await browser.newContext();
    const page = await context.newPage();
    const rawPageSession = await context.newCDPSession(page);
    const pageTransport = createCdpTransport('page', rawPageSession);
    let contextClosed = false;

    try {
      await context.close();
      contextClosed = true;

      expect(pageTransport.closed).toBe(true);
      await expect(
        pageTransport.send('DeviceAccess.enable'),
      ).rejects.toMatchObject({
        name: 'CdpTransportError',
        kind: 'session-closed',
        target: 'page',
        method: 'DeviceAccess.enable',
      } satisfies Partial<CdpTransportError>);
    } finally {
      if (!contextClosed) await context.close();
      await browser.close();
    }
  });
});
