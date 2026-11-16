import type { CDPSession } from 'playwright';

import {
  CdpBluetoothBackendFactory,
  CdpCapabilityProbe,
  createCdpTransport,
  type CdpBluetoothBackendFactoryOptions,
  type CdpDevicePrompt,
  type CdpDevicePromptCandidate,
  type CdpSessionLike,
} from '../src/index.js';

declare const playwrightSession: CDPSession;
declare const backendFactoryOptions: CdpBluetoothBackendFactoryOptions;

export const compatibleSession: CdpSessionLike = playwrightSession;
const browserTransport = createCdpTransport('browser', compatibleSession);
const pageTransport = createCdpTransport('page', compatibleSession);

export async function exerciseTypedTransport(): Promise<void> {
  const browserVersion = await browserTransport.send('Browser.getVersion');
  const browserProduct: string = browserVersion.product;
  void browserProduct;

  const service = await browserTransport.send('BluetoothEmulation.addService', {
    address: '00:11:22:33:44:55',
    serviceUuid: '0000180f-0000-1000-8000-00805f9b34fb',
  });
  const serviceId: string = service.serviceId;
  void serviceId;

  await pageTransport.send('DeviceAccess.selectPrompt', {
    id: 'prompt-1',
    deviceId: '00:11:22:33:44:55',
  });

  // @ts-expect-error DeviceAccess is page-session scoped.
  await browserTransport.send('DeviceAccess.enable');

  // @ts-expect-error BluetoothEmulation is browser-session scoped.
  await pageTransport.send('BluetoothEmulation.disable');

  // @ts-expect-error Browser identity is browser-session scoped.
  await pageTransport.send('Browser.getVersion');

  // @ts-expect-error addService requires its request parameters.
  await browserTransport.send('BluetoothEmulation.addService');
}

export async function exerciseCapabilityProbe(): Promise<void> {
  const capabilities = await new CdpCapabilityProbe({
    browserName: 'chromium',
    browserTransport,
    pageTransport,
    inspectWebBluetoothEnvironment: async () => ({
      secureContext: true,
      navigatorBluetooth: true,
    }),
  }).probe();
  const secondaryServices: boolean = capabilities.operations.secondaryServices;
  void secondaryServices;
}

export async function exerciseBackendFactory(): Promise<void> {
  const backend = await new CdpBluetoothBackendFactory(
    backendFactoryOptions,
  ).start({ centralState: 'powered-on' });
  const timelineClosed: boolean = backend.timeline.closed;
  const waitingForPrompt: Promise<CdpDevicePrompt> =
    backend.waitForDevicePrompt();
  const prompt = await waitingForPrompt;
  const candidates: readonly CdpDevicePromptCandidate[] = prompt.devices;
  void timelineClosed;
  void candidates;
  await backend.stop();
}

export const omittedCommandBudget = new CdpBluetoothBackendFactory(
  backendFactoryOptions,
);
export const explicitCommandBudget = new CdpBluetoothBackendFactory({
  ...backendFactoryOptions,
  commandDeadlineMs: 45000,
});
export async function exerciseTerminalIntegration(): Promise<void> {
  const backend = await explicitCommandBudget.start({
    centralState: 'powered-on',
  });
  const unsubscribe = backend.onInvalidated((record) => {
    const reason:
      'adapter-lost' | 'fixture-page-closed' | 'model-outcome-unknown' =
      record.reason;
    void reason;
  });
  backend.assertUsable('addPeripheral');
  await backend.checkLiveness('waitForDevicePrompt');
  await backend.withCommandBudget('setCentralState', 'cdp', (options) =>
    backend.setCentralState('powered-off', options),
  );
  const prompt = await backend.waitForDevicePrompt({
    deadlineMs: 100,
    operationLayer: 'cdp',
  });
  await backend.withCommandBudget('cancel', 'cdp', (options) =>
    prompt.cancel(options),
  );
  unsubscribe();
  await backend.stop();
}
