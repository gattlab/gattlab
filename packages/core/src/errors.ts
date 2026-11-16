export const gattLabErrorCodes: readonly [
  'BLUETOOTH_BACKEND_STOPPED',
  'BLUETOOTH_CANCELLED',
  'BLUETOOTH_CAPABILITY_UNSUPPORTED',
  'BLUETOOTH_CONCURRENT_OPERATION',
  'BLUETOOTH_LAB_ALREADY_ACTIVE',
  'BLUETOOTH_PERIPHERAL_ALREADY_REGISTERED',
  'BLUETOOTH_PROMPT_DEVICE_NOT_FOUND',
  'BLUETOOTH_TIMEOUT',
  'BLUETOOTH_VALIDATION_FAILED',
] = Object.freeze([
  'BLUETOOTH_BACKEND_STOPPED',
  'BLUETOOTH_CANCELLED',
  'BLUETOOTH_CAPABILITY_UNSUPPORTED',
  'BLUETOOTH_CONCURRENT_OPERATION',
  'BLUETOOTH_LAB_ALREADY_ACTIVE',
  'BLUETOOTH_PERIPHERAL_ALREADY_REGISTERED',
  'BLUETOOTH_PROMPT_DEVICE_NOT_FOUND',
  'BLUETOOTH_TIMEOUT',
  'BLUETOOTH_VALIDATION_FAILED',
] as const);

export type GattLabErrorCode = (typeof gattLabErrorCodes)[number];

export type DiagnosticValue =
  | null
  | boolean
  | number
  | string
  | readonly DiagnosticValue[]
  | { readonly [key: string]: DiagnosticValue };

export interface GattLabErrorOptions {
  cause?: unknown;
  context?: Readonly<Record<string, DiagnosticValue>>;
}

function copyDiagnosticValue(
  value: unknown,
  activeObjects: WeakSet<object>,
): DiagnosticValue {
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'number' ||
    typeof value === 'string'
  ) {
    return value;
  }

  if (typeof value !== 'object') {
    throw new TypeError(
      'Diagnostic values must contain only null, booleans, numbers, strings, arrays, and records.',
    );
  }
  if (activeObjects.has(value)) {
    throw new TypeError('Diagnostic values must not contain cycles.');
  }

  activeObjects.add(value);
  try {
    if (Array.isArray(value)) {
      return Object.freeze(
        value.map((entry) => copyDiagnosticValue(entry, activeObjects)),
      );
    }

    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('Diagnostic objects must be plain records.');
    }

    const result: Record<string, DiagnosticValue> = {};
    for (const key of Object.keys(value)) {
      Object.defineProperty(result, key, {
        configurable: false,
        enumerable: true,
        writable: false,
        value: copyDiagnosticValue(
          (value as Record<string, unknown>)[key],
          activeObjects,
        ),
      });
    }
    return Object.freeze(result);
  } finally {
    activeObjects.delete(value);
  }
}

/** Copies and freezes diagnostic metadata while rejecting unsafe values. */
export function snapshotDiagnosticContext(
  context: Readonly<Record<string, DiagnosticValue>> | undefined,
): Readonly<Record<string, DiagnosticValue>> {
  if (context === undefined) return Object.freeze({});
  const copied = copyDiagnosticValue(context, new WeakSet<object>());
  if (Array.isArray(copied) || copied === null || typeof copied !== 'object') {
    throw new TypeError('Diagnostic context must be a plain record.');
  }
  return copied as Readonly<Record<string, DiagnosticValue>>;
}

/** Base class for stable, contextual errors exposed by GattLab packages. */
export abstract class GattLabError extends Error {
  abstract readonly code: GattLabErrorCode;
  readonly context: Readonly<Record<string, DiagnosticValue>>;

  protected constructor(message: string, options: GattLabErrorOptions = {}) {
    if (typeof message !== 'string') {
      throw new TypeError('GattLab error message must be a string.');
    }

    super(message, 'cause' in options ? { cause: options.cause } : undefined);
    this.name = 'GattLabError';
    this.context = snapshotDiagnosticContext(options.context);
  }
}

/** Reports use of a backend whose stop sequence has started. */
export class BluetoothBackendStoppedError extends GattLabError {
  override readonly code = 'BLUETOOTH_BACKEND_STOPPED' as const;

  /** Construct this stable-code error with copied/frozen context and preserved cause; invalid message or diagnostic metadata throws TypeError. */
  constructor(message: string, options?: GattLabErrorOptions) {
    super(message, options);
    this.name = 'BluetoothBackendStoppedError';
  }
}

/** Reports explicit cancellation of a pending Bluetooth operation. */
export class BluetoothCancelledError extends GattLabError {
  override readonly code = 'BLUETOOTH_CANCELLED' as const;

  /** Construct this stable-code error with copied/frozen context and preserved cause; invalid message or diagnostic metadata throws TypeError. */
  constructor(message: string, options?: GattLabErrorOptions) {
    super(message, options);
    this.name = 'BluetoothCancelledError';
  }
}

/** Reports a required browser or backend capability that is unavailable. */
export class BluetoothCapabilityUnsupportedError extends GattLabError {
  override readonly code = 'BLUETOOTH_CAPABILITY_UNSUPPORTED' as const;

  /** Construct this stable-code error with copied/frozen context and preserved cause; invalid message or diagnostic metadata throws TypeError. */
  constructor(message: string, options?: GattLabErrorOptions) {
    super(message, options);
    this.name = 'BluetoothCapabilityUnsupportedError';
  }
}

