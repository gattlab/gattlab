declare const bluetoothUuidBrand: unique symbol;
declare const bluetoothAddressBrand: unique symbol;

const bluetoothBaseUuidSuffix = '-0000-1000-8000-00805f9b34fb';
const canonicalUuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const bluetoothAddressPattern = /^[0-9a-f]{2}(?::[0-9a-f]{2}){5}$/iu;
const base64Alphabet =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const canonicalBase64Pattern =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

/** A lowercase canonical 128-bit Bluetooth UUID. */
export type BluetoothUuid = string & {
  readonly [bluetoothUuidBrand]: 'BluetoothUuid';
};

/** An uppercase canonical six-octet Bluetooth device address. */
export type BluetoothAddress = string & {
  readonly [bluetoothAddressBrand]: 'BluetoothAddress';
};

/** Byte inputs accepted by the core byte factory. */
export type ByteSource = Uint8Array | readonly number[];

/**
 * Normalize a 16-bit, 32-bit, or canonical 128-bit hexadecimal Bluetooth UUID.
 * Short forms are expanded with the Bluetooth Base UUID defined by Bluetooth
 * Core Specification v6.3, Vol 3, Part B, Section 2.5.1.
 *
 * @throws {TypeError} When the value is not one of the supported UUID forms.
 * @see https://www.bluetooth.com/specifications/specs/core-specification-6-3/
 */
export function normalizeBluetoothUuid(value: string): BluetoothUuid {
  if (typeof value !== 'string') {
    throw new TypeError('Bluetooth UUID must be a string.');
  }

  if (/^[0-9a-f]{4}$/iu.test(value)) {
    return `0000${value.toLowerCase()}${bluetoothBaseUuidSuffix}` as BluetoothUuid;
  }

  if (/^[0-9a-f]{8}$/iu.test(value)) {
    return `${value.toLowerCase()}${bluetoothBaseUuidSuffix}` as BluetoothUuid;
  }

  if (canonicalUuidPattern.test(value)) {
    return value.toLowerCase() as BluetoothUuid;
  }

  throw new TypeError(
    'Bluetooth UUID must be a 16-bit, 32-bit, or canonical 128-bit hexadecimal value.',
  );
}

/**
 * Normalize a canonical six-octet Bluetooth device address to uppercase.
 *
 * @throws {TypeError} When the address is not six colon-separated octets.
 */
export function normalizeBluetoothAddress(value: string): BluetoothAddress {
  if (typeof value !== 'string') {
    throw new TypeError('Bluetooth address must be a string.');
  }

  if (!bluetoothAddressPattern.test(value)) {
    throw new TypeError(
      'Bluetooth address must contain six colon-separated hexadecimal octets.',
    );
  }

  return value.toUpperCase() as BluetoothAddress;
}

function assertByte(value: unknown, index: number): asserts value is number {
  if (typeof value !== 'number') {
    throw new TypeError(`Byte at index ${String(index)} must be a number.`);
  }

  if (!Number.isInteger(value) || value < 0 || value > 0xff) {
    throw new RangeError(
      `Byte at index ${String(index)} must be an integer from 0 to 255.`,
    );
  }
}

function copyBytes(source: ByteSource): Uint8Array {
  if (source instanceof Uint8Array) {
    return new Uint8Array(source);
  }

  if (!Array.isArray(source)) {
    throw new TypeError(
      'Byte source must be a Uint8Array or readonly number array.',
    );
  }

  const result = new Uint8Array(source.length);
  for (let index = 0; index < source.length; index += 1) {
    const value: unknown = source[index];
    assertByte(value, index);
    result[index] = value;
  }
  return result;
}

function bytesFromHex(value: string): Uint8Array {
  if (typeof value !== 'string') {
    throw new TypeError('Hex byte input must be a string.');
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) return new Uint8Array();

  const octetGroups = trimmed.split(/\s+/u);
  if (
    octetGroups.some(
      (group) => group.length % 2 !== 0 || !/^[0-9a-f]+$/iu.test(group),
    )
  ) {
    throw new TypeError(
      'Hex byte input must contain complete hexadecimal octets separated only by whitespace.',
    );
  }

  const compact = octetGroups.join('');
  const result = new Uint8Array(compact.length / 2);
  for (let index = 0; index < result.length; index += 1) {
    result[index] = Number.parseInt(
      compact.slice(index * 2, index * 2 + 2),
      16,
    );
  }
  return result;
}

function base64Value(character: string): number {
  return base64Alphabet.indexOf(character);
}

