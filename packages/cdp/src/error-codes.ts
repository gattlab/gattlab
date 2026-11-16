import { type AttErrorName, type HciErrorName } from '@gattlab/core';

export const protocolSuccessCode = 0x00;

export type AttErrorCode =
  | 0x01
  | 0x02
  | 0x03
  | 0x04
  | 0x05
  | 0x06
  | 0x07
  | 0x08
  | 0x09
  | 0x0a
  | 0x0b
  | 0x0c
  | 0x0d
  | 0x0e
  | 0x0f
  | 0x10
  | 0x11
  | 0x12
  | 0x13;

export type HciErrorCode = 0x05 | 0x08 | 0x13 | 0x16 | 0x3e;

/**
 * ATT error codes from Bluetooth Core Specification v6.3, Vol 3, Part F,
 * Section 3.4.1.1. Keys are stable GattLab scripting names.
 *
 * @see https://www.bluetooth.com/specifications/specs/core-specification-6-3/
 */
export const attErrorCodes: Readonly<Record<AttErrorName, AttErrorCode>> =
  Object.freeze({
    'invalid-handle': 0x01,
    'read-not-permitted': 0x02,
    'write-not-permitted': 0x03,
    'invalid-pdu': 0x04,
    'insufficient-authentication': 0x05,
    'request-not-supported': 0x06,
    'invalid-offset': 0x07,
    'insufficient-authorization': 0x08,
    'prepare-queue-full': 0x09,
    'attribute-not-found': 0x0a,
    'attribute-not-long': 0x0b,
    'insufficient-encryption-key-size': 0x0c,
    'invalid-attribute-value-length': 0x0d,
    'unlikely-error': 0x0e,
    'insufficient-encryption': 0x0f,
    'unsupported-group-type': 0x10,
    'insufficient-resources': 0x11,
    'database-out-of-sync': 0x12,
    'value-not-allowed': 0x13,
  });

/**
 * Supported HCI error codes from Bluetooth Core Specification v6.3, Vol 1,
 * Part F, Sections 1.3 and 2. Keys are stable GattLab scripting names.
 *
 * @see https://www.bluetooth.com/specifications/specs/core-specification-6-3/
 */
export const hciErrorCodes: Readonly<Record<HciErrorName, HciErrorCode>> =
  Object.freeze({
    'authentication-failure': 0x05,
    'connection-timeout': 0x08,
    'remote-user-terminated-connection': 0x13,
    'connection-terminated-by-local-host': 0x16,
    'connection-failed-to-be-established': 0x3e,
  });

/** Returns the CDP numeric response code for a stable ATT error name. */
export function attErrorCode(name: AttErrorName): AttErrorCode {
  return attErrorCodes[name];
}

/** Returns the CDP numeric response code for a stable HCI error name. */
export function hciErrorCode(name: HciErrorName): HciErrorCode {
  return hciErrorCodes[name];
}
