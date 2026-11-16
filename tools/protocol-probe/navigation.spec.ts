import { performance } from 'node:perf_hooks';
import {
  BluetoothBackendStoppedError,
  BluetoothTimeoutError,
} from '@gattlab/core';
import {
  CdpBluetoothBackendFactory,
  CdpTransportError,
  type CdpBluetoothBackend,
} from '@gattlab/cdp';
import {
  test as base,
  expect,
  type BluetoothLab,
  type PeripheralHandle,
  type CharacteristicHandle,
  type DevicePrompt,
} from '@gattlab/playwright';
import type {
  Browser,
  BrowserContext,
  Frame,
  Page,
  TestInfo,
} from '@playwright/test';
import { profiles } from './capacity-profiles.js';
import { scenarios } from './navigation-cases.js';
import {
  observePublicClose,
  MAX_CLOSE_STEPS,
  MODEL_COMMAND_WATCHDOG_MS,
  isDestructiveRegistration,
  assertModelCommandAbort,
  type ModelTimeoutEvidence,
} from './public-close-sequence.mjs';
import { startApplication, stopApplication } from './probe-support.js';

const SERVICE = '12345678-1234-5678-9abc-def123456789';
const CHARACTERISTIC = '12345678-1234-5678-9abc-def123456780';
const DESCRIPTOR = '12345678-1234-5678-9abc-def123456781';
const ADDRESS = '50:90:00:00:00:01';
const definition = (address = ADDRESS) => ({
  address,
  name: 'Public navigation sensor',
  advertisement: { rssi: -42 },
  services: [
    {
      uuid: SERVICE,
      characteristics: [
        {
          uuid: CHARACTERISTIC,
          properties: ['read', 'write'] as const,
          initialValue: [87],
          descriptors: [{ uuid: DESCRIPTOR, initialValue: [0] }],
        },
      ],
    },
  ],
});
interface AppState {
  apiCalls: string[];
  availability?: boolean;
  request: {
    invoked: boolean;
    callReturned: boolean;
    status: string;
    error?: string;
  } | null;
  operations: {
    name: string;
    status: string;
    value?: number | boolean;
    error?: string;
  }[];
  disconnected: number;
}
const html = `<!doctype html><html><body>
<button id="choose">Choose</button><button id="connect">Connect</button>
<button id="read">Read</button><button id="disconnect">Disconnect</button>
<script>
window.navigationState = { apiCalls: [], request: null, operations: [], disconnected: 0 };
let device, characteristic;
window.availability = async () => {
  window.navigationState.apiCalls.push('getAvailability');
  return window.navigationState.availability = await navigator.bluetooth.getAvailability();
};
document.querySelector('#choose').onclick = () => {
  const state = window.navigationState;
  state.apiCalls.push('requestDevice');
  state.request = { invoked: true, callReturned: false, status: 'pending' };
  try {
    const pending = navigator.bluetooth.requestDevice({ filters: [{ services: ['${SERVICE}'] }] });
    state.request.callReturned = true;
    pending.then(value => {
      device = value; state.request.status = 'selected';
      device.addEventListener('gattserverdisconnected', () => state.disconnected++);
    }, error => { state.request.status = 'rejected'; state.request.error = error.name; });
  } catch(error) { state.request.status = 'rejected'; state.request.error = error.name; }
};
function operation(name, action) {
  window.navigationState.apiCalls.push(name);
  const result = { name, status: 'pending' };
  window.navigationState.operations.push(result);
  Promise.resolve().then(action).then(value => {
    result.value = value; result.status = 'resolved';
  }, error => { result.error = error.name; result.status = 'rejected'; });
}
document.querySelector('#connect').onclick = () => operation('connect', async () => {
  await device.gatt.connect();
  const service = await device.gatt.getPrimaryService('${SERVICE}');
  characteristic = await service.getCharacteristic('${CHARACTERISTIC}');
  return device.gatt.connected;
});
document.querySelector('#read').onclick = () => operation('read', async () => {
  const result = await characteristic.readValue(); return result.getUint8(0);
});
document.querySelector('#disconnect').onclick = () => { device.gatt.disconnect(); };
</script></body></html>`;

