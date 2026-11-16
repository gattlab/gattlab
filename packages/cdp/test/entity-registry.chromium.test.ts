import process from 'node:process';

import { validatePeripheralDefinition } from '@gattlab/core';
import type { BrowserContext } from 'playwright';
import { chromium } from 'playwright';
import { describe, expect, it } from 'vitest';

import { CdpEntityRegistry } from '../src/entity-registry.js';
import { createCdpTransport } from '../src/transport.js';

describe('CdpEntityRegistry real Chromium contract', () => {
  it('constructs and indexes a complete hierarchy on the pinned browser', async () => {
    const definition = validatePeripheralDefinition({
      address: '00:11:22:33:44:55',
      name: 'Registry contract sensor',
      manufacturerData: [{ companyId: 0x1234, data: [1, 2, 3, 4] }],
      advertisement: {
        rssi: -45,
        manufacturerData: [{ companyId: 0x004c, data: [0x10, 0x20, 0x30] }],
      },
      services: [
        {
          uuid: '180f',
          characteristics: [
            {
              uuid: '2a19',
              properties: ['read', 'write', 'notify'],
              descriptors: [{ uuid: '2902' }],
            },
          ],
        },
      ],
    });
    if (!definition.success) throw new Error('Expected a valid fixture.');

    const browser = await chromium.launch({
      headless: true,
      ...(process.platform === 'linux'
        ? { args: ['--enable-features=WebBluetooth'] }
        : {}),
    });
    const rawBrowserSession = await browser.newBrowserCDPSession();
    const transport = createCdpTransport('browser', rawBrowserSession);
    const registry = new CdpEntityRegistry(transport);
    let context: BrowserContext | undefined;
    let pageTransport:
      ReturnType<typeof createCdpTransport<'page'>> | undefined;
    let enabled = false;
    let deviceAccessEnabled = false;

    try {
      await transport.send('BluetoothEmulation.enable', {
        state: 'powered-on',
        leSupported: true,
      });
      enabled = true;
      context = await browser.newContext();
      const page = await context.newPage();
      const rawPageSession = await context.newCDPSession(page);
      pageTransport = createCdpTransport('page', rawPageSession);
      await pageTransport.send('DeviceAccess.enable');
      deviceAccessEnabled = true;
      const hierarchyIdentity = await registry.addPeripheralHierarchy(
        definition.value,
      );
      const advertisementIdentity = await registry.simulateAdvertisement(
        definition.value.address,
      );
      const preconnectedIdentity = await registry.createPreconnectedPeripheral(
        definition.value.address,
      );

      expect(registry.size).toBe(1);
      expect(registry.requiresReset).toBe(false);
      expect(hierarchyIdentity).toBe('created');
      expect(advertisementIdentity).toBe('existing');
      expect(preconnectedIdentity).toBe('existing');
      expect(registry.getPeripheral(definition.value.address)).toBe(
        definition.value,
      );

      await pageTransport.send('DeviceAccess.disable');
      deviceAccessEnabled = false;
      await transport.send('BluetoothEmulation.disable');
      enabled = false;
      registry.resetAfterDomainDisable();
      expect(registry.size).toBe(0);

      await transport.send('BluetoothEmulation.enable', {
        state: 'powered-on',
        leSupported: true,
      });
      enabled = true;
      await expect(
        registry.addPeripheralHierarchy(definition.value),
      ).resolves.toBe('created');
      expect(registry.size).toBe(1);
    } finally {
      if (deviceAccessEnabled && pageTransport !== undefined) {
        await pageTransport.send('DeviceAccess.disable');
      }
      if (enabled) {
        await transport.send('BluetoothEmulation.disable');
        registry.resetAfterDomainDisable();
      }
      if (pageTransport !== undefined) await pageTransport.detach();
      await transport.detach();
      if (context !== undefined) await context.close();
      await browser.close();
    }
  });
});