/** Reports an unsupported concurrent operation on the same entity. */
export class BluetoothConcurrentOperationError extends GattLabError {
  override readonly code = 'BLUETOOTH_CONCURRENT_OPERATION' as const;

  /** Construct this stable-code error with copied/frozen context and preserved cause; invalid message or diagnostic metadata throws TypeError. */
  constructor(message: string, options?: GattLabErrorOptions) {
    super(message, options);
    this.name = 'BluetoothConcurrentOperationError';
  }
}

/** Reports a second active lab in the same browser-process scope. */
export class BluetoothLabAlreadyActiveError extends GattLabError {
  override readonly code = 'BLUETOOTH_LAB_ALREADY_ACTIVE' as const;

  /** Construct this stable-code error with copied/frozen context and preserved cause; invalid message or diagnostic metadata throws TypeError. */
  constructor(message: string, options?: GattLabErrorOptions) {
    super(message, options);
    this.name = 'BluetoothLabAlreadyActiveError';
  }
}

/** Reports duplicate registration of one normalized peripheral address. */
export class BluetoothPeripheralAlreadyRegisteredError extends GattLabError {
  override readonly code = 'BLUETOOTH_PERIPHERAL_ALREADY_REGISTERED' as const;

  /** Construct this stable-code error with copied/frozen context and preserved cause; invalid message or diagnostic metadata throws TypeError. */
  constructor(message: string, options?: GattLabErrorOptions) {
    super(message, options);
    this.name = 'BluetoothPeripheralAlreadyRegisteredError';
  }
}

/** Reports chooser selection of a candidate that is no longer available. */
export class PromptDeviceNotFoundError extends GattLabError {
  override readonly code = 'BLUETOOTH_PROMPT_DEVICE_NOT_FOUND' as const;

  /** Construct this stable-code error with copied/frozen context and preserved cause; invalid message or diagnostic metadata throws TypeError. */
  constructor(message: string, options?: GattLabErrorOptions) {
    super(message, options);
    this.name = 'PromptDeviceNotFoundError';
  }
}

/** Reports expiry of a bounded GattLab operation. */
export class BluetoothTimeoutError extends GattLabError {
  override readonly code = 'BLUETOOTH_TIMEOUT' as const;

  /** Construct this stable-code error with copied/frozen context and preserved cause; invalid message or diagnostic metadata throws TypeError. */
  constructor(message: string, options?: GattLabErrorOptions) {
    super(message, options);
    this.name = 'BluetoothTimeoutError';
  }
}

/** Reports invalid user input at a public GattLab boundary. */
export class BluetoothValidationError extends GattLabError {
  override readonly code = 'BLUETOOTH_VALIDATION_FAILED' as const;

  /** Construct this stable-code error with copied/frozen context and preserved cause; invalid message or diagnostic metadata throws TypeError. */
  constructor(message: string, options?: GattLabErrorOptions) {
    super(message, options);
    this.name = 'BluetoothValidationError';
  }
}

/**
 * Stable GattLab scripting names for ATT error responses.
 *
 * Numeric mappings are backend-owned and derive from Bluetooth Core
 * Specification v6.3, Vol 3, Part F, Section 3.4.1.1. These kebab-case names
 * remain GattLab API vocabulary even when specification wording changes.
 *
 * @see https://www.bluetooth.com/specifications/specs/core-specification-6-3/
 */
export const attErrorNames: readonly [
  'invalid-handle',
  'read-not-permitted',
  'write-not-permitted',
  'invalid-pdu',
  'insufficient-authentication',
  'request-not-supported',
  'invalid-offset',
  'insufficient-authorization',
  'prepare-queue-full',
  'attribute-not-found',
  'attribute-not-long',
  'insufficient-encryption-key-size',
  'invalid-attribute-value-length',
  'unlikely-error',
  'insufficient-encryption',
  'unsupported-group-type',
  'insufficient-resources',
  'database-out-of-sync',
  'value-not-allowed',
] = Object.freeze([
  'invalid-handle',
  'read-not-permitted',
  'write-not-permitted',
  'invalid-pdu',
  'insufficient-authentication',
  'request-not-supported',
  'invalid-offset',
  'insufficient-authorization',
  'prepare-queue-full',
  'attribute-not-found',
  'attribute-not-long',
  'insufficient-encryption-key-size',
  'invalid-attribute-value-length',
  'unlikely-error',
  'insufficient-encryption',
  'unsupported-group-type',
  'insufficient-resources',
  'database-out-of-sync',
  'value-not-allowed',
] as const);

export type AttErrorName = (typeof attErrorNames)[number];

/**
 * Stable GattLab scripting names for the supported HCI error subset.
 *
 * Numeric mappings are backend-owned and derive from Bluetooth Core
 * Specification v6.3, Vol 1, Part F, Sections 1.3 and 2.
 *
 * @see https://www.bluetooth.com/specifications/specs/core-specification-6-3/
 */
export const hciErrorNames: readonly [
  'connection-timeout',
  'connection-failed-to-be-established',
  'remote-user-terminated-connection',
  'connection-terminated-by-local-host',
  'authentication-failure',
] = Object.freeze([
  'connection-timeout',
  'connection-failed-to-be-established',
  'remote-user-terminated-connection',
  'connection-terminated-by-local-host',
  'authentication-failure',
] as const);

export type HciErrorName = (typeof hciErrorNames)[number];

export type InjectedProtocolError =
  | Readonly<{ kind: 'att'; name: AttErrorName }>
  | Readonly<{ kind: 'hci'; name: HciErrorName }>;