interface Monitor {
  backend?: CdpBluetoothBackend;
  holdReads: boolean;
  heldRead?: Promise<void>;
  releaseRead(): void;
  delivered: number;
}
const test = base.extend<{ monitor: Monitor }>({
  monitor: async ({}, use) => {
    let release: () => void = () => undefined;
    const monitor: Monitor = {
      holdReads: false,
      delivered: 0,
      releaseRead: () => release(),
    };
    const start = CdpBluetoothBackendFactory.prototype.start;
    CdpBluetoothBackendFactory.prototype.start = async function (options) {
      const backend = await start.call(this, options);
      monitor.backend = backend;
      const respond = backend.respondToCharacteristicOperation.bind(backend);
      backend.respondToCharacteristicOperation = async (...args) => {
        if (monitor.holdReads && args[0].type === 'read') {
          monitor.heldRead = new Promise<void>((resolve) => {
            release = resolve;
          });
          await monitor.heldRead;
        }
        await respond(...args);
        monitor.delivered++;
      };
      return backend;
    };
    try {
      await use(monitor);
    } finally {
      monitor.releaseRead();
      CdpBluetoothBackendFactory.prototype.start = start;
    }
  },
});
let application: Awaited<ReturnType<typeof startApplication>>;
test.beforeAll(async () => {
  application = await startApplication();
});
test.afterAll(async () => {
  if (application) await stopApplication(application);
});
test.use({
  gattlab: { artifacts: 'off', operationTimeoutMs: 500, promptTimeoutMs: 500 },
});

type View = Page | Frame;
type TerminalReason =
  'adapter-lost' | 'fixture-page-closed' | 'model-outcome-unknown';
