import { createServer, type Server } from 'node:http';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';

import {
  createBluetoothTimeline,
  normalizeBluetoothAddress,
  normalizeBluetoothUuid,
  validatePeripheralDefinition,
  type CharacteristicOperationEvent,
  type CharacteristicOperationType,
  type DescriptorOperationEvent,
  type DescriptorOperationType,
  type GattOperationEvent,
  type GattOperationType,
} from '@gattlab/core';
import { chromium, type BrowserContext, type Page } from 'playwright';
import { describe, expect, it } from 'vitest';

import { CdpCharacteristicOperationHandler } from '../src/characteristic-operation-handler.js';
import { CdpDescriptorOperationHandler } from '../src/descriptor-operation-handler.js';
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

const address = normalizeBluetoothAddress('22:22:22:22:22:01');
const serviceUuid = normalizeBluetoothUuid(
  '12345678-1234-5678-9abc-def123456920',
);
const characteristicUuid = normalizeBluetoothUuid(
  '12345678-1234-5678-9abc-def123456921',
);
const descriptorUuid = normalizeBluetoothUuid(
  '12345678-1234-5678-9abc-def123456922',
);

const applicationHtml = `<!doctype html>
<html lang="en">
  <meta charset="utf-8">
  <title>GattLab attribute handler contract</title>
  <body>
    <button id="choose" type="button">Choose characteristic device</button>
    <button id="connect" type="button">Connect characteristic device</button>
    <button id="discover" type="button">Discover characteristic</button>
    <button id="read-success" type="button">Read characteristic successfully</button>
    <button id="read-error" type="button">Read characteristic with error</button>
    <button id="write-default" type="button">Write characteristic with deprecated default</button>
    <button id="write-response" type="button">Write characteristic with response</button>
    <button id="write-without" type="button">Write characteristic without response</button>
    <button id="subscribe" type="button">Start characteristic notifications</button>
    <button id="unsubscribe" type="button">Stop characteristic notifications</button>
    <button id="descriptor-read-success" type="button">Read descriptor successfully</button>
    <button id="descriptor-read-error" type="button">Read descriptor with error</button>
    <button id="descriptor-write-success" type="button">Write descriptor successfully</button>
    <button id="descriptor-write-error" type="button">Write descriptor with error</button>
    <script>
      window.contractState = { selected: false, operations: [] };
      let device;
      let characteristic;
      let descriptor;

      const bytes = value => Array.from(
        new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
      );
      async function record(action, operation) {
        try {
          const value = await operation();
          window.contractState.operations.push({ action, status: 'resolved', value });
        } catch (error) {
          window.contractState.operations.push({
            action,
            status: 'rejected',
            errorName: error instanceof DOMException ? error.name : typeof error,
          });
        }
      }

      document.querySelector('#choose').onclick = async () => {
        device = await navigator.bluetooth.requestDevice({
          filters: [{ services: ['${serviceUuid}'] }],
        });
        window.contractState.selected = true;
      };
      document.querySelector('#connect').onclick = () => record(
        'connect',
        async () => ({ connected: (await device.gatt.connect()).connected }),
      );
      document.querySelector('#discover').onclick = () => record(
        'discover',
        async () => {
          const service = await device.gatt.getPrimaryService('${serviceUuid}');
          characteristic = await service.getCharacteristic('${characteristicUuid}');
          descriptor = await characteristic.getDescriptor('${descriptorUuid}');
          return {
            serviceUuid: service.uuid,
            characteristicUuid: characteristic.uuid,
            descriptorUuid: descriptor.uuid,
          };
        },
      );
      document.querySelector('#read-success').onclick = () => record(
        'read-success',
        async () => ({ bytes: bytes(await characteristic.readValue()) }),
      );
      document.querySelector('#read-error').onclick = () => record(
        'read-error',
        () => characteristic.readValue(),
      );
      document.querySelector('#write-default').onclick = () => record(
        'write-default',
        () => characteristic.writeValue(new Uint8Array([1])),
      );
      document.querySelector('#write-response').onclick = () => record(
        'write-response',
        () => characteristic.writeValueWithResponse(new Uint8Array([16, 32, 48])),
      );
      document.querySelector('#write-without').onclick = () => record(
        'write-without',
        () => characteristic.writeValueWithoutResponse(new Uint8Array([64, 80])),
      );
      document.querySelector('#subscribe').onclick = () => record(
        'subscribe',
        async () => ({ same: (await characteristic.startNotifications()) === characteristic }),
      );
      document.querySelector('#unsubscribe').onclick = () => record(
        'unsubscribe',
        async () => ({ same: (await characteristic.stopNotifications()) === characteristic }),
      );
      document.querySelector('#descriptor-read-success').onclick = () => record(
        'descriptor-read-success',
        async () => ({ bytes: bytes(await descriptor.readValue()) }),
      );
      document.querySelector('#descriptor-read-error').onclick = () => record(
        'descriptor-read-error',
        () => descriptor.readValue(),
      );
      document.querySelector('#descriptor-write-success').onclick = () => record(
        'descriptor-write-success',
        () => descriptor.writeValue(new Uint8Array([112, 128])),
      );
      document.querySelector('#descriptor-write-error').onclick = () => record(
        'descriptor-write-error',
        () => descriptor.writeValue(new Uint8Array([144])),
      );
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

class OperationQueue<
  Event extends
    | GattOperationEvent
    | CharacteristicOperationEvent
    | DescriptorOperationEvent,
  Type extends
    GattOperationType | CharacteristicOperationType | DescriptorOperationType,
> {
  readonly errors: unknown[] = [];
  readonly #events: Event[] = [];
  readonly #waiters = new Map<
    Type,
    {
      readonly resolve: (event: Event) => void;
      readonly reject: (cause: unknown) => void;
      readonly timer: ReturnType<typeof setTimeout>;
    }[]
  >();

  readonly receive = (event: Event): void => {
    const waiters = this.#waiters.get(event.type as Type);
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

  next(type: Type, deadlineMs = 5_000): Promise<Event> {
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
            `Timed out after ${String(deadlineMs)} ms waiting for a ${type} operation.`,
          ),
        );
      }, deadlineMs);
      const waiters = this.#waiters.get(type) ?? [];
      waiters.push({ resolve, reject, timer });
      this.#waiters.set(type, waiters);
    });
  }
}

function waitForOperationCount(page: Page, count: number): Promise<unknown> {
  return page.waitForFunction(
    (expected) =>
      (
        globalThis as unknown as {
          contractState: { operations: readonly unknown[] };
        }
      ).contractState.operations.length === expected,
    count,
  );
}

describe('CDP attribute operation handlers real Chromium contract', () => {
  it('serves native characteristic and descriptor operations with ATT failures', async () => {
    const definition = validatePeripheralDefinition({
      address,
      name: 'GattLab characteristic handler sensor',
      services: [
        {
          uuid: serviceUuid,
          characteristics: [
            {
              uuid: characteristicUuid,
              properties: [
                'read',
                'write',
                'write-without-response',
                'notify',
                'indicate',
              ],
              descriptors: [{ uuid: descriptorUuid }, { uuid: '2902' }],
            },
          ],
        },
      ],
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
      operationIdNamespace: 'characteristic-handler-chromium',
    });
    const gattHandler = new CdpGattOperationHandler({
      transport: browserTransport,
      entities,
      pendingOperations,
      timeline,
    });
    const characteristicHandler = new CdpCharacteristicOperationHandler({
      transport: browserTransport,
      entities,
      pendingOperations,
      timeline,
    });
    const descriptorHandler = new CdpDescriptorOperationHandler({
      transport: browserTransport,
      entities,
      pendingOperations,
      timeline,
    });
    const gattOperations = new OperationQueue<
      GattOperationEvent,
      GattOperationType
    >();
    const characteristicOperations = new OperationQueue<
      CharacteristicOperationEvent,
      CharacteristicOperationType
    >();
    const descriptorOperations = new OperationQueue<
      DescriptorOperationEvent,
      DescriptorOperationType
    >();
    let unsubscribeGatt = gattHandler.subscribe(
      gattOperations.receive,
      gattOperations.fail,
    );
    let unsubscribeCharacteristic = characteristicHandler.subscribe(
      characteristicOperations.receive,
      characteristicOperations.fail,
    );
    let unsubscribeDescriptor = descriptorHandler.subscribe(
      descriptorOperations.receive,
      descriptorOperations.fail,
    );
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
        .getByRole('button', { name: 'Choose characteristic device' })
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

      const connectionPromise = gattOperations.next('connection');
      await page
        .getByRole('button', { name: 'Connect characteristic device' })
        .click();
      const connection = await connectionPromise;
      await gattHandler.respond({
        operationId: connection.operationId,
        type: 'connection',
        result: 'success',
      });
      await waitForOperationCount(page, 1);

      const discoveryPromise = gattOperations.next('discovery');
      await page
        .getByRole('button', { name: 'Discover characteristic' })
        .click();
      const discovery = await discoveryPromise;
      await gattHandler.respond({
        operationId: discovery.operationId,
        type: 'discovery',
        result: 'success',
      });
      await waitForOperationCount(page, 2);

      const readSuccessPromise = characteristicOperations.next('read');
      await page
        .getByRole('button', { name: 'Read characteristic successfully' })
        .click();
      const readSuccess = await readSuccessPromise;
      await characteristicHandler.respond({
        operationId: readSuccess.operationId,
        type: 'read',
        result: 'success',
        data: [0xde, 0xad, 0xbe, 0xef],
      });
      await waitForOperationCount(page, 3);

      const readErrorPromise = characteristicOperations.next('read');
      await page
        .getByRole('button', { name: 'Read characteristic with error' })
        .click();
      const readError = await readErrorPromise;
      await characteristicHandler.respond({
        operationId: readError.operationId,
        type: 'read',
        result: 'error',
        error: 'invalid-handle',
      });
      await waitForOperationCount(page, 4);

      const writeCases = [
        {
          button: 'Write characteristic with deprecated default',
          writeType: 'default-deprecated',
          data: [1],
        },
        {
          button: 'Write characteristic with response',
          writeType: 'with-response',
          data: [16, 32, 48],
        },
        {
          button: 'Write characteristic without response',
          writeType: 'without-response',
          data: [64, 80],
        },
      ] as const;
      const writes: CharacteristicOperationEvent[] = [];
      for (const [index, writeCase] of writeCases.entries()) {
        const writePromise = characteristicOperations.next('write');
        await page.getByRole('button', { name: writeCase.button }).click();
        const write = await writePromise;
        writes.push(write);
        expect(write).toMatchObject({
          type: 'write',
          writeType: writeCase.writeType,
        });
        if (write.type !== 'write') throw new Error('Expected a write event.');
        expect([...write.data]).toEqual(writeCase.data);
        await characteristicHandler.respond({
          operationId: write.operationId,
          type: 'write',
          result: 'success',
        });
        await waitForOperationCount(page, 5 + index);
      }

      const subscribePromise = characteristicOperations.next(
        'subscribe-to-notifications',
      );
      await page
        .getByRole('button', { name: 'Start characteristic notifications' })
        .click();
      const subscribe = await subscribePromise;
      await characteristicHandler.respond({
        operationId: subscribe.operationId,
        type: 'subscribe-to-notifications',
        result: 'success',
      });
      await waitForOperationCount(page, 8);

      const unsubscribePromise = characteristicOperations.next(
        'unsubscribe-from-notifications',
      );
      await page
        .getByRole('button', { name: 'Stop characteristic notifications' })
        .click();
      const unsubscribe = await unsubscribePromise;
      await characteristicHandler.respond({
        operationId: unsubscribe.operationId,
        type: 'unsubscribe-from-notifications',
        result: 'success',
      });
      await waitForOperationCount(page, 9);

      const descriptorReadSuccessPromise = descriptorOperations.next('read');
      await page
        .getByRole('button', { name: 'Read descriptor successfully' })
        .click();
      const descriptorReadSuccess = await descriptorReadSuccessPromise;
      await descriptorHandler.respond({
        operationId: descriptorReadSuccess.operationId,
        type: 'read',
        result: 'success',
        data: [1, 2, 3, 4],
      });
      await waitForOperationCount(page, 10);

      const descriptorReadErrorPromise = descriptorOperations.next('read');
      await page
        .getByRole('button', { name: 'Read descriptor with error' })
        .click();
      const descriptorReadError = await descriptorReadErrorPromise;
      await descriptorHandler.respond({
        operationId: descriptorReadError.operationId,
        type: 'read',
        result: 'error',
        error: 'invalid-handle',
      });
      await waitForOperationCount(page, 11);

      const descriptorWriteSuccessPromise = descriptorOperations.next('write');
      await page
        .getByRole('button', { name: 'Write descriptor successfully' })
        .click();
      const descriptorWriteSuccess = await descriptorWriteSuccessPromise;
      if (descriptorWriteSuccess.type !== 'write') {
        throw new Error('Expected a descriptor write event.');
      }
      expect([...descriptorWriteSuccess.data]).toEqual([112, 128]);
      await descriptorHandler.respond({
        operationId: descriptorWriteSuccess.operationId,
        type: 'write',
        result: 'success',
      });
      await waitForOperationCount(page, 12);

      const descriptorWriteErrorPromise = descriptorOperations.next('write');
      await page
        .getByRole('button', { name: 'Write descriptor with error' })
        .click();
      const descriptorWriteError = await descriptorWriteErrorPromise;
      if (descriptorWriteError.type !== 'write') {
        throw new Error('Expected a descriptor write event.');
      }
      expect([...descriptorWriteError.data]).toEqual([144]);
      await descriptorHandler.respond({
        operationId: descriptorWriteError.operationId,
        type: 'write',
        result: 'error',
        error: 'invalid-handle',
      });
      await waitForOperationCount(page, 13);

      const state = await page.evaluate(
        () =>
          (
            globalThis as unknown as {
              contractState: {
                selected: boolean;
                operations: readonly Readonly<{
                  action: string;
                  status: string;
                  value?: unknown;
                  errorName?: string;
                }>[];
              };
            }
          ).contractState,
      );
      for (const event of [
        readSuccess,
        readError,
        ...writes,
        subscribe,
        unsubscribe,
      ]) {
        expect(event).toMatchObject({
          kind: 'characteristic-operation',
          characteristic: {
            kind: 'characteristic',
            address,
            serviceUuid,
            characteristicUuid,
          },
        });
      }
      for (const event of [
        descriptorReadSuccess,
        descriptorReadError,
        descriptorWriteSuccess,
        descriptorWriteError,
      ]) {
        expect(event).toMatchObject({
          kind: 'descriptor-operation',
          descriptor: {
            kind: 'descriptor',
            address,
            serviceUuid,
            characteristicUuid,
            descriptorUuid,
          },
        });
      }
      expect(state).toEqual({
        selected: true,
        operations: [
          {
            action: 'connect',
            status: 'resolved',
            value: { connected: true },
          },
          {
            action: 'discover',
            status: 'resolved',
            value: { serviceUuid, characteristicUuid, descriptorUuid },
          },
          {
            action: 'read-success',
            status: 'resolved',
            value: { bytes: [0xde, 0xad, 0xbe, 0xef] },
          },
          {
            action: 'read-error',
            status: 'rejected',
            errorName: 'NotSupportedError',
          },
          { action: 'write-default', status: 'resolved' },
          { action: 'write-response', status: 'resolved' },
          { action: 'write-without', status: 'resolved' },
          {
            action: 'subscribe',
            status: 'resolved',
            value: { same: true },
          },
          {
            action: 'unsubscribe',
            status: 'resolved',
            value: { same: true },
          },
          {
            action: 'descriptor-read-success',
            status: 'resolved',
            value: { bytes: [1, 2, 3, 4] },
          },
          {
            action: 'descriptor-read-error',
            status: 'rejected',
            errorName: 'NotSupportedError',
          },
          { action: 'descriptor-write-success', status: 'resolved' },
          {
            action: 'descriptor-write-error',
            status: 'rejected',
            errorName: 'NotSupportedError',
          },
        ],
      });
      expect(gattOperations.errors).toEqual([]);
      expect(characteristicOperations.errors).toEqual([]);
      expect(descriptorOperations.errors).toEqual([]);
      expect(pendingOperations.size).toBe(0);
      const responseEntries = timeline
        .snapshot()
        .filter(({ type }) => type === 'operation-response');
      expect(responseEntries).toHaveLength(26);
      expect(responseEntries.every(({ status }) => status !== 'failed')).toBe(
        true,
      );
    } finally {
      unsubscribeDescriptor();
      unsubscribeDescriptor = (): void => undefined;
      unsubscribeCharacteristic();
      unsubscribeCharacteristic = (): void => undefined;
      unsubscribeGatt();
      unsubscribeGatt = (): void => undefined;
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
  }, 20_000);
});
