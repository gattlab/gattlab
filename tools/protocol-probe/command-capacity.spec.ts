import { performance } from 'node:perf_hooks';
import { clearTimeout, setTimeout } from 'node:timers';
import {
  createBluetoothTimeline,
  validatePeripheralDefinition,
  type PeripheralDefinition,
} from '@gattlab/core';
import {
  CdpBluetoothBackendFactory,
  createCdpTransport,
  type CdpBluetoothBackend,
  type CdpSessionLike,
} from '@gattlab/cdp';
import { test as base, expect } from '@gattlab/playwright';
import type { CDPSession } from '@playwright/test';
import { profiles } from './capacity-profiles.js';
import { startApplication, stopApplication } from './probe-support.js';

interface Observation {
  operation: string;
  elapsedMs: number;
  commandCount: number;
  status: 'succeeded' | 'failed';
}
interface Capacity {
  measure<T>(operation: string, run: () => Promise<T>): Promise<T>;
  observations: Observation[];
  backend?: CdpBluetoothBackend;
}
const test = base.extend<{ capacity: Capacity }>({
  capacity: async ({ browser, context }, use) => {
    let commandCount = 0;
    const observations: Observation[] = [];
    const capacity: Capacity = {
      observations,
      async measure<T>(operation: string, run: () => Promise<T>): Promise<T> {
        const started = performance.now();
        const before = commandCount;
        let status: Observation['status'] = 'failed';
        try {
          const value = await run();
          status = 'succeeded';
          return value;
        } finally {
          observations.push({
            operation,
            elapsedMs: performance.now() - started,
            commandCount: commandCount - before,
            status,
          });
        }
      },
    };
    const monitor = (session: CDPSession): CDPSession => {
      const structural = session as unknown as CdpSessionLike;
      const send = structural.send.bind(structural);
      structural.send = (method, parameters) => {
        commandCount += 1;
        return send(method, parameters);
      };
      return session;
    };
    const browserSession = browser.newBrowserCDPSession.bind(browser);
    const pageSession = context.newCDPSession.bind(context);
    browser.newBrowserCDPSession = async () => monitor(await browserSession());
    context.newCDPSession = async (...args) =>
      monitor(await pageSession(...args));
    const factoryStart = CdpBluetoothBackendFactory.prototype.start;
    CdpBluetoothBackendFactory.prototype.start = async function (options) {
      const backend = await factoryStart.call(this, options);
      capacity.backend = backend;
      const gatt = backend.respondToGattOperation.bind(backend);
      const characteristic =
        backend.respondToCharacteristicOperation.bind(backend);
      const descriptor = backend.respondToDescriptorOperation.bind(backend);
      backend.respondToGattOperation = (...args) =>
        capacity.measure('respondToGattOperation', () => gatt(...args));
      backend.respondToCharacteristicOperation = (...args) =>
        capacity.measure('respondToCharacteristicOperation', () =>
          characteristic(...args),
        );
      backend.respondToDescriptorOperation = (...args) =>
        capacity.measure('respondToDescriptorOperation', () =>
          descriptor(...args),
        );
      return backend;
    };
    try {
      await use(capacity);
    } finally {
      browser.newBrowserCDPSession = browserSession;
      context.newCDPSession = pageSession;
      CdpBluetoothBackendFactory.prototype.start = factoryStart;
    }
  },
});

let application: Awaited<ReturnType<typeof startApplication>>;
test.beforeAll(async () => {
  application = await startApplication();
});
test.afterAll(async () => {
  if (application !== undefined) await stopApplication(application);
});
test.use({ gattlab: { artifacts: 'off' } });

