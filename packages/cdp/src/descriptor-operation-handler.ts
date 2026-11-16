import {
  attErrorNames,
  BluetoothValidationError,
  bytes,
  type AttErrorName,
  type BluetoothTimeline,
  type DescriptorOperationEvent,
  type DescriptorOperationResponse,
  type DescriptorOperationType,
} from '@gattlab/core';

import { encodeBase64 } from './base64.js';
import type {
  CdpEntityRegistry,
  RegisteredCdpDescriptor,
} from './entity-registry.js';
import { attErrorCode, protocolSuccessCode } from './error-codes.js';
import type { PendingOperationRegistry } from './pending-operation-registry.js';
import type { CdpEventPayload, CdpTransport } from './transport.js';

type DescriptorOperationPayload =
  CdpEventPayload<'BluetoothEmulation.descriptorOperationReceived'>;

export interface CdpDescriptorOperationHandlerOptions {
  readonly transport: CdpTransport<'browser'>;
  readonly entities: CdpEntityRegistry;
  readonly pendingOperations: PendingOperationRegistry;
  readonly timeline: BluetoothTimeline;
}

export type DescriptorOperationListener = (
  event: DescriptorOperationEvent,
) => void;
export type DescriptorOperationErrorListener = (cause: unknown) => void;

/** Internal CDP mapping for descriptor operations. */
export class CdpDescriptorOperationHandler {
  readonly #transport: CdpTransport<'browser'>;
  readonly #entities: CdpEntityRegistry;
  readonly #pendingOperations: PendingOperationRegistry;
  readonly #timeline: BluetoothTimeline;
  #unsubscribe: (() => void) | undefined;

  constructor(options: CdpDescriptorOperationHandlerOptions) {
    this.#transport = options.transport;
    this.#entities = options.entities;
    this.#pendingOperations = options.pendingOperations;
    this.#timeline = options.timeline;
  }

  subscribe(
    listener: DescriptorOperationListener,
    onError: DescriptorOperationErrorListener,
  ): () => void {
    if (typeof listener !== 'function') {
      throw new TypeError('Descriptor operation listener must be a function.');
    }
    if (typeof onError !== 'function') {
      throw new TypeError(
        'Descriptor operation error listener must be a function.',
      );
    }
    if (this.#unsubscribe !== undefined) {
      throw new TypeError(
        'A descriptor operation listener is already subscribed.',
      );
    }

    const unsubscribeTransport = this.#transport.on(
      'BluetoothEmulation.descriptorOperationReceived',
      (payload) => {
        let registrationStarted = false;
        let registeredOperationId: string | undefined;
        let deliveryStarted = false;
        try {
          const descriptor = this.#requireDescriptor(payload.descriptorId);
          const type = requireDescriptorOperationType(payload.type);
          const input = descriptorOperationInput(descriptor, type, payload);
          registrationStarted = true;
          const event = this.#pendingOperations.register(input);
          registeredOperationId = event.operationId;
          if (event.kind !== 'descriptor-operation') {
            throw new TypeError(
              'Pending operation registry returned a non-descriptor event.',
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
              category: 'descriptor',
              type: 'descriptor-event-rejected',
              status: 'failed',
              data: {
                reason: descriptorEventRejectionReason(cause),
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
    response: DescriptorOperationResponse,
    transport: Pick<CdpTransport<'browser'>, 'send'> = this.#transport,
  ): Promise<void> {
    const protocolResponse = prepareDescriptorResponse(response);
    await this.#pendingOperations.respondToDescriptorOperation(
      response,
      async (event) => {
        const descriptor = this.#entities.getDescriptorByReference(
          event.descriptor,
        );
        if (descriptor === undefined) {
          throw new BluetoothValidationError(
            'The pending descriptor is no longer registered.',
            {
              context: {
                reason: 'stale-descriptor-reference',
              },
            },
          );
        }
        await transport.send(
          'BluetoothEmulation.simulateDescriptorOperationResponse',
          {
            descriptorId: descriptor.id,
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

  #requireDescriptor(value: unknown): RegisteredCdpDescriptor {
    if (typeof value === 'string') {
      const descriptor = this.#entities.getDescriptor(value);
      if (descriptor !== undefined) return descriptor;
    }
    throw new BluetoothValidationError(
      'The Chromium descriptor event references an unregistered descriptor.',
      {
        context: {
          reason: 'unknown-descriptor-id',
          receivedIdType: typeof value,
          source: 'event',
        },
      },
    );
  }
}

function descriptorOperationInput(
  descriptor: RegisteredCdpDescriptor,
  type: DescriptorOperationType,
  payload: DescriptorOperationPayload,
) {
  if (type === 'write') {
    return {
      kind: 'descriptor-operation' as const,
      descriptor: descriptor.reference,
      type,
      data: decodeDescriptorWriteData(payload.data),
    };
  }
  if (payload.data !== undefined) {
    throw new BluetoothValidationError(
      'The Chromium descriptor event has unexpected write data.',
      {
        context: {
          reason: 'unexpected-descriptor-write-data',
          operationType: type,
          hasData: true,
        },
      },
    );
  }
  return {
    kind: 'descriptor-operation' as const,
    descriptor: descriptor.reference,
    type,
  };
}

function requireDescriptorOperationType(
  value: unknown,
): DescriptorOperationType {
  if (value === 'read' || value === 'write') return value;
  throw new BluetoothValidationError(
    'The Chromium descriptor event has an invalid operation type.',
    {
      context: {
        reason: 'invalid-descriptor-operation-type',
        receivedType: typeof value === 'string' ? value : typeof value,
      },
    },
  );
}

function decodeDescriptorWriteData(value: unknown): Uint8Array {
  try {
    return bytes.base64(value as string);
  } catch (cause) {
    throw new BluetoothValidationError(
      'The Chromium descriptor write event has invalid Base64 data.',
      {
        cause,
        context: {
          reason: 'invalid-descriptor-write-data',
          receivedDataType: typeof value,
        },
      },
    );
  }
}

function prepareDescriptorResponse(
  response: DescriptorOperationResponse,
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
      'The descriptor read response has invalid byte data.',
      {
        cause,
        context: {
          reason: 'invalid-descriptor-read-data',
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
    'The descriptor response has an unknown ATT error name.',
    {
      context: {
        reason: 'unknown-att-error-name',
        receivedError: typeof value === 'string' ? value : typeof value,
      },
    },
  );
}

function descriptorEventRejectionReason(cause: unknown): string {
  if (cause instanceof BluetoothValidationError) {
    const reason = cause.context['reason'];
    if (typeof reason === 'string') return reason;
  }
  return 'event-processing-failed';
}
