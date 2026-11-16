import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  bytes,
  normalizeBluetoothAddress,
  normalizeBluetoothUuid,
  type BluetoothAddress,
  type BluetoothUuid,
  type ByteSource,
} from '../src/index.js';

describe('normalizeBluetoothUuid', () => {
  it.each([
    ['180f', '0000180f-0000-1000-8000-00805f9b34fb'],
    ['ABCDEF01', 'abcdef01-0000-1000-8000-00805f9b34fb'],
    [
      '12345678-1234-ABCD-9876-1234567890AB',
      '12345678-1234-abcd-9876-1234567890ab',
    ],
  ])('normalizes %s', (input, expected) => {
    expect(normalizeBluetoothUuid(input)).toBe(expected);
  });

  it.each([
    '',
    '180',
    '0x180f',
    'battery_service',
    '12345678-1234-1234-1234-1234567890',
    '123456781234123412341234567890ab',
  ])('rejects malformed value %j', (input) => {
    expect(() => normalizeBluetoothUuid(input)).toThrow(TypeError);
  });

  it('rejects runtime non-string input', () => {
    expect(() => normalizeBluetoothUuid(undefined as never)).toThrow(TypeError);
  });
});

describe('normalizeBluetoothAddress', () => {
  it('normalizes hexadecimal letters to uppercase', () => {
    expect(normalizeBluetoothAddress('aa:0b:CC:dd:0e:Ff')).toBe(
      'AA:0B:CC:DD:0E:FF',
    );
  });

  it.each([
    '',
    'AA:BB:CC:DD:EE',
    'AA-BB-CC-DD-EE-FF',
    'A:BB:CC:DD:EE:FF',
    'GG:BB:CC:DD:EE:FF',
    ' AA:BB:CC:DD:EE:FF',
  ])('rejects malformed value %j', (input) => {
    expect(() => normalizeBluetoothAddress(input)).toThrow(TypeError);
  });

  it('rejects runtime non-string input', () => {
    expect(() => normalizeBluetoothAddress(null as never)).toThrow(TypeError);
  });
});

describe('bytes', () => {
  it('copies arrays and Uint8Arrays', () => {
    const array = [0, 127, 255];
    const typed = new Uint8Array([1, 2, 3]);
    const fromArray = bytes(array);
    const fromTyped = bytes(typed);

    array[0] = 9;
    typed[0] = 9;
    fromArray[1] = 9;

    expect([...fromArray]).toEqual([0, 9, 255]);
    expect([...fromTyped]).toEqual([1, 2, 3]);
    expect(fromTyped).not.toBe(typed);
  });

  it.each([
    [[-1], RangeError],
    [[256], RangeError],
    [[1.5], RangeError],
    [[Number.NaN], RangeError],
    [['1'] as never, TypeError],
    [new Uint16Array([1]) as never, TypeError],
  ])('rejects invalid source %#', (source, errorType) => {
    expect(() => bytes(source as ByteSource)).toThrow(errorType);
  });

  it('decodes hexadecimal octets with whitespace', () => {
    expect([...bytes.hex('01 02\nff\tA0')]).toEqual([1, 2, 255, 160]);
    expect([...bytes.hex('')]).toEqual([]);
  });

  it.each(['0', '0 1', '0xz1', '01-02', 'zz'])(
    'rejects malformed hex %j',
    (input) => {
      expect(() => bytes.hex(input)).toThrow(TypeError);
    },
  );

  it.each([
    ['', []],
    ['AA==', [0]],
    ['AQI=', [1, 2]],
    ['AQL/', [1, 2, 255]],
    ['aGVsbG8=', [104, 101, 108, 108, 111]],
  ] as const)('decodes canonical Base64 %j', (input, expected) => {
    expect([...bytes.base64(input)]).toEqual(expected);
  });

  it.each(['A', 'AAA', 'A===', 'A A=', 'AQL_', '=AAA', 'AB==', 'AAF='])(
    'rejects malformed or non-canonical Base64 %j',
    (input) => {
      expect(() => bytes.base64(input)).toThrow(TypeError);
    },
  );

  it('encodes Unicode text as strict UTF-8', () => {
    expect([...bytes.text('$¢€𐍈')]).toEqual([
      0x24, 0xc2, 0xa2, 0xe2, 0x82, 0xac, 0xf0, 0x90, 0x8d, 0x88,
    ]);
  });

  it.each(['\ud800', '\ud800x', '\udc00'])(
    'rejects unpaired surrogate %j',
    (input) => {
      expect(() => bytes.text(input)).toThrow(TypeError);
    },
  );

  it.each([
    [0, [0, 0]],
    [0x1234, [0x34, 0x12]],
    [0xffff, [0xff, 0xff]],
  ] as const)('encodes uint16le %d', (input, expected) => {
    expect([...bytes.uint16le(input)]).toEqual(expected);
  });

  it.each([-1, 0x10000, 1.5, Number.NaN])(
    'rejects uint16le range %j',
    (input) => {
      expect(() => bytes.uint16le(input)).toThrow(RangeError);
    },
  );

  it('rejects runtime type mismatches for byte helpers', () => {
    expect(() => bytes.hex(null as never)).toThrow(TypeError);
    expect(() => bytes.base64(undefined as never)).toThrow(TypeError);
    expect(() => bytes.text(1 as never)).toThrow(TypeError);
    expect(() => bytes.uint16le('1' as never)).toThrow(TypeError);
  });
});

describe('public primitive types', () => {
  it('returns branded normalized identities and fresh byte arrays', () => {
    expectTypeOf(normalizeBluetoothUuid('180f')).toEqualTypeOf<BluetoothUuid>();
    expectTypeOf(
      normalizeBluetoothAddress('AA:BB:CC:DD:EE:FF'),
    ).toEqualTypeOf<BluetoothAddress>();
    expectTypeOf(bytes([1, 2])).toEqualTypeOf<Uint8Array>();
  });
});
