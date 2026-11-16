import {
  BluetoothValidationError,
  centralStates,
  type CentralState,
} from '@gattlab/core';

export interface GattLabFixtureOptions {
  readonly centralState?: CentralState;
  readonly operationTimeoutMs?: number;
  readonly promptTimeoutMs?: number;
  readonly teardownTimeoutMs?: number;
  /** Maximum diagnostic timeline records retained by the backend. */
  readonly historyLimit?: number;
  /** Maximum detailed records retained independently by each public handle. */
  readonly operationHistoryLimit?: number;
  /** Select when GattLab diagnostic artifacts are attached. */
  readonly artifacts?: GattLabArtifactRetention;
  /** Select whether Bluetooth payload previews may enter device artifacts. */
  readonly payloadLogging?: GattLabPayloadLoggingOptions;
}

export type GattLabArtifactRetention = 'off' | 'retain-on-failure' | 'always';

export type GattLabPayloadLoggingOptions =
  | Readonly<{ mode: 'redacted'; maxBytes?: never }>
  | Readonly<{ mode: 'truncated'; maxBytes?: number }>;

export type NormalizedGattLabPayloadLoggingOptions =
  | Readonly<{ mode: 'redacted' }>
  | Readonly<{ mode: 'truncated'; maxBytes: number }>;

export interface NormalizedGattLabFixtureOptions {
  readonly centralState: CentralState;
  readonly operationTimeoutMs: number;
  readonly promptTimeoutMs: number;
  readonly teardownTimeoutMs: number;
  readonly historyLimit: number;
  readonly operationHistoryLimit: number;
  readonly artifacts: GattLabArtifactRetention;
  readonly payloadLogging: NormalizedGattLabPayloadLoggingOptions;
}

const optionNames = Object.freeze([
  'centralState',
  'operationTimeoutMs',
  'promptTimeoutMs',
  'teardownTimeoutMs',
  'historyLimit',
  'operationHistoryLimit',
  'artifacts',
  'payloadLogging',
] as const);

const artifactRetentions: readonly GattLabArtifactRetention[] = Object.freeze([
  'off',
  'retain-on-failure',
  'always',
]);

const maximumPayloadPreviewBytes = 4_096;

const optionNameSet = new Set<string>(optionNames);

/** Validates fixture options and returns their immutable normalized form. */
export function normalizeGattLabFixtureOptions(
  input: GattLabFixtureOptions | undefined,
): NormalizedGattLabFixtureOptions {
  if (input !== undefined && !isPlainRecord(input)) {
    throw new BluetoothValidationError(
      'GattLab fixture options must be a plain object when provided.',
      {
        context: {
          expected: 'plain-object-or-undefined',
          received: describeValue(input),
        },
      },
    );
  }

  const options = input ?? {};
  for (const key of Object.keys(options)) {
    if (!optionNameSet.has(key)) {
      throw new BluetoothValidationError(
        `Unknown GattLab fixture option ${JSON.stringify(key)}.`,
        {
          context: {
            option: key,
            expected: optionNames,
            received: 'unknown-option',
          },
        },
      );
    }
  }

  const centralState = options.centralState ?? 'powered-on';
  if (!centralStates.includes(centralState)) {
    throw invalidOption(
      'centralState',
      'one-of-absent-powered-off-powered-on',
      centralState,
    );
  }

  const artifacts = options.artifacts ?? 'retain-on-failure';
  if (!artifactRetentions.includes(artifacts)) {
    throw invalidOption(
      'artifacts',
      'one-of-off-retain-on-failure-always',
      artifacts,
    );
  }

  return Object.freeze({
    centralState,
    operationTimeoutMs: positiveSafeInteger(
      options.operationTimeoutMs ?? 5_000,
      'operationTimeoutMs',
    ),
    promptTimeoutMs: positiveSafeInteger(
      options.promptTimeoutMs ?? 5_000,
      'promptTimeoutMs',
    ),
    teardownTimeoutMs: positiveSafeInteger(
      options.teardownTimeoutMs ?? 5_000,
      'teardownTimeoutMs',
    ),
    historyLimit: positiveSafeInteger(
      options.historyLimit ?? 1_000,
      'historyLimit',
    ),
    operationHistoryLimit: positiveSafeInteger(
      options.operationHistoryLimit ?? 1_000,
      'operationHistoryLimit',
    ),
    artifacts,
    payloadLogging: normalizePayloadLogging(options.payloadLogging),
  });
}

function normalizePayloadLogging(
  input: GattLabPayloadLoggingOptions | undefined,
): NormalizedGattLabPayloadLoggingOptions {
  if (input === undefined) return Object.freeze({ mode: 'redacted' });
  if (!isPlainPayloadLoggingRecord(input)) {
    throw invalidOption('payloadLogging', 'plain-object', input);
  }
  const record = input as Readonly<Record<string, unknown>>;
  for (const key of Object.keys(record)) {
    if (key !== 'mode' && key !== 'maxBytes') {
      throw invalidOption(
        'payloadLogging',
        'object-with-mode-and-optional-maxBytes',
        input,
      );
    }
  }
  const mode = record['mode'];
  const maxBytes = record['maxBytes'];
  if (mode === 'redacted') {
    if ('maxBytes' in record && maxBytes !== undefined) {
      throw invalidOption(
        'payloadLogging.maxBytes',
        'absent-when-mode-is-redacted',
        maxBytes,
      );
    }
    return Object.freeze({ mode: 'redacted' });
  }
  if (mode === 'truncated') {
    return Object.freeze({
      mode: 'truncated',
      maxBytes: payloadPreviewBytes(maxBytes ?? 64),
    });
  }
  throw invalidOption('payloadLogging.mode', 'one-of-redacted-truncated', mode);
}

function payloadPreviewBytes(value: unknown): number {
  const normalized = positiveSafeInteger(value, 'payloadLogging.maxBytes');
  if (normalized <= maximumPayloadPreviewBytes) return normalized;
  throw invalidOption(
    'payloadLogging.maxBytes',
    `positive-safe-integer-at-most-${String(maximumPayloadPreviewBytes)}`,
    value,
  );
}

function positiveSafeInteger(value: unknown, option: string): number {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) {
    return value;
  }
  throw invalidOption(option, 'positive-safe-integer', value);
}

function invalidOption(
  option: string,
  expected: string,
  received: unknown,
): BluetoothValidationError {
  return new BluetoothValidationError(
    `GattLab fixture option ${option} must be a ${expected}.`,
    {
      context: {
        option,
        expected,
        received: describeValue(received),
      },
    },
  );
}

function isPlainRecord(value: unknown): value is GattLabFixtureOptions {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isPlainPayloadLoggingRecord(
  value: unknown,
): value is Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function describeValue(value: unknown): string {
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return 'number:NaN';
    if (!Number.isFinite(value)) {
      return value > 0 ? 'number:Infinity' : 'number:-Infinity';
    }
    return `number:${String(value)}`;
  }
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}