async function state(view: View): Promise<AppState> {
  return view.evaluate(
    () =>
      (globalThis as unknown as { navigationState: AppState }).navigationState,
  );
}
async function availability(view: View): Promise<boolean> {
  return view.evaluate(() =>
    (
      globalThis as unknown as { availability(): Promise<boolean> }
    ).availability(),
  );
}
async function ready(
  page: Page,
  url = new URL('/navigation', application.url).href,
): Promise<void> {
  await page.route('**/navigation*', (route) =>
    route.fulfill({ contentType: 'text/html', body: html }),
  );
  await page.goto(url);
  await expect.poll(async () => (await state(page)).apiCalls).toEqual([]);
}
async function operation(view: View, name: 'connect' | 'read'): Promise<void> {
  const before = (await state(view)).operations.length;
  await view.locator(`#${name}`).click();
  await expect
    .poll(async () => (await state(view)).operations[before]?.status)
    .toBe('resolved');
  expect((await state(view)).operations[before]?.value).toBe(
    name === 'read' ? 87 : true,
  );
}
async function choose(
  lab: BluetoothLab,
  peripheral: PeripheralHandle,
  view: View,
  cancel = false,
): Promise<DevicePrompt> {
  const waiting = lab.waitForDevicePrompt();
  void waiting.catch(() => undefined);
  await view.locator('#choose').click();
  const prompt = await waiting;
  if (cancel) await prompt.cancel();
  else {
    await peripheral.advertise();
    await expect
      .poll(() => prompt.devices.map(({ id }) => id))
      .toContain(peripheral.address);
    await prompt.select(peripheral);
  }
  await expect
    .poll(async () => (await state(view)).request?.status)
    .toBe(cancel ? 'rejected' : 'selected');
  if (cancel) expect((await state(view)).request?.error).toBe('NotFoundError');
  return prompt;
}
async function journey(
  lab: BluetoothLab,
  peripheral: PeripheralHandle,
  view: View,
): Promise<DevicePrompt> {
  const prompt = await choose(lab, peripheral, view);
  await operation(view, 'connect');
  await operation(view, 'read');
  return prompt;
}
async function prerequisite(
  level: string,
  lab: BluetoothLab,
  peripheral: PeripheralHandle,
  view: View,
): Promise<DevicePrompt | undefined> {
  if (level === 'U0') expect((await state(view)).apiCalls).toEqual([]);
  else if (level === 'U1') expect(await availability(view)).toBe(true);
  else if (level === 'U2') return choose(lab, peripheral, view, true);
  else if (level === 'U3') {
    const prompt = await choose(lab, peripheral, view);
    expect((await state(view)).operations).toEqual([]);
    return prompt;
  } else if (level === 'U4' || level === 'pending-read')
    return journey(lab, peripheral, view);
  else if (level === 'pending-request') {
    await view.locator('#choose').click();
    await expect
      .poll(async () => (await state(view)).request)
      .toEqual({ invoked: true, callReturned: true, status: 'pending' });
  } else if (level === 'pending-chooser')
    expect(await availability(view)).toBe(true);
  else throw new Error(`Unknown installed prerequisite ${level}`);
  return undefined;
}
async function stimulus(
  action: string,
  subject: View,
  subjectPage: Page,
  alternate?: string,
): Promise<void> {
  if (action === 'goto' || action === 'lazy-goto')
    await subjectPage.goto(new URL('/navigation', application.url).href);
  else if (action === 'reload') await subjectPage.reload();
  else if (action === 'close') await subjectPage.close();
  else if (action === 'other-origin') await subjectPage.goto(alternate!);
  else if (action === 'blank') await subjectPage.goto('about:blank');
  else if (action === 'hash')
    await subject.evaluate(() => {
      location.hash = 'control';
    });
  else if (action === 'history')
    await subject.evaluate(() => {
      history.pushState({}, '', '?control=history');
    });
  else if (action === 'replace') {
    const replacement = `${new URL('/navigation', application.url).href}?replaced`;
    const navigation = subject.waitForURL(replacement);
    await subjectPage.evaluate((url) => {
      (document.querySelector('#child') as HTMLIFrameElement).src = url;
    }, replacement);
    await navigation;
  }
}
function assertStopped(
  cause: unknown,
  operation: string,
  reason: TerminalReason,
  boundary?: string,
  retainedCause?: BluetoothTimeoutError,
): asserts cause is BluetoothBackendStoppedError {
  if (cause instanceof BluetoothBackendStoppedError)
    test.info().annotations.push({
      type: 'navigation-stopped-context',
      description: JSON.stringify({
        reason: cause.context['reason'],
        lifecycleState: cause.context['lifecycleState'],
        operation: cause.context['operation'],
        operationLayer: cause.context['operationLayer'],
        detectedBy: cause.context['detectedBy'],
        remediation: cause.context['remediation'],
      }),
    });
  expect(cause).toBeInstanceOf(BluetoothBackendStoppedError);
  const error = cause as BluetoothBackendStoppedError;
  expect(error.code).toBe('BLUETOOTH_BACKEND_STOPPED');
  expect(error.context).toMatchObject({
    reason,
    lifecycleState: 'invalidated',
    operation,
    operationLayer: 'playwright',
    remediation: 'new-test-fixture',
  });
  expect(error.context).not.toHaveProperty('state');
  expect(Object.isFrozen(error.context)).toBe(true);
  if (boundary) expect(error.context['boundary']).toBe(boundary);
  if (reason === 'adapter-lost') {
    expect(error.context['detectedBy']).toMatch(
      /^(command-rejection|liveness-check)$/,
    );
    expect(error.cause).toBeInstanceOf(CdpTransportError);
    expect((error.cause as CdpTransportError).kind).toBe('command-failed');
    expect((error.cause as CdpTransportError).target).toBe('browser');
    expect((error.cause as CdpTransportError).cause).toBeInstanceOf(Error);
  } else if (reason === 'model-outcome-unknown') {
    assertModelCommandAbort(
      cause,
      { operation, boundary: boundary!, retainedCause },
      { stopped: BluetoothBackendStoppedError, timeout: BluetoothTimeoutError },
    );
  } else expect(error.context['detectedBy']).toBe('fixture-page-close');
}
async function rejected(
  run: () => unknown | Promise<unknown>,
): Promise<unknown> {
  try {
    await run();
  } catch (cause) {
    return cause;
  }
  throw new Error('Expected a typed lifecycle rejection');
}
async function assertAllStopped(
  lab: BluetoothLab,
  peripheral: PeripheralHandle,
  characteristic: CharacteristicHandle,
  reason: TerminalReason,
  oldPrompt?: DevicePrompt,
  boundary?: string,
  retainedCause?: BluetoothTimeoutError,
): Promise<void> {
  const entries: [string, () => unknown | Promise<unknown>][] = [
    [
      'createPeripheral',
      () => lab.createPeripheral(definition('50:90:00:00:00:02')),
    ],
    [
      'createPreconnectedPeripheral',
      () => lab.createPreconnectedPeripheral(definition('50:90:00:00:00:03')),
    ],
    ['setState', () => lab.adapter.setState('powered-on')],
    ['waitForDevicePrompt', () => lab.waitForDevicePrompt()],
    ['advertise', () => peripheral.advertise()],
    ['disconnect', () => peripheral.disconnect()],
    [
      'characteristic',
      () => peripheral.characteristic(SERVICE, CHARACTERISTIC),
    ],
    ['descriptor', () => characteristic.descriptor(DESCRIPTOR)],
    ['expectRead', () => characteristic.expectRead()],
    ['expectSubscription', () => characteristic.expectSubscription()],
    ['expectUnsubscription', () => characteristic.expectUnsubscription()],
    ['waitForWrite', () => characteristic.waitForWrite()],
    ['queue', () => characteristic.reads.queue([1])],
    ['queueError', () => characteristic.reads.queueError('unlikely-error')],
    ['queueSuccess', () => peripheral.connection.queueSuccess()],
  ];
  if (oldPrompt)
    entries.push(
      ['select', () => oldPrompt.select(peripheral)],
      ['selectById', () => oldPrompt.selectById(peripheral.address)],
      ['cancel', () => oldPrompt.cancel()],
    );
  for (const [name, run] of entries)
    assertStopped(await rejected(run), name, reason, boundary, retainedCause);
  expect(peripheral.address).toBe(ADDRESS);
  expect(characteristic.uuid).toBe(CHARACTERISTIC);
  expect(Object.isFrozen(peripheral.operations())).toBe(true);
  expect(Object.isFrozen(characteristic.operations())).toBe(true);
}
async function disposeChecked(
  lab: BluetoothLab,
  expectedClosedPage: boolean,
): Promise<void> {
  const first = lab.dispose();
  const second = lab.dispose();
  expect(first).toBe(second);
  if (!expectedClosedPage) {
    await first;
    return;
  }
  const cause = await rejected(() => first);
  expect(cause).toBeInstanceOf(AggregateError);
  const errors = (cause as AggregateError).errors as unknown[];
  expect(errors).toHaveLength(2);
  expect(errors[0]).toBeInstanceOf(CdpTransportError);
  expect((errors[0] as CdpTransportError).target).toBe('page');
  expect((errors[0] as CdpTransportError).cause).toBeInstanceOf(Error);
  expect(((errors[0] as CdpTransportError).cause as Error).message).toBe(
    'cdpSession.send: Target page, context or browser has been closed',
  );
  expect(errors[1]).toBeInstanceOf(Error);
  expect((errors[1] as Error).message).toBe(
    'cdpSession.detach: Target page, context or browser has been closed',
  );
}

