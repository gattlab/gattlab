import { describe, expect, expectTypeOf, it } from 'vitest';

import { attErrorNames, hciErrorNames } from '@gattlab/core';

import {
  attErrorCode,
  attErrorCodes,
  hciErrorCode,
  hciErrorCodes,
  protocolSuccessCode,
  type AttErrorCode,
  type HciErrorCode,
} from '../src/index.js';

describe('Bluetooth protocol error mappings', () => {
  it('maps every ATT scripting name to the Core v6.3 numeric value', () => {
    expect(attErrorCodes).toEqual({
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
    expect(Object.keys(attErrorCodes)).toEqual([...attErrorNames]);
    expect(Object.isFrozen(attErrorCodes)).toBe(true);
    expect(attErrorCode('value-not-allowed')).toBe(0x13);
    expectTypeOf(attErrorCode('invalid-handle')).toEqualTypeOf<AttErrorCode>();
  });

  it('maps every supported HCI scripting name to the Core v6.3 value', () => {
    expect(hciErrorCodes).toEqual({
      'authentication-failure': 0x05,
      'connection-timeout': 0x08,
      'remote-user-terminated-connection': 0x13,
      'connection-terminated-by-local-host': 0x16,
      'connection-failed-to-be-established': 0x3e,
    });
    expect(new Set(Object.keys(hciErrorCodes))).toEqual(new Set(hciErrorNames));
    expect(Object.isFrozen(hciErrorCodes)).toBe(true);
    expect(hciErrorCode('connection-failed-to-be-established')).toBe(0x3e);
    expectTypeOf(
      hciErrorCode('connection-timeout'),
    ).toEqualTypeOf<HciErrorCode>();
  });

  it('keeps protocol success separate from named failure inputs', () => {
    expect(protocolSuccessCode).toBe(0x00);
    expect(attErrorNames).not.toContain(protocolSuccessCode);
    expect(hciErrorNames).not.toContain(protocolSuccessCode);
  });
});
