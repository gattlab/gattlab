import {
  ioCharacteristicUuid,
  serviceUuid,
  writePayload,
} from '../../vanilla-ts/src/bluetooth-profile.js';

export interface BluetoothSnapshot {
  readonly status: string;
  readonly battery: string;
  readonly written: string;
  readonly errorCategory: string;
  readonly errorName: string;
  readonly errorMessage: string;
  readonly disconnectEvents: number;
  readonly busy: boolean;
}

export interface BluetoothSession {
  readonly getSnapshot: () => BluetoothSnapshot;
  readonly subscribe: (listener: () => void) => () => void;
  readonly connect: () => Promise<void>;
  readonly chooseOnly: () => Promise<void>;
  readonly dispose: () => void;
}

/** Own native Bluetooth objects outside the React component tree. */
export function createBluetoothSession(): BluetoothSession {
  let snapshot: BluetoothSnapshot = Object.freeze({
    status: 'app-ready',
    battery: '--',
    written: '--',
    errorCategory: '--',
    errorName: '--',
    errorMessage: '--',
    disconnectEvents: 0,
    busy: false,
  });
  const subscribers = new Set<() => void>();
  let device: BluetoothDevice | undefined;
  let server: BluetoothRemoteGATTServer | undefined;
  let service: BluetoothRemoteGATTService | undefined;
  let characteristic: BluetoothRemoteGATTCharacteristic | undefined;
  let disconnectListener: (() => void) | undefined;
  let disposed = false;

  function publish(patch: Partial<BluetoothSnapshot>): void {
    const next = { ...snapshot, ...patch };
    if (
      (Object.keys(next) as (keyof BluetoothSnapshot)[]).every(
        (key) => next[key] === snapshot[key],
      )
    ) {
      return;
    }
    snapshot = Object.freeze(next);
    for (const listener of subscribers) listener();
  }

  function removeDeviceListener(): void {
    if (device !== undefined && disconnectListener !== undefined) {
      device.removeEventListener('gattserverdisconnected', disconnectListener);
    }
    disconnectListener = undefined;
  }

  function selectDevice(selected: BluetoothDevice): void {
    removeDeviceListener();
    device = selected;
    disconnectListener = () => {
      server = undefined;
      service = undefined;
      characteristic = undefined;
      publish({
        status: 'disconnected',
        disconnectEvents: snapshot.disconnectEvents + 1,
        busy: false,
      });
    };
    device.addEventListener('gattserverdisconnected', disconnectListener);
  }

  function assertActive(): void {
    if (disposed) {
      throw new DOMException(
        'This Bluetooth session is disposed.',
        'InvalidStateError',
      );
    }
  }

  async function runSelection(connect: boolean): Promise<void> {
    if (disposed || snapshot.busy) return;
    publish({
      status: 'choosing',
      battery: '--',
      written: '--',
      errorCategory: '--',
      errorName: '--',
      errorMessage: '--',
      busy: true,
    });
    let category: 'chooser' | 'operation' = 'chooser';
    try {
      // Called synchronously from the click handler, before the first await.
      const selection = navigator.bluetooth.requestDevice({
        filters: [{ services: [serviceUuid] }],
      });
      const selected = await selection;
      assertActive();
      selectDevice(selected);
      if (!connect) {
        publish({ status: 'selected', busy: false });
        return;
      }
      category = 'operation';
      publish({ status: 'connecting' });
      if (selected.gatt === undefined) {
        throw new DOMException(
          'The selected device has no GATT server.',
          'NotSupportedError',
        );
      }
      server = await selected.gatt.connect();
      assertActive();
      service = await server.getPrimaryService(serviceUuid);
      assertActive();
      characteristic = await service.getCharacteristic(ioCharacteristicUuid);
      assertActive();
      const value = await characteristic.readValue();
      assertActive();
      await characteristic.writeValueWithResponse(new Uint8Array(writePayload));
      assertActive();
      publish({
        status: 'ready',
        battery: `${String(value.getUint8(0))}%`,
        written: writePayload.join(','),
        busy: false,
      });
    } catch (error) {
      if (disposed) return;
      publish({
        status: `${category}-error`,
        battery: '--',
        written: '--',
        errorCategory: category,
        errorName: error instanceof Error ? error.name : 'UnknownError',
        errorMessage: error instanceof Error ? error.message : String(error),
        busy: false,
      });
    }
  }

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      subscribers.add(listener);
      return () => {
        subscribers.delete(listener);
      };
    },
    connect: () => runSelection(true),
    chooseOnly: () => runSelection(false),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      removeDeviceListener();
      if (device?.gatt?.connected) device.gatt.disconnect();
      device = undefined;
      server = undefined;
      service = undefined;
      characteristic = undefined;
      publish({ status: 'disposed', busy: false });
      subscribers.clear();
    },
  };
}
