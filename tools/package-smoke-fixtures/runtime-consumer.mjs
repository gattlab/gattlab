import assert from 'node:assert/strict';

import * as cdp from '@gattlab/cdp';
import * as core from '@gattlab/core';
import * as playwright from '@gattlab/playwright';

const expectedCoreExports = [
  'BackendLifecycleController',
  'BluetoothBackendStoppedError',
  'BluetoothCancelledError',
  'BluetoothCapabilityUnsupportedError',
  'BluetoothConcurrentOperationError',
  'BluetoothLabAlreadyActiveError',
  'BluetoothPeripheralAlreadyRegisteredError',
  'BluetoothTimeoutError',
  'BluetoothValidationError',
  'GattLabError',
  'PeripheralAddressRegistry',
  'PromptDeviceNotFoundError',
  'attErrorNames',
  'bytes',
  'centralStates',
  'characteristicProperties',
  'copyBackendBluetoothEvent',
  'createBluetoothTimeline',
  'createCancellationController',
  'gattLabErrorCodes',
  'hciErrorNames',
  'normalizeBluetoothAddress',
  'normalizeBluetoothUuid',
  'runBestEffortBackendCleanup',
  'snapshotBluetoothCapabilities',
  'timelineCategories',
  'timelineStatuses',
  'validatePeripheralDefinition',
].sort();

const expectedCdpExports = [
  'CdpBluetoothBackendFactory',
  'CdpCapabilityProbe',
  'CdpTransport',
  'CdpTransportError',
  'attErrorCode',
  'attErrorCodes',
  'createCdpTransport',
  'hciErrorCode',
  'hciErrorCodes',
  'protocolSuccessCode',
].sort();

assert.deepEqual(Object.keys(core).sort(), expectedCoreExports);
assert.deepEqual(Object.keys(cdp).sort(), expectedCdpExports);
assert.deepEqual(Object.keys(playwright).sort(), [
  'BluetoothLab',
  'bytes',
  'expect',
  'test',
]);
assert.deepEqual([...playwright.bytes([1, 2, 3])], [1, 2, 3]);
