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

import {
  CdpDevicePromptController,
  type DevicePromptDeadlineScheduler,
} from '../src/device-prompt-controller.js';
import { CdpEntityRegistry } from '../src/entity-registry.js';
import { CdpGattOperationHandler } from '../src/gatt-operation-handler.js';
import { PendingOperationRegistry } from '../src/pending-operation-registry.js';
import { createCdpTransport, type CdpTransport } from '../src/transport.js';

const firstAddress = normalizeBluetoothAddress('30:30:30:30:30:01');
const secondAddress = normalizeBluetoothAddress('30:30:30:30:30:02');
const firstServiceUuid = normalizeBluetoothUuid(
  '12345678-1234-5678-9abc-def123456a00',
);
const secondServiceUuid = normalizeBluetoothUuid(
  '12345678-1234-5678-9abc-def123456a01',
);
const duplicateName = 'GattLab duplicate-name sensor';

const applicationHtml = `<!doctype html>
<html lang="en">
  <meta charset="utf-8">
  <title>GattLab device prompt controller contract</title>
  <body>
    <button id="choose" type="button">Choose duplicate-name sensor</button>
    <button id="connect" type="button">Connect selected sensor</button>
    <script>
      window.contractState = {
        attempts: [],
        gatt: { outcome: 'idle' },
      };
      let selectedDevice;
      document.querySelector('#choose').onclick = async () => {
        const attempt = { outcome: 'pending' };
        window.contractState.attempts.push(attempt);
        try {
          const device = await navigator.bluetooth.requestDevice({
            filters: [
              { services: ['${firstServiceUuid}'] },
              { services: ['${secondServiceUuid}'] },
            ],
          });
          selectedDevice = device;
          attempt.outcome = 'selected';
          attempt.deviceId = device.id;
          attempt.deviceName = device.name;
        } catch (error) {
          attempt.outcome = 'cancelled';
          attempt.errorName = error.name;
        }
      };
      document.querySelector('#connect').onclick = async () => {
        window.contractState.gatt = { outcome: 'pending' };
        try {
          const server = await selectedDevice.gatt.connect();
          const selectedService = await server.getPrimaryService(
            '${secondServiceUuid}',
          );
          let firstServiceErrorName = null;
          try {
            await server.getPrimaryService('${firstServiceUuid}');
          } catch (error) {
            firstServiceErrorName = error.name;
          }
          window.contractState.gatt = {
            outcome: 'resolved',
            connected: server.connected,
            selectedServiceUuid: selectedService.uuid,
            firstServiceErrorName,
          };
        } catch (error) {
          window.contractState.gatt = {
            outcome: 'rejected',
            errorName: error.name,
          };
        }
      };
    </script>
  </body>
</html>`;

interface ApplicationServer {
  readonly server: Server;
  readonly url: string;
}

interface ApplicationAttempt {
  readonly outcome: 'pending' | 'selected' | 'cancelled';
  readonly deviceId?: string;
  readonly deviceName?: string;
  readonly errorName?: string;
}

