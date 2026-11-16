import { createServer, type Server } from 'node:http';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';

import {
  BluetoothConcurrentOperationError,
  createBluetoothTimeline,
  normalizeBluetoothAddress,
  normalizeBluetoothUuid,
  type CharacteristicReference,
} from '@gattlab/core';
import { chromium, type BrowserContext } from 'playwright';
import { describe, expect, it } from 'vitest';

import {
  PendingOperationRegistry,
  type OperationDeadlineScheduler,
} from '../src/pending-operation-registry.js';
import {
  createCdpTransport,
  type BluetoothCdpEvent,
  type CdpEventPayload,
  type CdpTarget,
  type CdpTransport,
} from '../src/transport.js';

const address = normalizeBluetoothAddress('20:20:20:20:20:01');
const serviceUuid = normalizeBluetoothUuid(
  '12345678-1234-5678-9abc-def123456900',
);
const characteristicUuid = normalizeBluetoothUuid(
  '12345678-1234-5678-9abc-def123456901',
);
const characteristic: CharacteristicReference = Object.freeze({
  kind: 'characteristic',
  address,
  serviceUuid,
  characteristicUuid,
});

const applicationHtml = `<!doctype html>
<html lang="en">
  <meta charset="utf-8">
  <title>GattLab pending registry contract</title>
  <body>
    <button id="choose" type="button">Choose registry device</button>
    <button id="connect" type="button">Connect registry device</button>
    <button id="discover" type="button">Discover registry characteristic</button>
    <button id="read-twice" type="button">Read registry characteristic twice</button>
    <script>
      window.contractState = {
        selected: false,
        connected: false,
        discovered: false,
        reads: null,
      };
      let device;
      let characteristic;

      document.querySelector('#choose').onclick = async () => {
        device = await navigator.bluetooth.requestDevice({
          filters: [{ services: ['${serviceUuid}'] }],
        });
        window.contractState.selected = true;
      };
      document.querySelector('#connect').onclick = async () => {
        await device.gatt.connect();
        window.contractState.connected = true;
      };
      document.querySelector('#discover').onclick = async () => {
        const service = await device.gatt.getPrimaryService('${serviceUuid}');
        characteristic = await service.getCharacteristic('${characteristicUuid}');
        window.contractState.discovered = true;
      };
      document.querySelector('#read-twice').onclick = async () => {
        const results = await Promise.all([
          characteristic.readValue(),
          characteristic.readValue(),
        ]);
        window.contractState.reads = results.map(value => Array.from(
          new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
        ));
      };
    </script>
  </body>
</html>`;

interface ApplicationServer {
  readonly server: Server;
  readonly url: string;
}

function startApplicationServer(): Promise<ApplicationServer> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(applicationHtml);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const location = server.address();
      if (location === null || typeof location === 'string') {
        reject(new TypeError('Expected a TCP application server address.'));
        return;
      }
      resolve({ server, url: `http://127.0.0.1:${String(location.port)}` });
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

const deadlineScheduler: OperationDeadlineScheduler = Object.freeze({
  schedule(deadlineMs, onDeadline) {
    const timer = setTimeout(onDeadline, deadlineMs);
    return Object.freeze({ cancel: () => clearTimeout(timer) });
  },
});

function waitForCdpEvent<
  Target extends CdpTarget,
  Event extends BluetoothCdpEvent<Target>,
>(
  transport: CdpTransport<Target>,
  event: Event,
  predicate: (payload: CdpEventPayload<Event>) => boolean,
  deadlineMs = 5_000,
): Promise<CdpEventPayload<Event>> {
  return new Promise((resolve, reject) => {
    let unsubscribe = (): void => undefined;
    const timer = setTimeout(() => {
      unsubscribe();
      reject(
        new Error(
          `Timed out after ${String(deadlineMs)} ms waiting for ${event}.`,
        ),
      );
    }, deadlineMs);
    unsubscribe = transport.on(event, (payload) => {
      if (!predicate(payload)) return;
      clearTimeout(timer);
      unsubscribe();
      resolve(payload);
    });
  });
}

