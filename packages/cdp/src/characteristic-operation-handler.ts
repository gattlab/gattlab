import {
  attErrorNames,
  BluetoothValidationError,
  bytes,
  type AttErrorName,
  type BluetoothTimeline,
  type CharacteristicOperationEvent,
  type CharacteristicOperationResponse,
  type CharacteristicOperationType,
  type CharacteristicWriteType,
} from '@gattlab/core';

import { encodeBase64 } from './base64.js';
import type {
  CdpEntityRegistry,
  RegisteredCdpCharacteristic,
} from './entity-registry.js';
import { attErrorCode, protocolSuccessCode } from './error-codes.js';
import type { PendingOperationRegistry } from './pending-operation-registry.js';
import type { CdpEventPayload, CdpTransport } from './transport.js';

type CharacteristicOperationPayload =
  CdpEventPayload<'BluetoothEmulation.characteristicOperationReceived'>;

export interface CdpCharacteristicOperationHandlerOptions {
  readonly transport: CdpTransport<'browser'>;
  readonly entities: CdpEntityRegistry;
  readonly pendingOperations: PendingOperationRegistry;
  readonly timeline: BluetoothTimeline;
}

export type CharacteristicOperationListener = (
  event: CharacteristicOperationEvent,
) => void;
export type CharacteristicOperationErrorListener = (cause: unknown) => void;

/** Internal CDP mapping for characteristic operations. */
export class CdpCharacteristicOperationHandler {
  readonly #transport: CdpTransport<'browser'>;
  readonly #entities: CdpEntityRegistry;
  readonly #pendingOperations: PendingOperationRegistry;
  readonly #timeline: BluetoothTimeline;
  #unsubscribe: (() => void) | undefined;

  constructor(options: CdpCharacteristicOperationHandlerOptions) {
    this.#transport = options.transport;
    this.#entities = options.entities;
    this.#pendingOperations = options.pendingOperations;
    this.#timeline = options.timeline;
  }