async function attach(
  info: TestInfo,
  caseId: string,
  browser: Browser,
  observations: object,
): Promise<void> {
  await info.attach('navigation-public.json', {
    body: Buffer.from(
      JSON.stringify({
        caseId,
        browserVersion: browser.version(),
        observations,
      }),
    ),
    contentType: 'application/json',
  });
}

let previous:
  | { browser: Browser; lab: BluetoothLab; peripheral: PeripheralHandle }
  | undefined;
for (const row of scenarios) {
  if (row.group === 'short-assertion') {
    test.describe(row.id, () => {
      test.use({
        gattlab: {
          artifacts: 'off',
          operationTimeoutMs: 1,
          promptTimeoutMs: 500,
        },
      });
      test(row.id, async ({ browser, page, bluetooth, monitor }, info) => {
        await ready(page);
        await bluetooth.adapter.setState('powered-on');
        const samples: {
          profileId: string;
          operation: string;
          elapsedMs: number;
        }[] = [];
        let characteristic: CharacteristicHandle | undefined;
        for (const profile of profiles) {
          const measured = async <T>(
            operation: string,
            run: () => Promise<T>,
          ): Promise<T> => {
            const before = performance.now();
            const value = await run();
            samples.push({
              profileId: profile.id,
              operation,
              elapsedMs: performance.now() - before,
            });
            return value;
          };
          const peripheral = await measured('createPeripheral', () =>
            bluetooth.createPeripheral(profile.definition),
          );
          const second = {
            ...profile.definition,
            address: `${profile.definition.address.slice(0, -2)}${(parseInt(profile.definition.address.slice(-2), 16) + 64).toString(16).padStart(2, '0')}`,
          };
          await measured('createPreconnectedPeripheral', () =>
            bluetooth.createPreconnectedPeripheral(second),
          );
          await measured('disconnect', () => peripheral.disconnect());
          const service = profile.definition.services.find(
            (service) => service.characteristics.length > 0,
          )!;
          characteristic = peripheral.characteristic(
            service.uuid,
            service.characteristics[0]!.uuid,
          );
        }
        const error = await rejected(() => characteristic!.expectRead());
        expect(error).toBeInstanceOf(BluetoothTimeoutError);
        expect((error as BluetoothTimeoutError).context).toMatchObject({
          operation: 'expectRead',
          operationLayer: 'playwright',
          deadlineKind: 'application-operation',
          deadlineMs: 1,
          detection: 'live',
        });
        expect(samples.some((sample) => sample.elapsedMs > 1)).toBe(true);
        expect(monitor.backend).toBeDefined();
        await bluetooth.dispose();
        await attach(info, row.id, browser, {
          operationTimeoutMs: 1,
          shortWaitDeadlineMs: 1,
          samples,
          profileIds: profiles.map((profile) => profile.id),
          exposure: true,
        });
      });
    });
    continue;
  }
  if (row.group === 'N10') {
    test.describe(row.id, () => {
      test.describe.configure({ mode: 'serial' });
      test(
        row.testIds[0]!,
        async ({ browser, context, page, bluetooth, monitor }, info) => {
          await ready(page);
          const peripheral = await bluetooth.createPeripheral(definition());
          let subject = page;
          if (row.subject === 'same-context') {
            subject = await context.newPage();
            await ready(subject);
          }
          await prerequisite('U1', bluetooth, peripheral, subject);
          const first = bluetooth.dispose();
          const second = bluetooth.dispose();
          expect(first).toBe(second);
          await Promise.all([
            stimulus(row.action, subject, subject),
            first,
            second,
          ]);
          previous = { browser, lab: bluetooth, peripheral };
          await expect(
            rejected(() => peripheral.advertise()),
          ).resolves.toBeInstanceOf(BluetoothBackendStoppedError);
          expect(monitor.backend).toBeDefined();
          await attach(info, row.testIds[0]!, browser, {
            idempotent: true,
            disposalWon: true,
          });
        },
      );
      test(
        row.testIds[1]!,
        async ({ browser, page, bluetooth, monitor }, info) => {
          expect(previous?.browser).toBe(browser);
          await ready(page);
          const waiting = bluetooth.waitForDevicePrompt();
          void waiting.catch(() => undefined);
          await page.locator('#choose').click();
          const prompt = await waiting;
          expect(prompt.devices).toEqual([]);
          await prompt.cancel();
          const peripheral = await bluetooth.createPeripheral(definition());
          await previous!.lab.dispose();
          await journey(bluetooth, peripheral, page);
          await peripheral.characteristic(SERVICE, CHARACTERISTIC).expectRead();
          expect(monitor.backend).toBeDefined();
          await attach(info, row.testIds[1]!, browser, {
            sameBrowser: true,
            emptyChooser: true,
            read: 87,
          });
        },
      );
    });
    continue;
  }
  test(row.id, async ({ browser, context, page, bluetooth, monitor }, info) => {
    if (isDestructiveRegistration(row))
      // The test envelope must outlast its bounded public command sequence.
      // This does not change a command deadline or the performance gate.
      test.setTimeout(
        (row.action === 'close' ? MAX_CLOSE_STEPS : 1) *
          MODEL_COMMAND_WATCHDOG_MS +
          20_000,
      );
    const phase = (description: string) =>
      info.annotations.push({ type: 'navigation-phase', description });
    phase('prepare');
    test.fail(
      row.expectedCleanupFailure === true,
      'Owned page closure retains its two reportable cleanup failures',
    );
    const started = performance.now();
    let otherContext: BrowserContext | undefined;
    let otherApplication:
      Awaited<ReturnType<typeof startApplication>> | undefined;
    let heldWait: Promise<unknown> | undefined;
    try {
      await ready(page);
      if (row.action === 'lazy-goto') await stimulus('lazy-goto', page, page);
      phase('initial-model');
      const peripheral = await bluetooth.createPeripheral(definition());
      const characteristic = peripheral.characteristic(SERVICE, CHARACTERISTIC);
      let subjectPage = page;
      let subject: View = page;
      if (row.subject === 'same-context' || row.subject === 'other-context') {
        if ('retainedFixture' in row && row.retainedFixture)
          expect(await availability(page)).toBe(true);
        if (row.subject === 'other-context')
          otherContext = await browser.newContext();
        subjectPage = await (otherContext ?? context).newPage();
        await ready(subjectPage);
        subject = subjectPage;
      } else if (row.subject === 'child') {
        const childUrl = new URL('/navigation', application.url).href;
        const created = page.waitForEvent('framenavigated', {
          predicate: (frame) =>
            frame.parentFrame() === page.mainFrame() &&
            frame.url() === childUrl,
        });
        await page.evaluate((url) => {
          const child = document.createElement('iframe');
          child.id = child.name = 'child';
          child.src = url;
          document.body.append(child);
        }, childUrl);
        subject = await created;
        expect((await state(page)).apiCalls).toEqual([]);
      }
      if (row.group === 'state') {
        const central = row.state!;
        await bluetooth.adapter.setState(central);
        const timeout = await rejected(() => characteristic.expectRead());
        expect(timeout).toBeInstanceOf(BluetoothTimeoutError);
        expect((timeout as BluetoothTimeoutError).context).toMatchObject({
          operation: 'expectRead',
          operationLayer: 'playwright',
          deadlineKind: 'application-operation',
          deadlineMs: 500,
          detection: 'live',
          centralStateBlocked: false,
          remediation: 'inspect-operation',
        });
        expect(await availability(page)).toBe(central !== 'absent');
        await bluetooth.adapter.setState('powered-on');
        await journey(bluetooth, peripheral, page);
        await attach(info, row.id, browser, {
          preservedState: central,
          read: 87,
        });
        return;
      }
      phase('prerequisite');
      const oldPrompt = await prerequisite(
        row.level,
        bluetooth,
        peripheral,
        subject,
      );
      const before = await state(subject);
      if (row.group === 'N4' || row.action === 'scripted-disconnect') {
        await peripheral.disconnect();
        await expect
          .poll(async () => (await state(subject)).disconnected)
          .toBeGreaterThan(0);
      } else if (row.group === 'N5') {
        await subject.locator('#disconnect').click();
        await expect
          .poll(async () => (await state(subject)).disconnected)
          .toBeGreaterThan(0);
      }
      if (row.group === 'N8') {
        heldWait =
          row.level === 'pending-chooser'
            ? bluetooth.waitForDevicePrompt()
            : characteristic.waitForWrite();
        void heldWait.catch(() => undefined);
        if (row.level === 'pending-read') {
          monitor.holdReads = true;
          await subject.locator('#read').click();
          await expect.poll(() => monitor.heldRead !== undefined).toBe(true);
          await expect
            .poll(async () => (await state(subject)).operations.at(-1)?.status)
            .toBe('pending');
        }
      }
      if (row.action === 'other-origin')
        otherApplication = await startApplication();
      phase('stimulus');
      await stimulus(
        row.action,
        subject,
        subjectPage,
        otherApplication
          ? new URL('/navigation', otherApplication.url).href
          : undefined,
      );
      const control =
        row.level === 'U0' ||
        [
          'hash',
          'history',
          'scripted-disconnect',
          'native-disconnect',
          'lazy-goto',
        ].includes(row.action) ||
        ('retainedFixture' in row && row.retainedFixture);
      if (control) {
        await bluetooth.createPeripheral(definition('50:90:00:00:00:02'));
        if (row.group === 'N5') {
          await operation(page, 'connect');
          await operation(page, 'read');
        } else await journey(bluetooth, peripheral, page);
        await characteristic.expectRead();
        await attach(info, row.id, browser, {
          control: true,
          prerequisite: before,
          read: 87,
          elapsedMs: performance.now() - started,
        });
        return;
      }
      let reason: TerminalReason =
        row.action === 'close' && row.subject === 'fixture'
          ? 'fixture-page-closed'
          : 'adapter-lost';
      const boundary =
        reason === 'fixture-page-closed'
          ? 'fixture-page-closed'
          : row.subject === 'fixture'
            ? 'fixture-document-changed'
            : 'unobserved';
      let modelTimeout: ModelTimeoutEvidence | undefined;
      let originalTimeout: BluetoothTimeoutError | undefined;
      const assertRegistrationFailure = (cause: unknown, operation: string) => {
        if (
          cause instanceof BluetoothBackendStoppedError &&
          cause.context['reason'] === 'model-outcome-unknown'
        ) {
          expect(isDestructiveRegistration(row)).toBe(true);
          const checked = assertModelCommandAbort(
            cause,
            { operation, boundary, retainedCause: originalTimeout },
            {
              stopped: BluetoothBackendStoppedError,
              timeout: BluetoothTimeoutError,
            },
          );
          originalTimeout ??= checked.timeout;
          modelTimeout = checked.evidence;
          reason = 'model-outcome-unknown';
        }
        assertStopped(cause, operation, reason, boundary, originalTimeout);
      };
      if (row.group === 'N9') {
        // No lab operation or repair is inserted between the two destructions.
        if (!subjectPage.isClosed()) {
          await availability(subjectPage);
          await stimulus(row.action, subjectPage, subjectPage);
        } else {
          const again = await context.newPage();
          await ready(again);
          await availability(again);
          await again.close();
        }
      }
      let closeEvidence:
        | {
            closeOutcome: 'continued' | 'invalidated';
            closeSteps: number;
            verifiedRegistrations: number;
            typedLossVerified?: boolean;
            typedModelAbortVerified?: boolean;
            lossOperation?: string;
            terminalOperation?: string;
          }
        | undefined;
      const racedClose =
        row.action === 'close' &&
        ['same-context', 'other-context'].includes(row.subject);
      if (racedClose) {
        const addressAt = (step: number) =>
          `50:90:00:00:00:${(step + 2).toString(16).padStart(2, '0')}`;
        let lossOperation = 'createPeripheral';
        let initialConcurrent: string[] | undefined;
        const outcome = await observePublicClose(
          async (step) => {
            phase('post-close-registration');
            lossOperation = 'createPeripheral';
            if (row.group === 'N9' && step === 0) {
              const concurrent = await Promise.allSettled([
                Promise.resolve().then(() => peripheral.advertise()),
                Promise.resolve().then(() =>
                  bluetooth.createPeripheral(definition(addressAt(step))),
                ),
              ] as const);
              initialConcurrent = concurrent.map((result) => result.status);
              if (concurrent[1].status === 'fulfilled')
                expect(concurrent[1].value.address).toBe(addressAt(step));
              for (const [index, result] of concurrent.entries())
                if (result.status === 'rejected') {
                  const operation =
                    index === 0 ? 'advertise' : 'createPeripheral';
                  assertRegistrationFailure(result.reason, operation);
                }
              const firstRejected = concurrent.findIndex(
                (result) => result.status === 'rejected',
              );
              if (firstRejected !== -1) {
                lossOperation =
                  firstRejected === 0 ? 'advertise' : 'createPeripheral';
                const rejectedResult = concurrent[firstRejected]!;
                if (rejectedResult.status === 'rejected')
                  throw rejectedResult.reason;
              }
              if (concurrent[1].status === 'fulfilled')
                return concurrent[1].value;
              throw new Error(
                'A registration must succeed or produce a checked lifecycle error',
              );
            }
            return bluetooth.createPeripheral(definition(addressAt(step)));
          },
          (registered, step) => {
            phase('verify-registration');
            expect(registered.address).toBe(addressAt(step));
            const registeredCharacteristic = registered.characteristic(
              SERVICE,
              CHARACTERISTIC,
            );
            expect(registeredCharacteristic.uuid).toBe(CHARACTERISTIC);
            expect(registeredCharacteristic.descriptor(DESCRIPTOR).uuid).toBe(
              DESCRIPTOR,
            );
          },
          (cause) => assertRegistrationFailure(cause, lossOperation),
        );
        closeEvidence = {
          closeOutcome: outcome.outcome,
          closeSteps: outcome.steps,
          verifiedRegistrations: outcome.verifiedRegistrations,
          ...(outcome.outcome === 'invalidated'
            ? {
                typedLossVerified: reason === 'adapter-lost',
                typedModelAbortVerified: originalTimeout !== undefined,
                terminalOperation: lossOperation,
                ...(reason === 'adapter-lost' ? { lossOperation } : {}),
              }
            : {}),
        };
        if (outcome.outcome === 'continued') {
          expect(
            monitor
              .backend!.timeline.snapshot()
              .filter(({ type }) => type === 'lab-invalidated'),
          ).toHaveLength(0);
          phase('dispose');
          await disposeChecked(bluetooth, false);
          phase('completed');
          await attach(info, row.id, browser, {
            control: false,
            prerequisite: before,
            ...closeEvidence,
            invalidations: 0,
            ...(row.group === 'N9'
              ? { destructions: 2, initialConcurrent }
              : {}),
            elapsedMs: performance.now() - started,
          });
          return;
        }
        if (row.group === 'N9') {
          const afterLoss = await Promise.allSettled([
            Promise.resolve().then(() => peripheral.advertise()),
            Promise.resolve().then(() =>
              bluetooth.createPeripheral(definition('50:90:00:00:00:08')),
            ),
          ]);
          for (const [index, result] of afterLoss.entries()) {
            expect(result.status).toBe('rejected');
            if (result.status === 'rejected')
              assertRegistrationFailure(
                result.reason,
                index === 0 ? 'advertise' : 'createPeripheral',
              );
          }
        }
      } else if (row.group === 'N8') {
        assertStopped(
          await rejected(() => heldWait!),
          row.level === 'pending-chooser'
            ? 'waitForDevicePrompt'
            : 'waitForWrite',
          reason,
          boundary,
        );
        monitor.releaseRead();
        if (row.level === 'pending-read')
          await expect
            .poll(() => characteristic.operations().at(-1)?.responseDelivery)
            .toBe('failed');
      } else if (row.group === 'N9') {
        const concurrent = await Promise.allSettled([
          Promise.resolve().then(() => peripheral.advertise()),
          Promise.resolve().then(() =>
            bluetooth.createPeripheral(definition('50:90:00:00:00:02')),
          ),
        ]);
        for (const result of concurrent) {
          expect(result.status).toBe('rejected');
          if (result.status === 'rejected')
            assertRegistrationFailure(
              result.reason,
              result === concurrent[0] ? 'advertise' : 'createPeripheral',
            );
        }
      } else {
        assertRegistrationFailure(
          await rejected(() =>
            bluetooth.createPeripheral(definition('50:90:00:00:00:02')),
          ),
          'createPeripheral',
        );
      }
      const snapshots = {
        peripheral: peripheral.operations(),
        characteristic: characteristic.operations(),
      };
      phase('terminal-handles');
      await assertAllStopped(
        bluetooth,
        peripheral,
        characteristic,
        reason,
        oldPrompt,
        boundary,
        originalTimeout,
      );
      phase('dispose');
      await disposeChecked(bluetooth, row.expectedCleanupFailure === true);
      await assertAllStopped(
        bluetooth,
        peripheral,
        characteristic,
        reason,
        oldPrompt,
        boundary,
        originalTimeout,
      );
      expect(peripheral.operations()).toEqual(snapshots.peripheral);
      if (row.group !== 'N8')
        expect(characteristic.operations()).toEqual(snapshots.characteristic);
      expect(
        monitor
          .backend!.timeline.snapshot()
          .filter(({ type }) => type === 'lab-invalidated'),
      ).toHaveLength(1);
      await attach(info, row.id, browser, {
        control: false,
        reason,
        boundary,
        prerequisite: before,
        invalidations: 1,
        ...(modelTimeout
          ? {
              modelTimeout,
              typedModelAbortVerified: true,
              typedLossVerified: false,
            }
          : {}),
        ...closeEvidence,
        cleanupFailureVerified: row.expectedCleanupFailure === true,
        ...(row.group === 'N8'
          ? {
              pendingWaitSettled: true,
              ...(row.level === 'pending-read'
                ? { pendingReadConfirmed: true, lateDeliveryFailed: true }
                : {}),
            }
          : {}),
        ...(row.group === 'N9'
          ? { concurrentRejected: 2, destructions: 2 }
          : {}),
        elapsedMs: performance.now() - started,
      });
    } finally {
      monitor.releaseRead();
      await disposeChecked(bluetooth, row.expectedCleanupFailure === true);
      await otherContext?.close();
      if (otherApplication) await stopApplication(otherApplication);
    }
  });
}
