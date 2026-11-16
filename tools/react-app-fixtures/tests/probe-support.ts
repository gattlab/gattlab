import { spawn, type ChildProcess } from 'node:child_process';
import { appendFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import type { BluetoothLab } from '@gattlab/playwright';

// Independent expected test data. No import of untyped application JavaScript.
export const serviceUuid = '12345678-1234-5678-9abc-def123457000';
export const ioCharacteristicUuid = '12345678-1234-5678-9abc-def123457001';
export const writePayload = [16, 32, 48] as const;
export const notificationUuid = '12345678-1234-5678-9abc-def123457002';

export async function createProbePeripheral(
  bluetooth: BluetoothLab,
  address = '47:41:54:54:40:07',
) {
  const peripheral = await bluetooth.createPeripheral({
    address,
    name: 'GattLab React Sensor',
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
            descriptors: [
              {
                uuid: '12345678-1234-5678-9abc-def123457004',
                initialValue: [0],
              },
            ],
          },
          {
            uuid: '12345678-1234-5678-9abc-def123457003',
            properties: ['read'],
            initialValue: new TextEncoder().encode('1.0.0'),
          },
          {
            uuid: notificationUuid,
            properties: ['notify'],
            descriptors: [
              {
                uuid: '00002902-0000-1000-8000-00805f9b34fb',
                initialValue: [0, 0],
              },
            ],
          },
        ],
      },
    ],
  });
  return {
    peripheral,
    io: peripheral.characteristic(serviceUuid, ioCharacteristicUuid),
    notification: peripheral.characteristic(serviceUuid, notificationUuid),
  };
}

interface Application {
  readonly url: string;
  readonly child: ChildProcess;
  readonly exited: Promise<void>;
}

export async function startApplication(
  build: 'production' | 'development' = 'production',
): Promise<Application> {
  const child = spawn(
    process.execPath,
    ['app/server.mjs', `--build=${build}`],
    {
      cwd: fileURLToPath(new URL('../', import.meta.url)),
      env: { ...process.env, PORT: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-8192);
  });
  const exited = new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', () => resolve());
  });
  void exited.catch(() => undefined);
  const application = { url: '', child, exited };
  const lines = createInterface({ input: child.stdout });
  const announced = withDeadline(
    new Promise<string>((resolve, reject) => {
      lines.once('line', resolve);
      child.once('error', reject);
      void exited.then(
        () => reject(new Error(`Server exited before URL: ${stderr}`)),
        reject,
      );
    }),
  );
  void announced.catch(() => undefined);
  try {
    if (child.pid === undefined) throw new Error('Server has no PID');
    await appendFile(
      new URL('../server-pids.jsonl', import.meta.url),
      `${String(child.pid)}\n`,
      { mode: 0o600 },
    );
    const url = await announced;
    const address = new URL(url);
    if (
      address.protocol !== 'http:' ||
      address.hostname !== '127.0.0.1' ||
      address.port === ''
    ) {
      throw new Error(`Unexpected URL: ${url}`);
    }
    return { ...application, url };
  } catch (error) {
    try {
      await stopApplication(application);
    } catch (cleanupError) {
      console.error('Secondary server startup cleanup failure:', cleanupError);
    }
    throw error;
  } finally {
    lines.close();
  }
}

export async function stopApplication(application: Application): Promise<void> {
  if (
    application.child.exitCode === null &&
    application.child.signalCode === null
  )
    application.child.kill('SIGTERM');
  try {
    await withDeadline(application.exited);
  } catch (error) {
    application.child.kill('SIGKILL');
    await withDeadline(application.exited);
    throw error;
  }
}

function withDeadline<T>(operation: Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(
      () => reject(new Error('Server deadline exceeded (5000 ms)')),
      5000,
    );
  });
  return Promise.race([operation, deadline]).finally(() =>
    clearTimeout(timeout),
  );
}
