import { createServer, type Server } from 'node:http';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';

import {
  createBluetoothTimeline,
  normalizeBluetoothAddress,
  normalizeBluetoothUuid,
  validatePeripheralDefinition,
  type GattOperationEvent,
  type GattOperationType,
} from '@gattlab/core';
import { chromium, type BrowserContext } from 'playwright';
import { describe, expect, it } from 'vitest';

import { CdpEntityRegistry } from '../src/entity-registry.js';
import { CdpGattOperationHandler } from '../src/gatt-operation-handler.js';
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

const address = normalizeBluetoothAddress('21:21:21:21:21:01');
const serviceUuid = normalizeBluetoothUuid(
  '12345678-1234-5678-9abc-def123456910',
);

const applicationHtml = `<!doctype html>
<html lang="en">
  <meta charset="utf-8">
  <title>GattLab GATT handler contract</title>
  <body>
    <button id="choose" type="button">Choose GATT handler device</button>
    <button id="connect" type="button">Connect GATT handler device</button>
    <button id="discover" type="button">Discover GATT handler services</button>
    <script>
      window.contractState = {
        selected: false,
        connected: false,
        connectionErrors: [],
        services: null,
        disconnects: [],
      };
      let device;

      document.querySelector('#choose').onclick = async () => {
        device = await navigator.bluetooth.requestDevice({
          filters: [{ services: ['${serviceUuid}'] }],
        });
        device.addEventListener('gattserverdisconnected', event => {
          window.contractState.disconnects.push({
            type: event.type,
            connected: device.gatt.connected,
          });
        });
        window.contractState.selected = true;
      };
      document.querySelector('#connect').onclick = async () => {
        try {
          const server = await device.gatt.connect();
          window.contractState.connected = server.connected;
        } catch (error) {
          window.contractState.connectionErrors.push({
            name: error instanceof DOMException ? error.name : typeof error,
          });
        }
      };
      document.querySelector('#discover').onclick = async () => {
        const services = await device.gatt.getPrimaryServices();
        window.contractState.services = services.map(service => service.uuid);
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

class GattOperationQueue {
  readonly errors: unknown[] = [];
  readonly #events: GattOperationEvent[] = [];
  readonly #waiters = new Map<
    GattOperationType,
    {
      readonly resolve: (event: GattOperationEvent) => void;
      readonly reject: (cause: unknown) => void;
      readonly timer: ReturnType<typeof setTimeout>;
    }[]
  >();

  readonly receive = (event: GattOperationEvent): void => {
    const waiters = this.#waiters.get(event.type);
    const waiter = waiters?.shift();
    if (waiter === undefined) {
      this.#events.push(event);
      return;
    }
    clearTimeout(waiter.timer);
    waiter.resolve(event);
  };

  readonly fail = (cause: unknown): void => {
    this.errors.push(cause);
    for (const waiters of this.#waiters.values()) {
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.reject(cause);
      }
    }
    this.#waiters.clear();
  };

  next(
    type: GattOperationType,
    deadlineMs = 5_000,
  ): Promise<GattOperationEvent> {
    const index = this.#events.findIndex((event) => event.type === type);
    if (index >= 0) {
      const event = this.#events.splice(index, 1)[0];
      if (event !== undefined) return Promise.resolve(event);
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const waiters = this.#waiters.get(type);
        if (waiters !== undefined) {
          const waiterIndex = waiters.findIndex(
            (waiter) => waiter.resolve === resolve,
          );
          if (waiterIndex >= 0) waiters.splice(waiterIndex, 1);
        }
        reject(
          new Error(
            `Timed out after ${String(deadlineMs)} ms waiting for a ${type} GATT event.`,
          ),
        );
      }, deadlineMs);
      const waiters = this.#waiters.get(type) ?? [];
      waiters.push({ resolve, reject, timer });
      this.#waiters.set(type, waiters);
    });
  }
}

describe('CdpGattOperationHandler real Chromium contract', () => {
  it('connects, discovers a service, and disconnects through stable handler events', async () => {
    const definition = validatePeripheralDefinition({
      address,
      name: 'GattLab GATT handler sensor',
      services: [{ uuid: serviceUuid, characteristics: [] }],
    });
    if (!definition.success) throw new Error('Expected a valid fixture.');

    const application = await startApplicationServer();
    const browser = await chromium.launch({
      headless: true,
      ...(process.platform === 'linux'
        ? { args: ['--enable-features=WebBluetooth'] }
        : {}),
    });
    const browserTransport = createCdpTransport(
      'browser',
      await browser.newBrowserCDPSession(),
    );
    const entities = new CdpEntityRegistry(browserTransport);
    const timeline = createBluetoothTimeline({
      limit: 100,
      clock: { now: () => performance.now() },
    });
    const pendingOperations = new PendingOperationRegistry({
      timeline,
      defaultDeadlineMs: 5_000,
      deadlineScheduler,
      operationIdNamespace: 'gatt-handler-chromium',
    });
    const handler = new CdpGattOperationHandler({
      transport: browserTransport,
      entities,
      pendingOperations,
      timeline,
    });
    const operations = new GattOperationQueue();
    let unsubscribe = handler.subscribe(operations.receive, operations.fail);
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
      await entities.addPeripheralHierarchy(definition.value);

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
        .getByRole('button', { name: 'Choose GATT handler device' })
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

      const failedConnectionEventPromise = operations.next('connection');
      await page
        .getByRole('button', { name: 'Connect GATT handler device' })
        .click();
      const failedConnectionEvent = await failedConnectionEventPromise;
      await handler.respond({
        operationId: failedConnectionEvent.operationId,
        type: 'connection',
        result: 'error',
        error: 'connection-failed-to-be-established',
      });
      await page.waitForFunction(
        () =>
          (
            globalThis as unknown as {
              contractState: { connectionErrors: readonly unknown[] };
            }
          ).contractState.connectionErrors.length === 1,
      );

      const connectionEventPromise = operations.next('connection');
      await page
        .getByRole('button', { name: 'Connect GATT handler device' })
        .click();
      const connectionEvent = await connectionEventPromise;
      await handler.respond({
        operationId: connectionEvent.operationId,
        type: 'connection',
        result: 'success',
      });
      await page.waitForFunction(
        () =>
          (globalThis as unknown as { contractState: { connected: boolean } })
            .contractState.connected,
      );

      const discoveryEventPromise = operations.next('discovery');
      await page
        .getByRole('button', { name: 'Discover GATT handler services' })
        .click();
      const discoveryEvent = await discoveryEventPromise;
      await handler.respond({
        operationId: discoveryEvent.operationId,
        type: 'discovery',
        result: 'success',
      });
      await page.waitForFunction(
        () =>
          (
            globalThis as unknown as {
              contractState: { services: readonly string[] | null };
            }
          ).contractState.services !== null,
      );

      await handler.disconnect(address);
      await page.waitForFunction(
        () =>
          (
            globalThis as unknown as {
              contractState: { disconnects: readonly unknown[] };
            }
          ).contractState.disconnects.length === 1,
      );

      const state = await page.evaluate(
        () =>
          (
            globalThis as unknown as {
              contractState: {
                selected: boolean;
                connected: boolean;
                connectionErrors: readonly Readonly<{ name: string }>[];
                services: readonly string[];
                disconnects: readonly Readonly<{
                  type: string;
                  connected: boolean;
                }>[];
              };
            }
          ).contractState,
      );
      expect(connectionEvent).toMatchObject({
        kind: 'gatt-operation',
        peripheral: { kind: 'peripheral', address },
        type: 'connection',
      });
      expect(failedConnectionEvent).toMatchObject({
        kind: 'gatt-operation',
        peripheral: { kind: 'peripheral', address },
        type: 'connection',
      });
      expect(discoveryEvent).toMatchObject({
        kind: 'gatt-operation',
        peripheral: { kind: 'peripheral', address },
        type: 'discovery',
      });
      expect(connectionEvent.operationId).not.toBe(discoveryEvent.operationId);
      expect(failedConnectionEvent.operationId).not.toBe(
        connectionEvent.operationId,
      );
      expect(state).toEqual({
        selected: true,
        connected: true,
        connectionErrors: [{ name: 'NetworkError' }],
        services: [serviceUuid],
        disconnects: [{ type: 'gattserverdisconnected', connected: false }],
      });
      expect(operations.errors).toEqual([]);
      expect(pendingOperations.size).toBe(0);
      expect(
        timeline
          .snapshot()
          .filter(({ type }) => type === 'operation-response')
          .map(({ status }) => status),
      ).toEqual([
        'requested',
        'succeeded',
        'requested',
        'succeeded',
        'requested',
        'succeeded',
      ]);
    } finally {
      unsubscribe();
      unsubscribe = (): void => undefined;
      pendingOperations.cancelAll('real contract teardown');
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
        entities.resetAfterDomainDisable();
      }
      if (pageTransport !== undefined) await pageTransport.detach();
      await browserTransport.detach();
      await pendingOperations.settled();
      timeline.close();
      if (context !== undefined) await context.close();
      await browser.close();
      await closeApplicationServer(application.server);
    }
  });
});
