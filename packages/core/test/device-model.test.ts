import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  validatePeripheralDefinition,
  type NormalizedPeripheral,
  type ValidationIssue,
} from '../src/device-model.js';

function expectFailure(input: unknown): readonly ValidationIssue[] {
  const result = validatePeripheralDefinition(input);
  expect(result.success).toBe(false);
  if (result.success) throw new Error('Expected validation to fail.');
  return result.issues;
}

describe('validatePeripheralDefinition hierarchy slice', () => {
  it('normalizes a hierarchy and derives known service UUIDs', () => {
    const initialValue = new Uint8Array([1, 2]);
    const properties = ['read', 'notify'];
    const definition = {
      address: 'aa:bb:cc:dd:ee:ff',
      name: 'Sensor',
      services: [
        {
          uuid: '180f',
          characteristics: [
            {
              uuid: '2A19',
              properties,
              initialValue,
              descriptors: [
                { uuid: '2901', initialValue: [65] },
                { uuid: '2902' },
              ],
            },
          ],
        },
      ],
    };

    const result = validatePeripheralDefinition(definition);
    expect(result.success).toBe(true);
    if (!result.success) return;

    initialValue[0] = 9;
    properties[0] = 'notify';
    expect(result.value).toMatchObject({
      address: 'AA:BB:CC:DD:EE:FF',
      name: 'Sensor',
      knownServiceUuids: ['0000180f-0000-1000-8000-00805f9b34fb'],
      services: [
        {
          uuid: '0000180f-0000-1000-8000-00805f9b34fb',
          isPrimary: true,
          characteristics: [
            {
              uuid: '00002a19-0000-1000-8000-00805f9b34fb',
              properties: ['read', 'notify'],
              initialValue: new Uint8Array([1, 2]),
              descriptors: [
                {
                  uuid: '00002901-0000-1000-8000-00805f9b34fb',
                  initialValue: new Uint8Array([65]),
                },
                {
                  uuid: '00002902-0000-1000-8000-00805f9b34fb',
                },
              ],
            },
          ],
        },
      ],
      defaults: { connection: 'success', discovery: 'success' },
    });

    const firstRead =
      result.value.services[0]?.characteristics[0]?.initialValue;
    const secondRead =
      result.value.services[0]?.characteristics[0]?.initialValue;
    expect(firstRead).not.toBe(secondRead);
    if (firstRead === undefined) throw new Error('Expected an initial value.');
    firstRead[0] = 99;
    expect([
      ...(result.value.services[0]?.characteristics[0]?.initialValue ?? []),
    ]).toEqual([1, 2]);
  });

  it('derives identity and advertisement UUIDs from primary services only', () => {
    const result = validatePeripheralDefinition({
      address: '00:11:22:33:44:55',
      name: 'Primary identity',
      advertisement: { rssi: -45 },
      services: [{ uuid: '180f' }, { uuid: '1810', isPrimary: false }],
    });

    expect(result).toMatchObject({
      success: true,
      value: {
        knownServiceUuids: ['0000180f-0000-1000-8000-00805f9b34fb'],
        advertisement: {
          name: 'Primary identity',
          serviceUuids: ['0000180f-0000-1000-8000-00805f9b34fb'],
        },
      },
    });
  });

  it('uses only the explicit known-service override when supplied', () => {
    const result = validatePeripheralDefinition({
      address: '00:11:22:33:44:55',
      name: 'Negative identity',
      knownServiceUuidsOverride: ['12345678'],
      services: [{ uuid: '180f' }],
    });

    expect(result).toMatchObject({
      success: true,
      value: {
        knownServiceUuids: ['12345678-0000-1000-8000-00805f9b34fb'],
      },
    });
  });

  it('normalizes advertisement and defensively exposes manufacturer bytes', () => {
    const manufacturerBytes = new Uint8Array([1, 2, 3]);
    const result = validatePeripheralDefinition({
      address: '00:11:22:33:44:55',
      name: 'Advertiser',
      manufacturerData: [{ companyId: 0x004c, data: manufacturerBytes }],
      advertisement: {
        rssi: -50,
        appearance: 833,
        txPower: -4,
        serviceUuids: ['180f'],
      },
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    manufacturerBytes[0] = 9;
    expect(result.value).toMatchObject({
      manufacturerData: [
        { companyId: 0x004c, data: new Uint8Array([1, 2, 3]) },
      ],
      advertisement: {
        rssi: -50,
        name: 'Advertiser',
        appearance: 833,
        txPower: -4,
        serviceUuids: ['0000180f-0000-1000-8000-00805f9b34fb'],
        manufacturerData: [
          { companyId: 0x004c, data: new Uint8Array([1, 2, 3]) },
        ],
      },
    });

    const firstRead = result.value.manufacturerData[0]?.data;
    const secondRead = result.value.manufacturerData[0]?.data;
    expect(firstRead).not.toBe(secondRead);
    if (firstRead === undefined) throw new Error('Expected manufacturer data.');
    firstRead[0] = 99;
    expect([...(result.value.manufacturerData[0]?.data ?? [])]).toEqual([
      1, 2, 3,
    ]);
  });

  it('rejects duplicate normalized UUIDs only among siblings', () => {
    const issues = expectFailure({
      address: '00:11:22:33:44:55',
      name: 'Duplicates',
      services: [
        {
          uuid: '180f',
          characteristics: [
            { uuid: '2a19', properties: ['read'] },
            { uuid: '2A19', properties: ['read'] },
          ],
        },
        { uuid: '0000180F-0000-1000-8000-00805F9B34FB' },
      ],
    });

    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: ['services', 0, 'characteristics', 1, 'uuid'],
          code: 'duplicate-uuid',
        }),
        expect.objectContaining({
          path: ['services', 1, 'uuid'],
          code: 'duplicate-uuid',
        }),
      ]),
    );
  });

  it('allows the same nested UUID beneath different parents', () => {
    const result = validatePeripheralDefinition({
      address: '00:11:22:33:44:55',
      name: 'Repeated nested UUID',
      services: [
        {
          uuid: '180f',
          characteristics: [{ uuid: '2a19', properties: ['read'] }],
        },
        {
          uuid: '1810',
          characteristics: [{ uuid: '2a19', properties: ['read'] }],
        },
      ],
    });

    expect(result.success).toBe(true);
  });

  it.each(['notify', 'indicate'] as const)(
    'requires a Client Characteristic Configuration descriptor for %s',
    (property) => {
      const issues = expectFailure({
        address: '00:11:22:33:44:55',
        name: 'Missing CCCD',
        services: [
          {
            uuid: '180f',
            characteristics: [
              {
                uuid: '2a19',
                properties: [property],
                descriptors: [{ uuid: '2901' }],
              },
            ],
          },
        ],
      });

      expect(issues).toEqual([
        {
          path: ['services', 0, 'characteristics', 0, 'descriptors'],
          code: 'missing-cccd-descriptor',
          message:
            'Characteristics with notify or indicate must define the Client Characteristic Configuration descriptor (0x2902).',
        },
      ]);
    },
  );

  it('accepts the normalized Client Characteristic Configuration UUID', () => {
    const result = validatePeripheralDefinition({
      address: '00:11:22:33:44:55',
      name: 'Indicating sensor',
      services: [
        {
          uuid: '180f',
          characteristics: [
            {
              uuid: '2a19',
              properties: ['indicate'],
              descriptors: [{ uuid: '00002902-0000-1000-8000-00805f9b34fb' }],
            },
          ],
        },
      ],
    });

    expect(result.success).toBe(true);
  });

  it('collects deterministic path-aware issues without partial output', () => {
    const issues = expectFailure({
      address: 'bad',
      name: 1,
      knownServiceUuidsOverride: ['battery_service', '180f', '180F'],
      services: [
        {
          uuid: 'nope',
          isPrimary: 'yes',
          characteristics: [
            {
              uuid: '2a19',
              properties: ['read', 'read', 'unsupported'],
              initialValue: [256],
              descriptors: 'bad',
            },
          ],
        },
      ],
    });

    expect(issues.map(({ path, code }) => ({ path, code }))).toEqual(
      expect.arrayContaining([
        { path: ['address'], code: 'invalid-address' },
        { path: ['name'], code: 'invalid-type' },
        { path: ['services', 0, 'uuid'], code: 'invalid-uuid' },
        { path: ['services', 0, 'isPrimary'], code: 'invalid-type' },
        {
          path: ['services', 0, 'characteristics', 0, 'properties', 1],
          code: 'duplicate-property',
        },
        {
          path: ['services', 0, 'characteristics', 0, 'properties', 2],
          code: 'invalid-property',
        },
        {
          path: ['services', 0, 'characteristics', 0, 'initialValue'],
          code: 'invalid-byte-source',
        },
        {
          path: ['services', 0, 'characteristics', 0, 'descriptors'],
          code: 'invalid-type',
        },
        { path: ['knownServiceUuidsOverride', 0], code: 'invalid-uuid' },
        {
          path: ['knownServiceUuidsOverride', 2, 'uuid'],
          code: 'duplicate-uuid',
        },
      ]),
    );
  });

  it('validates manufacturer data, advertisement, and defaults together', () => {
    const issues = expectFailure({
      address: '00:11:22:33:44:55',
      name: 'Malformed scan data',
      manufacturerData: [
        { companyId: 65_536, data: [1] },
        { companyId: 1, data: [1] },
        { companyId: 1, data: [2] },
      ],
      advertisement: {
        rssi: 1.5,
        name: 2,
        appearance: -1,
        txPower: Number.POSITIVE_INFINITY,
        serviceUuids: ['180f', '180F'],
        manufacturerData: 'bad',
      },
      defaults: { connection: 'failure', discovery: 1 },
    });

    expect(issues.map(({ path, code }) => ({ path, code }))).toEqual(
      expect.arrayContaining([
        {
          path: ['manufacturerData', 0, 'companyId'],
          code: 'invalid-number',
        },
        {
          path: ['manufacturerData', 2, 'companyId'],
          code: 'duplicate-company-id',
        },
        { path: ['advertisement', 'rssi'], code: 'invalid-number' },
        { path: ['advertisement', 'name'], code: 'invalid-type' },
        { path: ['advertisement', 'appearance'], code: 'invalid-number' },
        { path: ['advertisement', 'txPower'], code: 'invalid-number' },
        {
          path: ['advertisement', 'serviceUuids', 1, 'uuid'],
          code: 'duplicate-uuid',
        },
        {
          path: ['advertisement', 'manufacturerData'],
          code: 'invalid-type',
        },
        { path: ['defaults', 'connection'], code: 'invalid-default' },
        { path: ['defaults', 'discovery'], code: 'invalid-default' },
      ]),
    );
  });

  it.each([null, [], 'device', 1])('rejects non-object root %j', (input) => {
    expect(expectFailure(input)).toEqual([
      {
        path: [],
        code: 'invalid-type',
        message: 'Expected a peripheral object.',
      },
    ]);
  });

  it('has a narrowed success value type', () => {
    const result = validatePeripheralDefinition({
      address: '00:11:22:33:44:55',
      name: 'Typed',
    });
    if (!result.success) throw new Error('Expected valid model.');
    expectTypeOf(result.value).toEqualTypeOf<NormalizedPeripheral>();
  });
});
