import { BluetoothLabAlreadyActiveError } from '@gattlab/core';

import { CdpTransportError } from './transport.js';

const alreadyEnabledProtocolMessage = 'BluetoothEmulation already enabled';

/** Identifies the pinned Chromium response for a process-wide domain conflict. */
export function isBluetoothEmulationAlreadyEnabledError(
  cause: unknown,
): cause is CdpTransportError {
  return (
    cause instanceof CdpTransportError &&
    cause.kind === 'command-failed' &&
    cause.target === 'browser' &&
    cause.method === 'BluetoothEmulation.enable' &&
    hasExactProtocolMessage(errorMessage(cause.cause))
  );
}

/** Maps a proven cross-client domain conflict to the public lifecycle error. */
export function bluetoothEmulationAlreadyActiveError(
  cause: CdpTransportError,
): BluetoothLabAlreadyActiveError {
  return new BluetoothLabAlreadyActiveError(
    'A GattLab runtime is already active in this browser process. Playwright connectOptions and shared browser servers allow only one active lab at a time; use a separate browser process for an independent concurrent lab.',
    {
      cause,
      context: {
        leaseScope: 'browser-process',
        remediation: 'use-separate-browser-process',
        detection: 'cdp-domain-conflict',
      },
    },
  );
}

function errorMessage(cause: unknown): string | undefined {
  if (typeof cause !== 'object' || cause === null) return undefined;
  const message = (cause as { readonly message?: unknown }).message;
  return typeof message === 'string' ? message : undefined;
}

function hasExactProtocolMessage(message: string | undefined): boolean {
  return (
    message === alreadyEnabledProtocolMessage ||
    message?.endsWith(`: ${alreadyEnabledProtocolMessage}`) === true
  );
}