  subscribe(
    listener: CharacteristicOperationListener,
    onError: CharacteristicOperationErrorListener,
  ): () => void {
    if (typeof listener !== 'function') {
      throw new TypeError(
        'Characteristic operation listener must be a function.',
      );
    }
    if (typeof onError !== 'function') {
      throw new TypeError(
        'Characteristic operation error listener must be a function.',
      );
    }
    if (this.#unsubscribe !== undefined) {
      throw new TypeError(
        'A characteristic operation listener is already subscribed.',
      );
    }

    const unsubscribeTransport = this.#transport.on(
      'BluetoothEmulation.characteristicOperationReceived',
      (payload) => {
        let registrationStarted = false;
        let registeredOperationId: string | undefined;
        let deliveryStarted = false;
        try {
          const characteristic = this.#requireCharacteristic(
            payload.characteristicId,
          );
          const type = requireCharacteristicOperationType(payload.type);
          const input = characteristicOperationInput(
            characteristic,
            type,
            payload,
          );
          registrationStarted = true;
          const event = this.#pendingOperations.register(input);
          registeredOperationId = event.operationId;
          if (event.kind !== 'characteristic-operation') {
            throw new TypeError(
              'Pending operation registry returned a non-characteristic event.',
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
              category: 'characteristic',
              type: 'characteristic-event-rejected',
              status: 'failed',
              data: {
                reason: characteristicEventRejectionReason(cause),
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
    response: CharacteristicOperationResponse,
    transport: Pick<CdpTransport<'browser'>, 'send'> = this.#transport,
  ): Promise<void> {
    const protocolResponse = prepareCharacteristicResponse(response);
    await this.#pendingOperations.respondToCharacteristicOperation(
      response,
      async (event) => {
        const characteristic = this.#entities.getCharacteristicByReference(
          event.characteristic,
        );
        if (characteristic === undefined) {
          throw new BluetoothValidationError(
            'The pending characteristic is no longer registered.',
            {
              context: {
                reason: 'stale-characteristic-reference',
              },
            },
          );
        }
        await transport.send(
          'BluetoothEmulation.simulateCharacteristicOperationResponse',
          {
            characteristicId: characteristic.id,
            type: event.type,
            code: protocolResponse.code,
            ...(protocolResponse.data === undefined
              ? {}
              : { data: protocolResponse.data }),
          },
        );
      },
    );
  }

  #requireCharacteristic(value: unknown): RegisteredCdpCharacteristic {
    if (typeof value === 'string') {
      const characteristic = this.#entities.getCharacteristic(value);
      if (characteristic !== undefined) return characteristic;
    }
    throw new BluetoothValidationError(
      'The Chromium characteristic event references an unregistered characteristic.',
      {
        context: {
          reason: 'unknown-characteristic-id',
          receivedIdType: typeof value,
          source: 'event',
        },
      },
    );
  }
}

function characteristicOperationInput(
  characteristic: RegisteredCdpCharacteristic,
  type: CharacteristicOperationType,
  payload: CharacteristicOperationPayload,
) {
  if (type === 'write') {
    return {
      kind: 'characteristic-operation' as const,
      characteristic: characteristic.reference,
      type,
      writeType: requireCharacteristicWriteType(payload.writeType),
      data: decodeCharacteristicWriteData(payload.data),
    };
  }
  if (payload.data !== undefined || payload.writeType !== undefined) {
    throw new BluetoothValidationError(
      'The Chromium characteristic event has unexpected write fields.',
      {
        context: {
          reason: 'unexpected-characteristic-write-fields',
          operationType: type,
          hasData: payload.data !== undefined,
          hasWriteType: payload.writeType !== undefined,
        },
      },
    );
  }
  return {
    kind: 'characteristic-operation' as const,
    characteristic: characteristic.reference,
    type,
  };
}

function requireCharacteristicOperationType(
  value: unknown,
): CharacteristicOperationType {
  if (
    value === 'read' ||
    value === 'write' ||
    value === 'subscribe-to-notifications' ||
    value === 'unsubscribe-from-notifications'
  ) {
    return value;
  }
  throw new BluetoothValidationError(
    'The Chromium characteristic event has an invalid operation type.',
    {
      context: {
        reason: 'invalid-characteristic-operation-type',
        receivedType: typeof value === 'string' ? value : typeof value,
      },
    },
  );
}

function requireCharacteristicWriteType(
  value: unknown,
): CharacteristicWriteType {
  switch (value) {
    case 'write-default-deprecated':
      return 'default-deprecated';
    case 'write-with-response':
      return 'with-response';
    case 'write-without-response':
      return 'without-response';
    default:
      throw new BluetoothValidationError(
        'The Chromium characteristic write event has an invalid write type.',
        {
          context: {
            reason: 'invalid-characteristic-write-type',
            receivedWriteType: typeof value === 'string' ? value : typeof value,
          },
        },
      );
  }
}

function decodeCharacteristicWriteData(value: unknown): Uint8Array {
  try {
    return bytes.base64(value as string);
  } catch (cause) {
    throw new BluetoothValidationError(
      'The Chromium characteristic write event has invalid Base64 data.',
      {
        cause,
        context: {
          reason: 'invalid-characteristic-write-data',
          receivedDataType: typeof value,
        },
      },
    );
  }
}

function prepareCharacteristicResponse(
  response: CharacteristicOperationResponse,
): Readonly<{ code: number; data?: string }> {
  if (response.result === 'error') {
    return Object.freeze({
      code: attErrorCode(requireAttErrorName(response.error)),
    });
  }
  if (response.type !== 'read') {
    return Object.freeze({ code: protocolSuccessCode });
  }
  try {
    return Object.freeze({
      code: protocolSuccessCode,
      data: encodeBase64(response.data),
    });
  } catch (cause) {
    throw new BluetoothValidationError(
      'The characteristic read response has invalid byte data.',
      {
        cause,
        context: {
          reason: 'invalid-characteristic-read-data',
        },
      },
    );
  }
}

function requireAttErrorName(value: unknown): AttErrorName {
  if (
    typeof value === 'string' &&
    (attErrorNames as readonly string[]).includes(value)
  ) {
    return value as AttErrorName;
  }
  throw new BluetoothValidationError(
    'The characteristic response has an unknown ATT error name.',
    {
      context: {
        reason: 'unknown-att-error-name',
        receivedError: typeof value === 'string' ? value : typeof value,
      },
    },
  );
}

function characteristicEventRejectionReason(cause: unknown): string {
  if (cause instanceof BluetoothValidationError) {
    const reason = cause.context['reason'];
    if (typeof reason === 'string') return reason;
  }
  return 'event-processing-failed';
}
