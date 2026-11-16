import {
  ioCharacteristicUuid,
  notificationCharacteristicUuid,
  serviceUuid,
  writePayload,
} from './bluetooth-profile.js';

function failure(sessionId, category, error, partial = {}) {
  return {
    ...partial,
    sessionId,
    success: false,
    error: {
      category: error instanceof DOMException ? category : 'interop',
      name: error.name,
      message: error.message,
    },
  };
}

function requestSelection() {
  return navigator.bluetooth.requestDevice({
    filters: [{ services: [serviceUuid] }],
  });
}

// One session per Razor owner. All state lives in this closure, so two
// sessions never share a device, listener, receiver, identity, or disposed flag.
export function createSession(sessionId, panelReceiver, diagnosticsReceiver) {
  let receiver = panelReceiver;
  let device;
  let notificationCharacteristic;
  let disposed = false;
  const listeners = [];

  function disposedResult() {
    return { sessionId, success: false, disposed: true };
  }

  // The only native listener registration. It reports to the application-level
  // diagnostics before the disposed guard, so a listener that outlives its
  // session is visible even though the guard suppresses the panel callback.
  function listen(target, type, handler) {
    const observed = (event) => {
      diagnosticsReceiver
        .invokeMethodAsync('OnNativeEvent', sessionId, type)
        .catch((error) => console.error('Bluetooth diagnostics failed', error));
      if (!disposed) handler(event);
    };
    target.addEventListener(type, observed);
    listeners.push({ target, type, observed });
  }

  function release() {
    for (const { target, type, observed } of listeners.splice(0))
      target.removeEventListener(type, observed);
  }

  function forgetDevice() {
    // Listeners go first: this session's own disconnect must not call back.
    release();
    if (device?.gatt.connected) device.gatt.disconnect();
    device = undefined;
    notificationCharacteristic = undefined;
  }

  function retainDevice(selected) {
    forgetDevice();
    device = selected;
    listen(device, 'gattserverdisconnected', onDisconnected);
  }

  function onDisconnected() {
    receiver
      .invokeMethodAsync('OnDisconnected', sessionId)
      .catch((error) =>
        console.error('Bluetooth disconnect callback failed', error),
      );
  }

  async function connectService() {
    const server = await device.gatt.connect();
    return server.getPrimaryService(serviceUuid);
  }

  // Each action starts the native chooser synchronously, within the Razor
  // click gesture, and settles as `disposed` once its owner is released.
  async function selectDevice() {
    const selected = await requestSelection();
    // A prompt that settles after dispose must not connect for the released owner.
    if (disposed) return undefined;
    retainDevice(selected);
    return selected;
  }

  async function connectReadWrite() {
    if (disposed) return disposedResult();
    let selected;
    try {
      selected = await selectDevice();
    } catch (error) {
      return disposed ? disposedResult() : failure(sessionId, 'chooser', error);
    }
    if (selected === undefined) return disposedResult();
    try {
      const service = await connectService();
      const characteristic =
        await service.getCharacteristic(ioCharacteristicUuid);
      const value = await characteristic.readValue();
      const battery = value.getUint8(0);
      try {
        await characteristic.writeValueWithResponse(
          new Uint8Array(writePayload),
        );
      } catch (error) {
        // Partial success: the completed read survives a rejected write.
        if (disposed) return disposedResult();
        return failure(sessionId, 'operation', error, {
          battery,
          failedStep: 'write',
        });
      }
      if (disposed) return disposedResult();
      return {
        sessionId,
        success: true,
        battery,
        written: Array.from(writePayload),
      };
    } catch (error) {
      return disposed
        ? disposedResult()
        : failure(sessionId, 'operation', error);
    }
  }

  async function chooseOnly() {
    if (disposed) return disposedResult();
    try {
      const selected = await selectDevice();
      if (selected === undefined) return disposedResult();
      return { sessionId, success: true };
    } catch (error) {
      return disposed ? disposedResult() : failure(sessionId, 'chooser', error);
    }
  }

  async function checkAvailability() {
    if (disposed) return disposedResult();
    try {
      const available = await navigator.bluetooth.getAvailability();
      if (disposed) return disposedResult();
      return { sessionId, success: true, available };
    } catch (error) {
      return disposed
        ? disposedResult()
        : failure(sessionId, 'availability', error);
    }
  }

  async function subscribe() {
    if (disposed) return disposedResult();
    let selected;
    try {
      selected = await selectDevice();
    } catch (error) {
      return disposed ? disposedResult() : failure(sessionId, 'chooser', error);
    }
    if (selected === undefined) return disposedResult();
    try {
      const service = await connectService();
      const characteristic = await service.getCharacteristic(
        notificationCharacteristicUuid,
      );
      await characteristic.startNotifications();
      if (disposed) return disposedResult();
      notificationCharacteristic = characteristic;
      return { sessionId, success: true };
    } catch (error) {
      return disposed
        ? disposedResult()
        : failure(sessionId, 'operation', error);
    }
  }

  async function unsubscribe() {
    if (disposed) return disposedResult();
    try {
      if (notificationCharacteristic === undefined)
        throw new DOMException(
          'Subscribe before unsubscribing.',
          'InvalidStateError',
        );
      // Kept across a disconnect on purpose: the browser reports that state.
      await notificationCharacteristic.stopNotifications();
      if (disposed) return disposedResult();
      return { sessionId, success: true };
    } catch (error) {
      return disposed
        ? disposedResult()
        : failure(sessionId, 'operation', error);
    }
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    receiver = undefined;
    forgetDevice();
  }

  return {
    connectReadWrite,
    chooseOnly,
    checkAvailability,
    subscribe,
    unsubscribe,
    dispose,
  };
}
