import { spawn, type ChildProcess } from 'node:child_process';
import { appendFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

import type {
  BluetoothLab,
  CharacteristicHandle,
  PeripheralHandle,
} from '@gattlab/playwright';

import {
  clientCharacteristicConfigurationUuid,
  firmwareCharacteristicUuid,
  ioCharacteristicUuid,
  ioDescriptorUuid,
  notificationCharacteristicUuid,
  serviceUuid,
} from '../app/dist/bluetooth-profile.js';

interface Application {
  readonly url: string;
  readonly child: ChildProcess;
  readonly exited: Promise<void>;
}

interface ProbePeripheral {
  readonly peripheral: PeripheralHandle;
  readonly io: CharacteristicHandle;
  readonly notification: CharacteristicHandle;
}

export const peripheralAddress = '47:41:54:54:40:07';
export const secondPeripheralAddress = '47:41:54:54:40:08';

export function peripheralDefinition(
  address = peripheralAddress,
  name = 'GattLab Vanilla Sensor',
): Parameters<BluetoothLab['createPeripheral']>[0] {
  return {
    address,
    name,
    manufacturerData: [{ companyId: 0x0477, data: [222, 173, 190, 239] }],
    advertisement: { rssi: -42 },
    services: [
      {
        uuid: serviceUuid,
        characteristics: [
          {
            uuid: ioCharacteristicUuid,
            properties: ['read', 'write', 'write-without-response'],
            initialValue: [87],
            descriptors: [{ uuid: ioDescriptorUuid, initialValue: [0] }],
          },
          {
            uuid: firmwareCharacteristicUuid,
            properties: ['read'],
            initialValue: new TextEncoder().encode('1.0.0'),
          },
          {
            uuid: notificationCharacteristicUuid,
            properties: ['notify'],
            descriptors: [
              {
                uuid: clientCharacteristicConfigurationUuid,
                initialValue: [0, 0],
              },
            ],
          },
        ],
      },
    ],
  };
}

export async function startApplication(): Promise<Application> {
  const child = spawn(process.execPath, ['app/server.mjs'], {
    cwd: fileURLToPath(new URL('../', import.meta.url)),
    env: { ...process.env, PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-8_192);
  });
  const exited = new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', () => resolve());
  });
  // Observe exit errors immediately, including while startup is pending.
  void exited.catch(() => undefined);
  const application = { url: '', child, exited };
  const lines = createInterface({ input: child.stdout });
  const announcedUrl = withDeadline(
    new Promise<string>((resolve, reject) => {
      lines.once('line', resolve);
      child.once('error', reject);
      void exited.then(
        () =>
          reject(
            new Error(
              `Application server exited before announcing its URL: ${stderr}`,
            ),
          ),
        reject,
      );
    }),
    'Application server did not announce its URL',
  );
  // Registration awaits filesystem I/O; observe startup failure in the meantime.
  void announcedUrl.catch(() => undefined);
  try {
    if (child.pid === undefined)
      throw new Error('Application server has no PID.');
    await appendFile(
      new URL('../server-pids.jsonl', import.meta.url),
      `${String(child.pid)}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
    const url = await announcedUrl;
    const address = new URL(url);
    if (
      address.protocol !== 'http:' ||
      address.hostname !== '127.0.0.1' ||
      address.port === ''
    ) {
      throw new Error(`Unexpected application server URL: ${url}`);
    }
    return { ...application, url };
  } catch (error) {
    await stopApplication(application);
    throw error;
  } finally {
    lines.close();
  }
}

export async function stopApplication(application: Application): Promise<void> {
  if (
    application.child.exitCode === null &&
    application.child.signalCode === null
  ) {
    application.child.kill('SIGTERM');
  }
  try {
    await withDeadline(
      application.exited,
      'Application server did not exit after SIGTERM',
    );
  } catch (error) {
    application.child.kill('SIGKILL');
    await withDeadline(
      application.exited,
      'Application server did not exit after SIGKILL',
    );
    throw error;
  }
}

function withDeadline<T>(operation: Promise<T>, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(
      () => reject(new Error(`${message} within 5000 ms.`)),
      5_000,
    );
  });
  return Promise.race([operation, deadline]).finally(() =>
    clearTimeout(timeout),
  );
}

export async function createProbePeripheral(
  bluetooth: BluetoothLab,
): Promise<ProbePeripheral> {
  const peripheral = await bluetooth.createPeripheral(peripheralDefinition());
  return {
    peripheral,
    io: peripheral.characteristic(serviceUuid, ioCharacteristicUuid),
    notification: peripheral.characteristic(
      serviceUuid,
      notificationCharacteristicUuid,
    ),
  };
}

export async function createSecondProbePeripheral(
  bluetooth: BluetoothLab,
): Promise<ProbePeripheral> {
  const peripheral = await bluetooth.createPeripheral(
    peripheralDefinition(secondPeripheralAddress, 'GattLab Vanilla Sensor B'),
  );
  return {
    peripheral,
    io: peripheral.characteristic(serviceUuid, ioCharacteristicUuid),
    notification: peripheral.characteristic(
      serviceUuid,
      notificationCharacteristicUuid,
    ),
  };
}