// Native app actions only; no navigator replacement and no latency injection.
const html = `<!doctype html><html><body>
<button id="choose">Choose</button><button id="journey">Read and write</button>
<output id="state">idle</output><script>
let device;
window.capacityServices = [];
window.capacityDescriptorCharacteristics = [];
document.querySelector('#choose').onclick = async () => {
  document.querySelector('#state').textContent = 'choosing';
  try {
    device = await navigator.bluetooth.requestDevice({acceptAllDevices: true, optionalServices: window.capacityServices});
    document.querySelector('#state').textContent = 'selected';
  } catch (error) { document.querySelector('#state').textContent = error.name; }
};
document.querySelector('#journey').onclick = async () => {
  try {
    const gatt = await device.gatt.connect();
    for (const uuid of window.capacityServices) {
      const service = await gatt.getPrimaryService(uuid);
      for (const characteristic of await service.getCharacteristics()) {
        if (characteristic.properties.read) await characteristic.readValue();
        if (characteristic.properties.write) await characteristic.writeValueWithResponse(new Uint8Array([7]));
        if (!window.capacityDescriptorCharacteristics.includes(characteristic.uuid)) continue;
        for (const descriptor of await characteristic.getDescriptors()) {
          if (descriptor.uuid === '00002902-0000-1000-8000-00805f9b34fb') continue;
          await descriptor.readValue();
          await descriptor.writeValue(new Uint8Array([0]));
        }
      }
    }
    document.querySelector('#state').textContent = 'ready';
  } catch(error) { document.querySelector('#state').textContent = error.name; }
};
</script></body></html>`;

