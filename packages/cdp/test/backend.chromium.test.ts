import { createServer, type Server } from 'node:http';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';

import {
  BluetoothCancelledError,
  createBluetoothTimeline,
  normalizeBluetoothAddress,
  normalizeBluetoothUuid,
  validatePeripheralDefinition,
  type BluetoothTimelineEvent,
  type GattOperationEvent,
} from '@gattlab/core';
import {
  chromium,
  type Browser,
  type BrowserContext,
  type CDPSession,
  type Page,
} from 'playwright';
import { describe, expect, it } from 'vitest';

import {
  CdpBluetoothBackendFactory,
  type CdpBackendDeadlineScheduler,
  type CdpBluetoothBackend,
} from '../src/backend.js';
import { createCdpTransport, type CdpSessionLike } from '../src/transport.js';

const address = normalizeBluetoothAddress('40:40:40:40:40:01');
const serviceUuid = normalizeBluetoothUuid(
  '12345678-1234-5678-9abc-def123456b00',
);

const applicationHtml = `<!doctype html>
<html lang="en">
  <meta charset="utf-8">
  <title>GattLab backend teardown contract</title>
  <body>
    <button id="choose" type="button">Choose teardown sensor</button>
    <button id="connect" type="button">Connect teardown sensor</button>
    <script>
      window.contractState = {
        selection: { outcome: 'idle' },
        connection: { outcome: 'idle' },
      };
      let selectedDevice;
      document.querySelector('#choose').onclick = async () => {
        window.contractState.selection = { outcome: 'pending' };
        try {
          selectedDevice = await navigator.bluetooth.requestDevice({
            filters: [{ services: ['${serviceUuid}'] }],
          });
          window.contractState.selection = { outcome: 'selected' };
        } catch (error) {
          window.contractState.selection = {
            outcome: 'cancelled',
            errorName: error.name,
          };
        }
      };
      document.querySelector('#connect').onclick = async () => {
        window.contractState.connection = { outcome: 'pending' };
        try {
          await selectedDevice.gatt.connect();
          window.contractState.connection = { outcome: 'connected' };
        } catch (error) {
          window.contractState.connection = {
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

interface ApplicationSelection {
  readonly outcome: 'idle' | 'pending' | 'selected' | 'cancelled';
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

class ResourceAudit {
  readonly sessions: AuditedSession[] = [];
  readonly deadlines = new Set<ReturnType<typeof setTimeout>>();
  callerWaits = 0;

  readonly scheduler: CdpBackendDeadlineScheduler = {
    schedule: (deadlineMs, onDeadline) => {
      const timer = setTimeout(() => {
        this.deadlines.delete(timer);
        onDeadline();
      }, deadlineMs);
      this.deadlines.add(timer);
      return {
        cancel: () => {
          clearTimeout(timer);
          this.deadlines.delete(timer);
        },
      };
    },
  };

  session(session: CdpSessionLike): CdpSessionLike {
    const audited = new AuditedSession(session);
    this.sessions.push(audited);
    return audited;
  }

  async caller<T>(promise: Promise<T>): Promise<T> {
    this.callerWaits += 1;
    try {
      return await promise;
    } finally {
      this.callerWaits -= 1;
    }
  }

  snapshot(): {
    listeners: number;
    transportWaits: number;
    deadlines: number;
    callerWaits: number;
  } {
    return {
      listeners: this.sessions.reduce(
        (sum, session) => sum + session.listenerCount,
        0,
      ),
      transportWaits: this.sessions.reduce(
        (sum, session) => sum + session.waits,
        0,
      ),
      deadlines: this.deadlines.size,
      callerWaits: this.callerWaits,
    };
  }
}

class AuditedSession implements CdpSessionLike {
  readonly listeners = new Map<
    string,
    Map<(payload: unknown) => void, number>
  >();
  waits = 0;
  readonly #session: CdpSessionLike;

  constructor(session: CdpSessionLike) {
    this.#session = session;
  }

  get listenerCount(): number {
    return [...this.listeners.values()].reduce(
      (sum, listeners) =>
        sum +
        [...listeners.values()].reduce((total, count) => total + count, 0),
      0,
    );
  }

  async send(method: string, parameters?: object): Promise<unknown> {
    this.waits += 1;
    try {
      return await this.#session.send(method, parameters);
    } finally {
      this.waits -= 1;
    }
  }

  on(event: string, listener: (payload: unknown) => void): void {
    this.#session.on(event, listener);
    const listeners =
      this.listeners.get(event) ??
      new Map<(payload: unknown) => void, number>();
    listeners.set(listener, (listeners.get(listener) ?? 0) + 1);
    this.listeners.set(event, listeners);
  }

  off(event: string, listener: (payload: unknown) => void): void {
    this.#session.off(event, listener);
    const listeners = this.listeners.get(event);
    const count = listeners?.get(listener) ?? 0;
    if (count <= 1) listeners?.delete(listener);
    else listeners?.set(listener, count - 1);
    if (listeners?.size === 0) this.listeners.delete(event);
  }

  async detach(): Promise<void> {
    this.waits += 1;
    try {
      await this.#session.detach();
    } finally {
      this.waits -= 1;
    }
  }
}

class HangingGattResponseSession implements CdpSessionLike {
  readonly lifecycle: string[] = [];
  readonly #browserSession: CDPSession;
  readonly #hangingPageSession: CDPSession;

  constructor(browserSession: CDPSession, hangingPageSession: CDPSession) {
    this.#browserSession = browserSession;
    this.#hangingPageSession = hangingPageSession;
  }

  send(method: string, parameters?: object): Promise<unknown> {
    this.lifecycle.push(method);
    if (method === 'BluetoothEmulation.simulateGATTOperationResponse') {
      return this.#hangingPageSession.send('Runtime.evaluate', {
        expression: 'new Promise(() => {})',
        awaitPromise: true,
      });
    }
    return this.#browserSession.send(method, parameters);
  }

  on(event: string, listener: (payload: unknown) => void): void {
    this.#browserSession.on(event, listener);
  }

  off(event: string, listener: (payload: unknown) => void): void {
    this.#browserSession.off(event, listener);
  }

  async detach(): Promise<void> {
    this.lifecycle.push('browser-session.detach');
    try {
      await this.#hangingPageSession.detach();
    } finally {
      await this.#browserSession.detach();
    }
  }
}

async function createBackend(options: {
  readonly browser: Browser;
  readonly context: BrowserContext;
  readonly page: Page;
  readonly browserSession?: CdpSessionLike;
  readonly flushedSnapshots: BluetoothTimelineEvent[][];
  readonly releaseOrder: string[];
  readonly audit: ResourceAudit;
}): Promise<CdpBluetoothBackend> {
  const timeline = createBluetoothTimeline({
    limit: 200,
    clock: { now: () => performance.now() },
  });
  const browserSession =
    options.browserSession ?? (await options.browser.newBrowserCDPSession());
  return new CdpBluetoothBackendFactory({
    browserName: options.browser.browserType().name(),
    browserTransport: createCdpTransport(
      'browser',
      options.audit.session(browserSession),
    ),
    pageTransport: createCdpTransport(
      'page',
      options.audit.session(await options.context.newCDPSession(options.page)),
    ),
    inspectWebBluetoothEnvironment: () =>
      options.page.evaluate(() => ({
        secureContext: globalThis.isSecureContext,
        navigatorBluetooth: 'bluetooth' in globalThis.navigator,
      })),
    timeline,
    clock: { now: () => performance.now() },
    deadlineScheduler: options.audit.scheduler,
    operationDeadlineMs: 5_000,
    promptDeadlineMs: 5_000,
    teardownDeadlineMs: 5_000,
    async flushArtifacts(events) {
      options.releaseOrder.push('artifacts');
      options.flushedSnapshots.push([...events]);
    },
    releaseLease: async () => {
      options.releaseOrder.push('lease');
    },
  }).start({ centralState: 'powered-on' });
}

function waitForGattOperation(
  backend: CdpBluetoothBackend,
  deadlineMs = 5_000,
): Promise<GattOperationEvent> {
  return new Promise((resolve, reject) => {
    let unsubscribe = (): void => undefined;
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error('Timed out waiting for a GATT operation.'));
    }, deadlineMs);
    unsubscribe = backend.onEvent((event) => {
      if (event.kind !== 'gatt-operation') return;
      clearTimeout(timer);
      unsubscribe();
      resolve(event);
    });
  });
}

async function readSelection(page: Page): Promise<ApplicationSelection> {
  return page.evaluate(
    () =>
      (
        globalThis as unknown as {
          contractState: { selection: ApplicationSelection };
        }
      ).contractState.selection,
  );
}

describe('CdpBluetoothBackend real Chromium teardown contract', () => {
  it('disables before an in-flight detach, releases after artifacts, and gives the next lease an empty registry', async () => {
    const definition = validatePeripheralDefinition({
      address,
      name: 'GattLab teardown sensor',
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
    let firstContext: BrowserContext | undefined;
    let secondContext: BrowserContext | undefined;
    let firstBackend: CdpBluetoothBackend | undefined;
    let secondBackend: CdpBluetoothBackend | undefined;

    try {
      firstContext = await browser.newContext();
      const firstPage = await firstContext.newPage();
      await firstPage.goto(application.url);
      const hangingPageSession = await firstContext.newCDPSession(firstPage);
      const hangingBrowserSession = new HangingGattResponseSession(
        await browser.newBrowserCDPSession(),
        hangingPageSession,
      );
      const firstSnapshots: BluetoothTimelineEvent[][] = [];
      const firstReleaseOrder: string[] = [];
      const firstAudit = new ResourceAudit();
      firstBackend = await createBackend({
        browser,
        context: firstContext,
        page: firstPage,
        browserSession: hangingBrowserSession,
        flushedSnapshots: firstSnapshots,
        releaseOrder: firstReleaseOrder,
        audit: firstAudit,
      });
      await firstBackend.addPeripheral(definition.value);

      const firstPromptPromise = firstAudit.caller(
        firstBackend.waitForDevicePrompt(),
      );
      await firstPage
        .getByRole('button', { name: 'Choose teardown sensor' })
        .click();
      const firstPrompt = await firstPromptPromise;
      await expect
        .poll(() => firstPrompt.devices, { timeout: 5_000 })
        .toEqual([{ id: address, name: '' }]);
      await firstAudit.caller(firstPrompt.select(address));
      await firstPage.waitForFunction(
        () =>
          (
            globalThis as unknown as {
              contractState: { selection: ApplicationSelection };
            }
          ).contractState.selection.outcome === 'selected',
      );

      const operationPromise = firstAudit.caller(
        waitForGattOperation(firstBackend),
      );
      await firstPage
        .getByRole('button', { name: 'Connect teardown sensor' })
        .click();
      const operation = await operationPromise;
      const response = firstAudit.caller(
        firstBackend.respondToGattOperation({
          operationId: operation.operationId,
          type: 'connection',
          result: 'success',
        }),
      );
      const responseOutcome = response.then(
        () => undefined,
        (cause: unknown) => cause,
      );

      await firstAudit.caller(firstBackend.stop());
      expect(await responseOutcome).toBeInstanceOf(BluetoothCancelledError);
      expect(firstBackend.timeline.closed).toBe(true);
      expect(firstReleaseOrder).toEqual(['artifacts', 'lease']);
      expect(hangingBrowserSession.lifecycle.slice(-2)).toEqual([
        'BluetoothEmulation.disable',
        'browser-session.detach',
      ]);
      expect(firstSnapshots[0]).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'operation-late-completion',
            operationId: operation.operationId,
            status: 'cancelled',
            data: expect.objectContaining({ completion: 'protocol-failure' }),
          }),
          expect.objectContaining({
            type: 'pending-operation-settlement',
            status: 'succeeded',
          }),
        ]),
      );
      expect(firstAudit.snapshot()).toEqual({
        listeners: 0,
        transportWaits: 0,
        deadlines: 0,
        callerWaits: 0,
      });
      firstBackend = undefined;

      secondContext = await browser.newContext();
      const secondPage = await secondContext.newPage();
      await secondPage.goto(application.url);
      const secondSnapshots: BluetoothTimelineEvent[][] = [];
      const secondReleaseOrder: string[] = [];
      const secondAudit = new ResourceAudit();
      secondBackend = await createBackend({
        browser,
        context: secondContext,
        page: secondPage,
        flushedSnapshots: secondSnapshots,
        releaseOrder: secondReleaseOrder,
        audit: secondAudit,
      });

      const emptyPromptPromise = secondAudit.caller(
        secondBackend.waitForDevicePrompt(),
      );
      await secondPage
        .getByRole('button', { name: 'Choose teardown sensor' })
        .click();
      const emptyPrompt = await emptyPromptPromise;
      expect(emptyPrompt.devices).toEqual([]);
      await secondAudit.caller(emptyPrompt.cancel());
      await secondPage.waitForFunction(
        () =>
          (
            globalThis as unknown as {
              contractState: { selection: ApplicationSelection };
            }
          ).contractState.selection.outcome === 'cancelled',
      );
      expect(await readSelection(secondPage)).toEqual({
        outcome: 'cancelled',
        errorName: 'NotFoundError',
      });

      const secondCancelledWait = secondAudit
        .caller(secondBackend.waitForDevicePrompt())
        .then(
          () => undefined,
          (cause: unknown) => cause,
        );
      await secondAudit.caller(secondBackend.stop());
      expect(await secondCancelledWait).toBeInstanceOf(BluetoothCancelledError);
      expect(secondReleaseOrder).toEqual(['artifacts', 'lease']);
      expect(secondBackend.timeline.closed).toBe(true);
      expect(secondAudit.snapshot()).toEqual({
        listeners: 0,
        transportWaits: 0,
        deadlines: 0,
        callerWaits: 0,
      });
      expect(secondSnapshots[0]).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'pending-operation-settlement',
            status: 'succeeded',
          }),
        ]),
      );
      expect(
        secondSnapshots
          .flat()
          .some((event) => event.operationId === operation.operationId),
      ).toBe(false);
      secondBackend = undefined;
    } finally {
      await firstBackend?.stop().catch(() => undefined);
      await secondBackend?.stop().catch(() => undefined);
      if (firstContext !== undefined) await firstContext.close();
      if (secondContext !== undefined) await secondContext.close();
      await browser.close();
      await closeApplicationServer(application.server);
    }
  });
});
