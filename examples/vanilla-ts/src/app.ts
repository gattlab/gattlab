import {
  burstPayloads,
  descriptorWritePayload,
  firmwareCharacteristicUuid,
  ioCharacteristicUuid,
  ioDescriptorUuid,
  notificationCharacteristicUuid,
  serviceUuid,
  writePayload,
  withoutResponsePayload,
} from './bluetooth-profile.js';

function requiredElement(selector: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(selector);
  if (element === null)
    throw new Error(`Missing application element: ${selector}`);
  return element;
}

const status = requiredElement('[data-testid="status"]');
const battery = requiredElement('[data-testid="battery"]');
const written = requiredElement('[data-testid="written"]');
const errorName = requiredElement('[data-testid="error-name"]');
const errorMessage = requiredElement('[data-testid="error-message"]');

let notificationCharacteristic: BluetoothRemoteGATTCharacteristic | undefined;
let regressionService: BluetoothRemoteGATTService | undefined;

function setStatus(value: string): void {
  status.textContent = value;
}

function clearError(): void {
  errorName.textContent = '--';
  errorMessage.textContent = '--';
}

function showError(operation: string, error: unknown): void {
  setStatus(`${operation}-error`);
  errorName.textContent = error instanceof Error ? error.name : 'UnknownError';
  errorMessage.textContent =
    error instanceof Error ? error.message : String(error);
}

async function chooseDevice(): Promise<BluetoothDevice> {
  const selected = await navigator.bluetooth.requestDevice({
    filters: [{ services: [serviceUuid] }],
  });
  selected.addEventListener('gattserverdisconnected', () => {
    regressionService = undefined;
    setStatus('disconnected');
  });
  return selected;
}

async function connectAndGetService(): Promise<BluetoothRemoteGATTService> {
  const selected = await chooseDevice();
  if (selected.gatt === undefined) {
    throw new DOMException(
      'The selected device has no GATT server.',
      'NotSupportedError',
    );
  }
  const server = await selected.gatt.connect();
  return server.getPrimaryService(serviceUuid);
}

requiredElement('#connect').addEventListener('click', async () => {
  clearError();
  setStatus('connecting');
  try {
    const service = await connectAndGetService();
    const characteristic =
      await service.getCharacteristic(ioCharacteristicUuid);
    const value = await characteristic.readValue();
    battery.textContent = `${String(value.getUint8(0))}%`;
    await characteristic.writeValueWithResponse(new Uint8Array(writePayload));
    written.textContent = writePayload.join(',');
    setStatus('ready');
  } catch (error) {
    showError('operation', error);
  }
});

requiredElement('#cancel').addEventListener('click', async () => {
  clearError();
  setStatus('choosing');
  try {
    await chooseDevice();
    setStatus('selected');
  } catch (error) {
    showError('chooser', error);
  }
});

requiredElement('#availability').addEventListener('click', async () => {
  clearError();
  setStatus('checking-availability');
  try {
    const available = await navigator.bluetooth.getAvailability();
    setStatus(available ? 'available' : 'unavailable');
  } catch (error) {
    showError('availability', error);
  }
});

requiredElement('#subscribe').addEventListener('click', async () => {
  clearError();
  setStatus('subscribing');
  try {
    const service = await connectAndGetService();
    notificationCharacteristic = await service.getCharacteristic(
      notificationCharacteristicUuid,
    );
    await notificationCharacteristic.startNotifications();
    setStatus('subscribed');
  } catch (error) {
    showError('subscription', error);
  }
});

requiredElement('#unsubscribe').addEventListener('click', async () => {
  clearError();
  setStatus('unsubscribing');
  try {
    if (notificationCharacteristic === undefined) {
      throw new DOMException(
        'Subscribe before unsubscribing.',
        'InvalidStateError',
      );
    }
    await notificationCharacteristic.stopNotifications();
    setStatus('unsubscribed');
  } catch (error) {
    showError('unsubscription', error);
  }
});

function registerAttributeAction(
  selector: string,
  pending: string,
  completed: string,
  operation: (service: BluetoothRemoteGATTService) => Promise<void>,
): void {
  requiredElement(selector).addEventListener('click', async () => {
    clearError();
    setStatus(pending);
    try {
      regressionService ??= await connectAndGetService();
      await operation(regressionService);
      setStatus(completed);
    } catch (error) {
      showError('operation', error);
    }
  });
}

registerAttributeAction(
  '#read-both',
  'reading-both',
  'both-read',
  async (service) => {
    const io = await service.getCharacteristic(ioCharacteristicUuid);
    const value = await io.readValue();
    requiredElement('[data-testid="regression-battery"]').textContent =
      `${String(value.getUint8(0))}%`;
    const firmware = await service.getCharacteristic(
      firmwareCharacteristicUuid,
    );
    const revision = await firmware.readValue();
    requiredElement('[data-testid="firmware"]').textContent =
      new TextDecoder().decode(revision);
  },
);

registerAttributeAction(
  '#read-descriptor',
  'reading-descriptor',
  'descriptor-read',
  async (service) => {
    const io = await service.getCharacteristic(ioCharacteristicUuid);
    const descriptor = await io.getDescriptor(ioDescriptorUuid);
    const value = await descriptor.readValue();
    requiredElement('[data-testid="descriptor-read"]').textContent = Array.from(
      new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
    ).join(',');
  },
);

registerAttributeAction(
  '#write-descriptor',
  'writing-descriptor',
  'descriptor-written',
  async (service) => {
    const io = await service.getCharacteristic(ioCharacteristicUuid);
    const descriptor = await io.getDescriptor(ioDescriptorUuid);
    await descriptor.writeValue(new Uint8Array(descriptorWritePayload));
    requiredElement('[data-testid="descriptor-written"]').textContent =
      descriptorWritePayload.join(',');
  },
);

registerAttributeAction(
  '#write-without-response',
  'writing-without-response',
  'without-response-written',
  async (service) => {
    const io = await service.getCharacteristic(ioCharacteristicUuid);
    await io.writeValueWithoutResponse(new Uint8Array(withoutResponsePayload));
    requiredElement('[data-testid="without-response-written"]').textContent =
      withoutResponsePayload.join(',');
  },
);

registerAttributeAction(
  '#write-burst',
  'writing-burst',
  'burst-written',
  async (service) => {
    const io = await service.getCharacteristic(ioCharacteristicUuid);
    const completed = requiredElement('[data-testid="burst-completed"]');
    completed.textContent = '0';
    for (const [index, payload] of burstPayloads.entries()) {
      await io.writeValueWithResponse(new Uint8Array(payload));
      completed.textContent = String(index + 1);
    }
  },
);