for (const profile of profiles) {
  for (const mode of ['playwright', 'cdp'] as const) {
    test(`${mode} capacity ${profile.id}`, async ({
      bluetooth,
      browser,
      context,
      page,
      capacity,
    }, info) => {
      await page.route('**/capacity', (route) =>
        route.fulfill({ contentType: 'text/html', body: html }),
      );
      await page.goto(new URL('/capacity', application.url).href);
      await page.evaluate(
        (services) => {
          (
            globalThis as unknown as { capacityServices: readonly string[] }
          ).capacityServices = services;
        },
        profile.definition.services
          .filter(({ characteristics }) => characteristics.length > 0)
          .map(({ uuid }) => uuid),
      );
      await page.evaluate(
        (ids) => {
          (
            globalThis as unknown as {
              capacityDescriptorCharacteristics: readonly string[];
            }
          ).capacityDescriptorCharacteristics = ids;
        },
        profile.definition.services.flatMap(({ characteristics }) =>
          characteristics
            .filter(({ descriptors }) => descriptors.length > 0)
            .map(({ uuid }) => uuid),
        ),
      );
      const definition: PeripheralDefinition = profile.definition;
      let direct: CdpBluetoothBackend | undefined;
      const errors: unknown[] = [];
      let released = false;
      try {
        if (mode === 'cdp') {
          const factory = new CdpBluetoothBackendFactory({
            browserName: 'chromium',
            browserTransport: createCdpTransport(
              'browser',
              await browser.newBrowserCDPSession(),
            ),
            pageTransport: createCdpTransport(
              'page',
              await context.newCDPSession(page),
            ),
            inspectWebBluetoothEnvironment: () =>
              page.evaluate(() => ({
                secureContext: globalThis.isSecureContext,
                navigatorBluetooth: 'bluetooth' in navigator,
              })),
            timeline: createBluetoothTimeline({
              limit: 1000,
              clock: { now: () => performance.now() },
            }),
            clock: { now: () => performance.now() },
            deadlineScheduler: {
              schedule: (milliseconds, callback) => {
                const timer = setTimeout(callback, milliseconds);
                return { cancel: () => clearTimeout(timer) };
              },
            },
            operationDeadlineMs: 5000,
            promptDeadlineMs: 5000,
            teardownDeadlineMs: 5000,
            releaseLease: () => {
              released = true;
              return Promise.resolve();
            },
          });
          direct = await factory.start({ centralState: 'powered-on' });
          const backend = direct;
          backend.onEvent((event) => {
            const promise =
              event.kind === 'gatt-operation'
                ? backend.respondToGattOperation({
                    operationId: event.operationId,
                    type: event.type,
                    result: 'success',
                  })
                : event.kind === 'characteristic-operation'
                  ? backend.respondToCharacteristicOperation(
                      event.type === 'read'
                        ? {
                            operationId: event.operationId,
                            type: 'read',
                            result: 'success',
                            data: [42],
                          }
                        : {
                            operationId: event.operationId,
                            type: event.type,
                            result: 'success',
                          },
                    )
                  : backend.respondToDescriptorOperation(
                      event.type === 'read'
                        ? {
                            operationId: event.operationId,
                            type: 'read',
                            result: 'success',
                            data: [0],
                          }
                        : {
                            operationId: event.operationId,
                            type: 'write',
                            result: 'success',
                          },
                    );
            void promise.catch((error: unknown) => errors.push(error));
          });
        } else {
          // Exclude lazy startup/capability work from every command observation.
          await bluetooth.adapter.setState('powered-on');
        }
        const normalized = validatePeripheralDefinition(definition);
        if (!normalized.success)
          throw new Error('Capacity definition must validate');
        const peripheral =
          mode === 'cdp'
            ? (await capacity.measure('addPeripheral', () =>
                direct!.addPeripheral(normalized.value),
              ),
              undefined)
            : await capacity.measure('createPeripheral', () =>
                bluetooth.createPeripheral(definition),
              );
        await capacity.measure('disconnect', () =>
          mode === 'cdp'
            ? direct!.disconnect(normalized.value.address)
            : peripheral!.disconnect(),
        );
        const second = {
          ...definition,
          address: `${definition.address.slice(0, -2)}${(parseInt(definition.address.slice(-2), 16) + 64).toString(16).padStart(2, '0')}`,
        };
        const secondNormalized = validatePeripheralDefinition(second);
        if (!secondNormalized.success)
          throw new Error('Capacity preconnection definition must validate');
        if (mode === 'cdp') {
          await direct!.addPeripheral(secondNormalized.value);
          await capacity.measure('createPreconnectedPeripheral', () =>
            direct!.createPreconnectedPeripheral(secondNormalized.value),
          );
        } else
          await capacity.measure('createPreconnectedPeripheral', () =>
            bluetooth.createPreconnectedPeripheral(second),
          );
        for (const state of ['absent', 'powered-off', 'powered-on'] as const) {
          await capacity.measure(`setCentralState:${state}`, () =>
            mode === 'cdp'
              ? direct!.setCentralState(state)
              : bluetooth.adapter.setState(state),
          );
        }
        // Baseline uses the identical committed-state command. Implementation
        // switches this observation to the public CDP integration fence.
        await capacity.measure('liveness-check', () =>
          capacity.backend!.checkLiveness('setCentralState'),
        );
        const promptPromise =
          mode === 'cdp'
            ? direct!.waitForDevicePrompt()
            : bluetooth.waitForDevicePrompt();
        await page.locator('#choose').click();
        const prompt = await promptPromise;
        await capacity.measure('simulateAdvertisement', () =>
          mode === 'cdp'
            ? direct!.simulateAdvertisement(normalized.value)
            : peripheral!.advertise(),
        );
        await expect
          .poll(() => prompt.devices.map(({ id }) => id))
          .toContain(normalized.value.address);
        // The actual selection itself is bounded command work, not prompt arrival.
        if (mode === 'cdp') {
          const selected = prompt as Awaited<
            ReturnType<CdpBluetoothBackend['waitForDevicePrompt']>
          >;
          await capacity.measure('select', () =>
            selected.select(normalized.value.address),
          );
        } else {
          const selected = prompt as Awaited<
            ReturnType<typeof bluetooth.waitForDevicePrompt>
          >;
          await capacity.measure('select', () => selected.select(peripheral!));
        }
        await expect(page.locator('#state')).toHaveText('selected');
        await page.locator('#journey').click();
        await expect(page.locator('#state')).toHaveText('ready');
        for (const operation of ['selectById', 'cancel'] as const) {
          const waiting =
            mode === 'cdp'
              ? direct!.waitForDevicePrompt()
              : bluetooth.waitForDevicePrompt();
          await page.locator('#choose').click();
          const next = await waiting;
          if (operation === 'selectById')
            await capacity.measure(operation, () =>
              next.selectById(normalized.value.address),
            );
          else await capacity.measure(operation, () => next.cancel());
          await expect(page.locator('#state')).toHaveText(
            operation === 'cancel' ? 'NotFoundError' : 'selected',
          );
        }
        expect(errors).toEqual([]);
        expect(
          capacity.observations.every(
            ({ status, commandCount, operation }) =>
              status === 'succeeded' &&
              (commandCount > 0 ||
                (mode === 'cdp' &&
                  operation === 'createPreconnectedPeripheral')),
          ),
        ).toBe(true);
      } finally {
        if (direct) {
          await direct.stop();
          expect(released).toBe(true);
        } else await bluetooth.dispose();
        await info.attach('command-capacity.json', {
          body: Buffer.from(
            JSON.stringify({
              schemaVersion: 1,
              profileId: profile.id,
              mode,
              browserVersion: browser.version(),
              observations: capacity.observations,
            }),
          ),
          contentType: 'application/json',
        });
      }
    });
  }
}
