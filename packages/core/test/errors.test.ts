import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  attErrorNames,
  BluetoothBackendStoppedError,
  BluetoothCancelledError,
  BluetoothCapabilityUnsupportedError,
  BluetoothConcurrentOperationError,
  BluetoothLabAlreadyActiveError,
  BluetoothPeripheralAlreadyRegisteredError,
  BluetoothTimeoutError,
  BluetoothValidationError,
  GattLabError,
  gattLabErrorCodes,
  hciErrorNames,
  PromptDeviceNotFoundError,
  type AttErrorName,
  type DiagnosticValue,
  type GattLabErrorCode,
  type HciErrorName,
  type InjectedProtocolError,
} from '../src/index.js';

describe('GattLabError', () => {
  it('preserves cause and recursively copies and freezes diagnostics', () => {
    const cause = new Error('root cause');
    const nested = { attempts: [1, { state: 'starting' }] };
    const error = new BluetoothTimeoutError('failed', {
      cause,
      context: nested,
    });

    nested.attempts[0] = 9;
    (nested.attempts[1] as { state: string }).state = 'mutated';
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('BluetoothTimeoutError');
    expect(error.cause).toBe(cause);
    expect(error.code).toBe('BLUETOOTH_TIMEOUT');
    expect(error.context).toEqual({
      attempts: [1, { state: 'starting' }],
    });
    expect(Object.isFrozen(error.context)).toBe(true);
    expect(Object.isFrozen(error.context['attempts'])).toBe(true);
    const attempts = error.context['attempts'];
    if (!Array.isArray(attempts)) throw new Error('Expected attempts array.');
    expect(Object.isFrozen(attempts[1])).toBe(true);
  });

  it('rejects unsupported, cyclic, and non-record diagnostic values', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;

    expect(
      () =>
        new BluetoothTimeoutError('failed', {
          context: { value: undefined } as never,
        }),
    ).toThrow(TypeError);
    expect(
      () =>
        new BluetoothTimeoutError('failed', {
          context: cyclic as never,
        }),
    ).toThrow(/cycles/u);
    expect(
      () =>
        new BluetoothTimeoutError('failed', {
          context: new Date() as never,
        }),
    ).toThrow(/plain record/u);
  });

  it('rejects invalid runtime message inputs through concrete errors', () => {
    expect(() => new BluetoothTimeoutError(1 as never)).toThrow(TypeError);
  });
});

describe('concrete GattLab errors', () => {
  it.each([
    [BluetoothBackendStoppedError, 'BLUETOOTH_BACKEND_STOPPED'],
    [BluetoothCancelledError, 'BLUETOOTH_CANCELLED'],
    [BluetoothCapabilityUnsupportedError, 'BLUETOOTH_CAPABILITY_UNSUPPORTED'],
    [BluetoothConcurrentOperationError, 'BLUETOOTH_CONCURRENT_OPERATION'],
    [BluetoothLabAlreadyActiveError, 'BLUETOOTH_LAB_ALREADY_ACTIVE'],
    [
      BluetoothPeripheralAlreadyRegisteredError,
      'BLUETOOTH_PERIPHERAL_ALREADY_REGISTERED',
    ],
    [PromptDeviceNotFoundError, 'BLUETOOTH_PROMPT_DEVICE_NOT_FOUND'],
    [BluetoothTimeoutError, 'BLUETOOTH_TIMEOUT'],
    [BluetoothValidationError, 'BLUETOOTH_VALIDATION_FAILED'],
  ] as const)('fixes %s to %s', (ErrorConstructor, code) => {
    const error = new ErrorConstructor('failed');

    expect(error).toBeInstanceOf(GattLabError);
    expect(error.name).toBe(ErrorConstructor.name);
    expect(error.code).toBe(code);
  });

  it('retains literal codes on subclass instances', () => {
    const error = new BluetoothTimeoutError('timed out');
    expectTypeOf(error.code).toEqualTypeOf<'BLUETOOTH_TIMEOUT'>();
  });
});

describe('protocol error names', () => {
  it('exports the complete stable ATT and HCI name sets', () => {
    expect(attErrorNames).toHaveLength(19);
    expect(hciErrorNames).toHaveLength(5);
    expect(new Set(attErrorNames).size).toBe(attErrorNames.length);
    expect(new Set(hciErrorNames).size).toBe(hciErrorNames.length);
    expect(gattLabErrorCodes).toHaveLength(9);
  });

  it('provides narrowed scripting-side protocol unions', () => {
    expectTypeOf<
      (typeof attErrorNames)[number]
    >().toEqualTypeOf<AttErrorName>();
    expectTypeOf<
      (typeof hciErrorNames)[number]
    >().toEqualTypeOf<HciErrorName>();
    expectTypeOf<
      (typeof gattLabErrorCodes)[number]
    >().toEqualTypeOf<GattLabErrorCode>();
    expectTypeOf<InjectedProtocolError>().toMatchTypeOf<
      | Readonly<{ kind: 'att'; name: AttErrorName }>
      | Readonly<{ kind: 'hci'; name: HciErrorName }>
    >();
    expectTypeOf<DiagnosticValue>().toMatchTypeOf<unknown>();
  });
});