interface ApplicationGattResult {
  readonly outcome: 'idle' | 'pending' | 'resolved' | 'rejected';
  readonly connected?: boolean;
  readonly selectedServiceUuid?: string;
  readonly firstServiceErrorName?: string | null;
  readonly errorName?: string;
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

const deadlineScheduler: DevicePromptDeadlineScheduler = Object.freeze({
  schedule(deadlineMs, onDeadline) {
    const timer = setTimeout(onDeadline, deadlineMs);
    return Object.freeze({ cancel: () => clearTimeout(timer) });
  },
});

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

describe('CdpDevicePromptController real Chromium contract', () => {
  it('cancels one chooser and selects the exact duplicate-name peripheral by address', async () => {
    const firstDefinition = validatePeripheralDefinition({
      address: firstAddress,
      name: duplicateName,
      services: [{ uuid: firstServiceUuid, characteristics: [] }],
    });
    const secondDefinition = validatePeripheralDefinition({
      address: secondAddress,
      name: duplicateName,
      services: [{ uuid: secondServiceUuid, characteristics: [] }],
    });
    if (!firstDefinition.success || !secondDefinition.success) {
      throw new Error('Expected valid duplicate-name peripheral fixtures.');
    }
    const application = await startApplicationServer();
    const browser = await chromium.launch({
      headless: true,
      ...(process.platform === 'linux'
        ? { args: ['--enable-features=WebBluetooth'] }
        : {}),
    });
    const rawBrowserSession = await browser.newBrowserCDPSession();
    const browserTransport = createCdpTransport('browser', rawBrowserSession);
    const entities = new CdpEntityRegistry(browserTransport);
    const timeline = createBluetoothTimeline({
      limit: 100,
      clock: { now: () => performance.now() },
    });
    const pendingOperations = new PendingOperationRegistry({
      timeline,
      defaultDeadlineMs: 5_000,
      deadlineScheduler,
      operationIdNamespace: 'device-prompt-chromium',
    });
    const gattHandler = new CdpGattOperationHandler({
      transport: browserTransport,
      entities,
      pendingOperations,
      timeline,
    });
    const operations = new GattOperationQueue();
    let unsubscribeGatt = gattHandler.subscribe(
      operations.receive,
      operations.fail,
    );
    let context: BrowserContext | undefined;
    let pageTransport: CdpTransport<'page'> | undefined;
    let controller: CdpDevicePromptController | undefined;
    let bluetoothEnabled = false;
    let deviceAccessEnabled = false;

    try {
      await browserTransport.send('BluetoothEmulation.enable', {
        state: 'powered-on',
        leSupported: true,
      });
      bluetoothEnabled = true;
      context = await browser.newContext();
      const page = await context.newPage();
      await page.goto(application.url);
      pageTransport = createCdpTransport(
        'page',
        await context.newCDPSession(page),
      );
      await pageTransport.send('DeviceAccess.enable');
      deviceAccessEnabled = true;
      await entities.addPeripheralHierarchy(firstDefinition.value);
      await entities.addPeripheralHierarchy(secondDefinition.value);
      controller = new CdpDevicePromptController({
        transport: pageTransport,
        timeline,
        clock: { now: () => performance.now() },
        defaultDeadlineMs: 5_000,
        deadlineScheduler,
        getDiagnosticState: () => ({
          centralState: 'powered-on',
          knownPeripherals: [firstAddress, secondAddress],
          advertisementsSent: 0,
        }),
      });

      const cancellationPrompt = controller.waitForDevicePrompt();
      await page
        .getByRole('button', { name: 'Choose duplicate-name sensor' })
        .click();
      const promptToCancel = await cancellationPrompt;
      expect(promptToCancel.devices.length).toBeGreaterThan(0);
      expect(promptToCancel.devices.every((device) => device.name === '')).toBe(
        true,
      );
      expect(
        promptToCancel.devices.every(
          (device) => device.id === firstAddress || device.id === secondAddress,
        ),
      ).toBe(true);
      await promptToCancel.cancel();
      await page.waitForFunction(
        () =>
          (
            globalThis as unknown as {
              contractState: { attempts: ApplicationAttempt[] };
            }
          ).contractState.attempts[0]?.outcome === 'cancelled',
      );
      const cancelledAttempt = await page.evaluate(
        () =>
          (
            globalThis as unknown as {
              contractState: { attempts: ApplicationAttempt[] };
            }
          ).contractState.attempts[0],
      );
      expect(cancelledAttempt).toEqual({
        outcome: 'cancelled',
        errorName: 'NotFoundError',
      });

      const selectionPrompt = controller.waitForDevicePrompt();
      await page
        .getByRole('button', { name: 'Choose duplicate-name sensor' })
        .click();
      const promptToSelect = await selectionPrompt;
      await expect
        .poll(() => promptToSelect.devices, { timeout: 5_000 })
        .toEqual([
          { id: firstAddress, name: '' },
          { id: secondAddress, name: '' },
        ]);
      await promptToSelect.select(secondAddress);
      await page.waitForFunction(
        () =>
          (
            globalThis as unknown as {
              contractState: { attempts: ApplicationAttempt[] };
            }
          ).contractState.attempts[1]?.outcome === 'selected',
      );
      const selectedAttempt = await page.evaluate(
        () =>
          (
            globalThis as unknown as {
              contractState: { attempts: ApplicationAttempt[] };
            }
          ).contractState.attempts[1],
      );
      expect(selectedAttempt).toMatchObject({
        outcome: 'selected',
        deviceName: duplicateName,
      });
      expect(selectedAttempt?.deviceId).toBeTypeOf('string');
      expect(selectedAttempt?.deviceId).not.toBe(firstAddress);
      expect(selectedAttempt?.deviceId).not.toBe(secondAddress);

      const connectionEventPromise = operations.next('connection');
      await page
        .getByRole('button', { name: 'Connect selected sensor' })
        .click();
      const connectionEvent = await connectionEventPromise;
      expect(connectionEvent).toMatchObject({
        kind: 'gatt-operation',
        peripheral: { kind: 'peripheral', address: secondAddress },
        type: 'connection',
      });
      const discoveryEventPromise = operations.next('discovery');
      await gattHandler.respond({
        operationId: connectionEvent.operationId,
        type: 'connection',
        result: 'success',
      });
      const discoveryEvent = await discoveryEventPromise;
      expect(discoveryEvent).toMatchObject({
        kind: 'gatt-operation',
        peripheral: { kind: 'peripheral', address: secondAddress },
        type: 'discovery',
      });
      await gattHandler.respond({
        operationId: discoveryEvent.operationId,
        type: 'discovery',
        result: 'success',
      });
      await page.waitForFunction(
        () =>
          (
            globalThis as unknown as {
              contractState: { gatt: ApplicationGattResult };
            }
          ).contractState.gatt.outcome !== 'pending',
      );
      const gattResult = await page.evaluate(
        () =>
          (
            globalThis as unknown as {
              contractState: { gatt: ApplicationGattResult };
            }
          ).contractState.gatt,
      );
      expect(gattResult).toEqual({
        outcome: 'resolved',
        connected: true,
        selectedServiceUuid: secondServiceUuid,
        firstServiceErrorName: 'NotFoundError',
      });
      expect(operations.errors).toEqual([]);
      expect(pendingOperations.size).toBe(0);

      expect(
        timeline
          .snapshot()
          .filter((event) => event.type === 'device-prompt-received'),
      ).toHaveLength(2);
      expect(
        timeline.snapshot().map((event) => [event.type, event.status]),
      ).toEqual(
        expect.arrayContaining([
          ['device-prompt-cancellation', 'succeeded'],
          ['device-prompt-selection', 'succeeded'],
        ]),
      );
    } finally {
      unsubscribeGatt();
      unsubscribeGatt = (): void => undefined;
      pendingOperations.cancelAll('real contract teardown');
      if (controller?.activePrompt !== undefined) {
        await controller.activePrompt.cancel().catch(() => undefined);
      }
      controller?.dispose('real-contract-cleanup');
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
