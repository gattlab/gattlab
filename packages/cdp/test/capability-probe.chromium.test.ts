import { createServer, type Server } from 'node:http';
import process from 'node:process';

import { BluetoothCapabilityUnsupportedError } from '@gattlab/core';
import { chromium, type Page } from 'playwright';
import { describe, expect, it } from 'vitest';

import {
  CdpCapabilityProbe,
  type WebBluetoothEnvironment,
} from '../src/capability-probe.js';
import { createCdpTransport } from '../src/transport.js';

interface ApplicationServer {
  readonly server: Server;
  readonly url: string;
}

function startApplicationServer(): Promise<ApplicationServer> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><title>GattLab capability probe</title>');
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new TypeError('Expected a TCP application server address.'));
        return;
      }
      resolve({ server, url: `http://127.0.0.1:${address.port}` });
    });
  });
}

function closeApplicationServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) resolve();
      else reject(error);
    });
  });
}

function inspectWebBluetoothEnvironment(
  page: Page,
): Promise<WebBluetoothEnvironment> {
  return page.evaluate(() => ({
    secureContext: globalThis.isSecureContext,
    navigatorBluetooth: 'bluetooth' in globalThis.navigator,
  }));
}

describe('CdpCapabilityProbe real Chromium contract', () => {
  it('detects the pinned capability set and leaves both domains reusable', async () => {
    const application = await startApplicationServer();
    const browser = await chromium.launch({
      headless: true,
      ...(process.platform === 'linux'
        ? { args: ['--enable-features=WebBluetooth'] }
        : {}),
    });
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(application.url);
    const rawPageSession = await context.newCDPSession(page);
    const rawBrowserSession = await browser.newBrowserCDPSession();
    const browserTransport = createCdpTransport('browser', rawBrowserSession);
    const pageTransport = createCdpTransport('page', rawPageSession);
    let bluetoothEmulationEnabled = false;
    let deviceAccessEnabled = false;

    try {
      const capabilities = await new CdpCapabilityProbe({
        browserName: 'chromium',
        browserTransport,
        pageTransport,
        inspectWebBluetoothEnvironment: () =>
          inspectWebBluetoothEnvironment(page),
      }).probe();

      expect(capabilities.browserProduct).toBe('HeadlessChrome/159.0.8154.6');
      expect(capabilities.browserVersion).toBe('159.0.8154.6');
      expect(capabilities.protocolVersion).toBe('1.3');
      expect(capabilities.domains).toEqual({
        bluetoothEmulation: true,
        deviceAccess: true,
      });
      expect(capabilities.operations.secondaryServices).toBe(false);
      expect(capabilities.operations.nativeNotificationPayload).toBe(false);

      await browserTransport.send('BluetoothEmulation.enable', {
        state: 'powered-on',
        leSupported: true,
      });
      bluetoothEmulationEnabled = true;
      await pageTransport.send('DeviceAccess.enable');
      deviceAccessEnabled = true;
    } finally {
      if (deviceAccessEnabled) {
        await pageTransport.send('DeviceAccess.disable');
      }
      if (bluetoothEmulationEnabled) {
        await browserTransport.send('BluetoothEmulation.disable');
      }
      await pageTransport.detach();
      await browserTransport.detach();
      await context.close();
      await browser.close();
      await closeApplicationServer(application.server);
    }
  });

  it('reports the Linux launch argument when the feature is not enabled', async () => {
    if (process.platform !== 'linux') return;

    const application = await startApplicationServer();
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(application.url);
    const rawPageSession = await context.newCDPSession(page);
    const rawBrowserSession = await browser.newBrowserCDPSession();
    const browserTransport = createCdpTransport('browser', rawBrowserSession);
    const pageTransport = createCdpTransport('page', rawPageSession);

    try {
      await expect(
        new CdpCapabilityProbe({
          browserName: 'chromium',
          browserTransport,
          pageTransport,
          inspectWebBluetoothEnvironment: () =>
            inspectWebBluetoothEnvironment(page),
        }).probe(),
      ).rejects.toMatchObject({
        code: 'BLUETOOTH_CAPABILITY_UNSUPPORTED',
        context: {
          capability: 'navigator.bluetooth',
          launchArgument: '--enable-features=WebBluetooth',
        },
      } satisfies Partial<BluetoothCapabilityUnsupportedError>);
    } finally {
      await pageTransport.detach();
      await browserTransport.detach();
      await context.close();
      await browser.close();
      await closeApplicationServer(application.server);
    }
  });
});
