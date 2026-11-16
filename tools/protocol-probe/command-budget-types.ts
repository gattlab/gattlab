import type { BackendCallOptions, BluetoothTimeoutError } from '@gattlab/core';
import {
  CdpBluetoothBackendFactory,
  type CdpBluetoothBackendFactoryOptions,
  type CdpBluetoothBackend,
  type CdpLabInvalidation,
  type CdpCommandTimeout,
} from '@gattlab/cdp';

export function useDefault(
  options: CdpBluetoothBackendFactoryOptions,
): CdpBluetoothBackendFactory {
  return new CdpBluetoothBackendFactory(options);
}
export function useOverride(
  options: CdpBluetoothBackendFactoryOptions,
): CdpBluetoothBackendFactory {
  return new CdpBluetoothBackendFactory({
    ...options,
    commandDeadlineMs: 45000,
  });
}
export async function composeState(
  backend: CdpBluetoothBackend,
): Promise<void> {
  await backend.withCommandBudget(
    'setCentralState',
    'cdp',
    (options: BackendCallOptions) =>
      backend.setCentralState('powered-off', options),
  );
}
export function inspectTimeout(
  error: BluetoothTimeoutError,
): number | undefined {
  return (error as CdpCommandTimeout).deadlineCheck?.deadlineMs;
}
export function retainFirstCause(
  backend: CdpBluetoothBackend,
  listener: (record: CdpLabInvalidation) => void,
): () => void {
  return backend.onInvalidated(listener);
}