function bytesFromBase64(value: string): Uint8Array {
  if (typeof value !== 'string') {
    throw new TypeError('Base64 byte input must be a string.');
  }

  if (value.length % 4 !== 0 || !canonicalBase64Pattern.test(value)) {
    throw new TypeError(
      'Base64 byte input must use canonical RFC 4648 encoding.',
    );
  }

  if (value.length === 0) {
    return new Uint8Array();
  }

  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  const finalOffset = value.length - 4;
  const thirdFinalValue = base64Value(value[finalOffset + 2] ?? 'A');
  const secondFinalValue = base64Value(value[finalOffset + 1] ?? 'A');
  if (
    (padding === 2 && (secondFinalValue & 0x0f) !== 0) ||
    (padding === 1 && (thirdFinalValue & 0x03) !== 0)
  ) {
    throw new TypeError('Base64 byte input contains non-zero padding bits.');
  }

  const result = new Uint8Array((value.length / 4) * 3 - padding);
  let outputIndex = 0;
  for (let offset = 0; offset < value.length; offset += 4) {
    const first = base64Value(value[offset] ?? '');
    const second = base64Value(value[offset + 1] ?? '');
    const thirdCharacter = value[offset + 2] ?? '=';
    const fourthCharacter = value[offset + 3] ?? '=';
    const third = thirdCharacter === '=' ? 0 : base64Value(thirdCharacter);
    const fourth = fourthCharacter === '=' ? 0 : base64Value(fourthCharacter);
    const block = (first << 18) | (second << 12) | (third << 6) | fourth;

    if (outputIndex < result.length) result[outputIndex++] = block >>> 16;
    if (outputIndex < result.length) result[outputIndex++] = block >>> 8;
    if (outputIndex < result.length) result[outputIndex++] = block;
  }
  return result;
}

function pushUtf8CodePoint(output: number[], codePoint: number): void {
  if (codePoint <= 0x7f) {
    output.push(codePoint);
  } else if (codePoint <= 0x7ff) {
    output.push(0xc0 | (codePoint >>> 6), 0x80 | (codePoint & 0x3f));
  } else if (codePoint <= 0xffff) {
    output.push(
      0xe0 | (codePoint >>> 12),
      0x80 | ((codePoint >>> 6) & 0x3f),
      0x80 | (codePoint & 0x3f),
    );
  } else {
    output.push(
      0xf0 | (codePoint >>> 18),
      0x80 | ((codePoint >>> 12) & 0x3f),
      0x80 | ((codePoint >>> 6) & 0x3f),
      0x80 | (codePoint & 0x3f),
    );
  }
}

function bytesFromText(value: string): Uint8Array {
  if (typeof value !== 'string') {
    throw new TypeError('Text byte input must be a string.');
  }

  const output: number[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const lowSurrogate = value.charCodeAt(index + 1);
      if (!(lowSurrogate >= 0xdc00 && lowSurrogate <= 0xdfff)) {
        throw new TypeError(
          'Text byte input contains an unpaired UTF-16 surrogate.',
        );
      }
      const codePoint =
        0x10000 + ((codeUnit - 0xd800) << 10) + (lowSurrogate - 0xdc00);
      pushUtf8CodePoint(output, codePoint);
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new TypeError(
        'Text byte input contains an unpaired UTF-16 surrogate.',
      );
    } else {
      pushUtf8CodePoint(output, codeUnit);
    }
  }
  return new Uint8Array(output);
}

function bytesFromUint16le(value: number): Uint8Array {
  if (typeof value !== 'number') {
    throw new TypeError('uint16le input must be a number.');
  }

  if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
    throw new RangeError('uint16le input must be an integer from 0 to 65535.');
  }

  return new Uint8Array([value & 0xff, value >>> 8]);
}

/** Callable byte factory with strict hexadecimal, Base64, text, and uint16le helpers. */
export interface BytesFactory {
  /** Copy byte input; invalid types throw TypeError, invalid octets RangeError. */
  (source: ByteSource): Uint8Array;
  /** Decode complete hexadecimal octets, optionally separated by whitespace; malformed input throws TypeError. */
  hex(value: string): Uint8Array;
  /** Decode canonical RFC 4648 Base64, including strict padding bits; malformed input throws TypeError. */
  base64(value: string): Uint8Array;
  /** Encode UTF-8; invalid input or an unpaired UTF-16 surrogate throws TypeError. */
  text(value: string): Uint8Array;
  /** Encode an integer from 0 to 65535 as two little-endian bytes; invalid type/range throws TypeError/RangeError. */
  uint16le(value: number): Uint8Array;
}

/** Construct fresh byte arrays without relying on Node or browser globals. */
export const bytes: BytesFactory = Object.assign(copyBytes, {
  hex: bytesFromHex,
  base64: bytesFromBase64,
  text: bytesFromText,
  uint16le: bytesFromUint16le,
});
