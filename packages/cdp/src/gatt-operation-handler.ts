import {
  BluetoothValidationError,
  hciErrorNames,
  normalizeBluetoothAddress,
  type BluetoothAddress,
  type BluetoothTimeline,
  type GattOperationEvent,
  type GattOperationResponse,
  type GattOperationType,
  type HciErrorName,
} from '@gattlab/core';

import type { CdpEntityRegistry } from './entity-registry.js';
import { hciErrorCode, protocolSuccessCode } from './error-codes.js';
import type { PendingOperationRegistry } from './pending-operation-registry.js';
import type { CdpTransport } from './transport.js';

export interface CdpGattOperationHandlerOptions {
  readonly transport: CdpTransport<'browser'>;
  readonly entities: CdpEntityRegistry;
  readonly pendingOperations: PendingOperationRegistry;
  readonly timeline: BluetoothTimeline;
}

export type GattOperationListener = (event: GattOperationEvent) => void;
export type GattOperationErrorListener = (cause: unknown) => void;

/** Internal CDP mapping for peripheral-level GATT operations. */
export class CdpGattOperationHandler {
  readonly #transport: CdpTransport<'browser'>;
  readonly #entities: CdpEntityRegistry;
  readonly #pendingOperations: PendingOperationRegistry;
  readonly #timeline: BluetoothTimeline;
  #unsubscribe: (() => void) | undefined;

  constructor(options: CdpGattOperationHandlerOptions) {
    this.#transport = options.transport;
    this.#entities = options.entities;
    this.#pendingOperations = options.pendingOperations;
    this.#timeline = options.timeline;
  }

  subscribe(
    listener: GattOperationListener,
    onError: GattOperationErrorListener,
  ): () => void {
    if (typeof listener !== 'function') {
      throw new TypeError('GATT operation listener must be a function.');
    }
    if (typeof onError !== 'function') {
      throw new TypeError('GATT operation error listener must be a function.');
    }
    if (this.#unsubscribe !== undefined) {
      throw new TypeError('A GATT operation listener is already subscribed.');
    }

    const unsubscribeTransport = this.#transport.on(
      'BluetoothEmulation.gattOperationReceived',
      (payload) => {
        let registrationStarted = false;
        let registeredOperationId: string | undefined;
        let deliveryStarted = false;
        try {
          const address = this.#requireRegisteredAddress(
            payload.address,
            'event',
          );
          const type = requireGattOperationType(payload.type);
          registrationStarted = true;
          const event = this.#pendingOperations.register({
            kind: 'gatt-operation',
            peripheral: Object.freeze({ kind: 'peripheral', address }),
            type,
          });
          registeredOperationId = event.operationId;
          if (event.kind !== 'gatt-operation') {
            throw new TypeError(
              'Pending operation registry returned a non-GATT event.',
            );
          }
          deliveryStarted = true;
          listener(event);
        } catch (cause) {
          if (registeredOperationId !== undefined) {
            this.#pendingOperations.cancel(
              registeredOperationId,
              deliveryStarted ? 'listener-failed' : 'invalid-registered-event',
            );
          } else if (!registrationStarted) {
            this.#timeline.append({
              category: 'gatt',
              type: 'gatt-event-rejected',
              status: 'failed',
              data: {
                reason: gattEventRejectionReason(cause),
                source: 'event',
              },
            });
          }
          onError(cause);
        }
      },
    );
    let subscribed = true;
    const unsubscribe = (): void => {
      if (!subscribed) return;
      subscribed = false;
      unsubscribeTransport();
      if (this.#unsubscribe === unsubscribe) this.#unsubscribe = undefined;
    };
    this.#unsubscribe = unsubscribe;
    return unsubscribe;
  }

  async respond(
    response: GattOperationResponse,
    transport: Pick<CdpTransport<'browser'>, 'send'> = this.#transport,
  ): Promise<void> {
    const code =
      response.result === 'success'
        ? protocolSuccessCode
        : hciErrorCode(requireHciErrorName(response.error));
    await this.#pendingOperations.respondToGattOperation(
      response,
      async (event) => {
        await transport.send(
          'BluetoothEmulation.simulateGATTOperationResponse',
          {
            address: event.peripheral.address,
            type: event.type,
            code,
          },
        );
      },
    );
  }

  async disconnect(
    address: BluetoothAddress,
    transport: Pick<CdpTransport<'browser'>, 'send'> = this.#transport,
  ): Promise<void> {
    const registeredAddress = this.#requireRegisteredAddress(
      address,
      'disconnect',
    );
    await transport.send('BluetoothEmulation.simulateGATTDisconnection', {
      address: registeredAddress,
    });
  }

  #requireRegisteredAddress(
    value: unknown,
    source: 'event' | 'disconnect',
  ): BluetoothAddress {
    let address: BluetoothAddress;
    try {
      address = normalizeBluetoothAddress(value as string);
    } catch (cause) {
      throw new BluetoothValidationError(
        `The ${source === 'event' ? 'Chromium GATT event' : 'GATT disconnection'} has an invalid peripheral address.`,
        {
          cause,
          context: {
            reason: 'invalid-peripheral-address',
            source,
          },
        },
      );
    }
    if (this.#entities.getPeripheral(address) === undefined) {
      throw new BluetoothValidationError(
        `Bluetooth peripheral ${address} is not registered.`,
        {
          context: {
            address,
            reason: 'unknown-peripheral-address',
            source,
          },
        },
      );
    }
    return address;
  }
}

function requireGattOperationType(value: unknown): GattOperationType {
  if (value === 'connection' || value === 'discovery') return value;
  throw new BluetoothValidationError(
    'The Chromium GATT event has an invalid operation type.',
    {
      context: {
        reason: 'invalid-gatt-operation-type',
        receivedType: typeof value === 'string' ? value : typeof value,
      },
    },
  );
}

function requireHciErrorName(value: unknown): HciErrorName {
  if (
    typeof value === 'string' &&
    (hciErrorNames as readonly string[]).includes(value)
  ) {
    return value as HciErrorName;
  }
  throw new BluetoothValidationError(
    'The GATT response has an unknown HCI error name.',
    {
      context: {
        reason: 'unknown-hci-error-name',
        receivedError: typeof value === 'string' ? value : typeof value,
      },
    },
  );
}

function gattEventRejectionReason(cause: unknown): string {
  if (cause instanceof BluetoothValidationError) {
    const reason = cause.context['reason'];
    if (typeof reason === 'string') return reason;
  }
  return 'event-processing-failed';
}