describe('PendingOperationRegistry real Chromium contract', () => {
  it('rejects the second same-key event before one response settles both reads', async () => {
    const application = await startApplicationServer();
    const browser = await chromium.launch({
      headless: true,
      ...(process.platform === 'linux'
        ? { args: ['--enable-features=WebBluetooth'] }
        : {}),
    });
    const rawBrowserSession = await browser.newBrowserCDPSession();
    const browserTransport = createCdpTransport('browser', rawBrowserSession);
    const timeline = createBluetoothTimeline({
      limit: 100,
      clock: { now: () => performance.now() },
    });
    const registry = new PendingOperationRegistry({
      timeline,
      defaultDeadlineMs: 5_000,
      deadlineScheduler,
      operationIdNamespace: 'chromium-contract',
    });
    let context: BrowserContext | undefined;
    let pageTransport: CdpTransport<'page'> | undefined;
    let bluetoothEnabled = false;
    let deviceAccessEnabled = false;
    let pendingPromptId: string | undefined;

    try {
      await browserTransport.send('BluetoothEmulation.enable', {
        state: 'powered-on',
        leSupported: true,
      });
      bluetoothEnabled = true;
      await browserTransport.send(
        'BluetoothEmulation.simulatePreconnectedPeripheral',
        {
          address,
          name: 'GattLab pending registry sensor',
          manufacturerData: [],
          knownServiceUuids: [serviceUuid],
        },
      );
      const { serviceId } = await browserTransport.send(
        'BluetoothEmulation.addService',
        { address, serviceUuid },
      );
      const { characteristicId } = await browserTransport.send(
        'BluetoothEmulation.addCharacteristic',
        {
          serviceId,
          characteristicUuid,
          properties: { read: true },
        },
      );

      context = await browser.newContext();
      const page = await context.newPage();
      await page.goto(application.url);
      pageTransport = createCdpTransport(
        'page',
        await context.newCDPSession(page),
      );
      await pageTransport.send('DeviceAccess.enable');
      deviceAccessEnabled = true;

      const promptPromise = waitForCdpEvent(
        pageTransport,
        'DeviceAccess.deviceRequestPrompted',
        (prompt) => prompt.devices.some((device) => device.id === address),
      );
      await page
        .getByRole('button', { name: 'Choose registry device' })
        .click();
      const prompt = await promptPromise;
      pendingPromptId = prompt.id;
      await pageTransport.send('DeviceAccess.selectPrompt', {
        id: prompt.id,
        deviceId: address,
      });
      pendingPromptId = undefined;
      await page.waitForFunction(
        () =>
          (globalThis as unknown as { contractState: { selected: boolean } })
            .contractState.selected,
      );

      const connectionPromise = waitForCdpEvent(
        browserTransport,
        'BluetoothEmulation.gattOperationReceived',
        (event) => event.address === address && event.type === 'connection',
      );
      await page
        .getByRole('button', { name: 'Connect registry device' })
        .click();
      await connectionPromise;
      await browserTransport.send(
        'BluetoothEmulation.simulateGATTOperationResponse',
        { address, type: 'connection', code: 0 },
      );
      await page.waitForFunction(
        () =>
          (globalThis as unknown as { contractState: { connected: boolean } })
            .contractState.connected,
      );

      const discoveryPromise = waitForCdpEvent(
        browserTransport,
        'BluetoothEmulation.gattOperationReceived',
        (event) => event.address === address && event.type === 'discovery',
      );
      await page
        .getByRole('button', { name: 'Discover registry characteristic' })
        .click();
      await discoveryPromise;
      await browserTransport.send(
        'BluetoothEmulation.simulateGATTOperationResponse',
        { address, type: 'discovery', code: 0 },
      );
      await page.waitForFunction(
        () =>
          (globalThis as unknown as { contractState: { discovered: boolean } })
            .contractState.discovered,
      );

      let acceptedOperationId: string | undefined;
      let concurrencyError: unknown;
      let receivedEvents = 0;
      let resolveSecondEvent = (): void => undefined;
      const secondEvent = new Promise<void>((resolve) => {
        resolveSecondEvent = resolve;
      });
      const stopListening = browserTransport.on(
        'BluetoothEmulation.characteristicOperationReceived',
        (event) => {
          if (
            event.characteristicId !== characteristicId ||
            event.type !== 'read'
          ) {
            return;
          }
          receivedEvents += 1;
          try {
            const registered = registry.register({
              kind: 'characteristic-operation',
              characteristic,
              type: 'read',
            });
            acceptedOperationId = registered.operationId;
          } catch (cause) {
            concurrencyError = cause;
          }
          if (receivedEvents === 2) resolveSecondEvent();
        },
      );

      await page
        .getByRole('button', { name: 'Read registry characteristic twice' })
        .click();
      await Promise.race([
        secondEvent,
        new Promise<never>((_resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error('Timed out waiting for two read events.')),
            5_000,
          );
          secondEvent.finally(() => clearTimeout(timer)).catch(() => undefined);
        }),
      ]);
      stopListening();

      expect(receivedEvents).toBe(2);
      expect(concurrencyError).toBeInstanceOf(
        BluetoothConcurrentOperationError,
      );
      expect(concurrencyError).toMatchObject({
        context: {
          operationType: 'read',
          pendingOperationId: acceptedOperationId,
        },
      });
      if (acceptedOperationId === undefined) {
        throw new Error('Expected one accepted pending operation.');
      }
      await registry.respondToCharacteristicOperation(
        {
          operationId: acceptedOperationId,
          type: 'read',
          result: 'success',
          data: [1],
        },
        async () => {
          await browserTransport.send(
            'BluetoothEmulation.simulateCharacteristicOperationResponse',
            {
              characteristicId,
              type: 'read',
              code: 0,
              data: 'AQ==',
            },
          );
        },
      );
      await page.waitForFunction(
        () =>
          (
            globalThis as unknown as {
              contractState: { reads: readonly (readonly number[])[] | null };
            }
          ).contractState.reads !== null,
      );

      const reads = await page.evaluate(
        () =>
          (
            globalThis as unknown as {
              contractState: { reads: readonly (readonly number[])[] };
            }
          ).contractState.reads,
      );
      expect(reads).toEqual([[1], [1]]);
      expect(registry.size).toBe(0);
      expect(
        timeline
          .snapshot()
          .some(({ type }) => type === 'operation-concurrency-rejected'),
      ).toBe(true);
    } finally {
      registry.cancelAll('real contract teardown');
      if (pendingPromptId !== undefined && pageTransport !== undefined) {
        await pageTransport.send('DeviceAccess.cancelPrompt', {
          id: pendingPromptId,
        });
      }
      if (deviceAccessEnabled && pageTransport !== undefined) {
        await pageTransport.send('DeviceAccess.disable');
      }
      if (bluetoothEnabled) {
        await browserTransport.send('BluetoothEmulation.disable');
      }
      if (pageTransport !== undefined) await pageTransport.detach();
      await browserTransport.detach();
      if (context !== undefined) await context.close();
      await browser.close();
      await closeApplicationServer(application.server);
    }
  });
});
