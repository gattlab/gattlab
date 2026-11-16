import { describe, expect, it } from 'vitest';

import {
  BluetoothBackendStoppedError,
  BluetoothPeripheralAlreadyRegisteredError,
  validatePeripheralDefinition,
  type NormalizedPeripheral,
} from '@gattlab/core';

import { CdpEntityRegistry } from '../src/entity-registry.js';
import { createCdpTransport, type CdpSessionLike } from '../src/transport.js';

interface SentCommand {
  readonly method: string;
  readonly parameters?: object;
}

class EntityCdpSession implements CdpSessionLike {
  readonly calls: SentCommand[] = [];
  readonly responses = new Map<string, unknown[]>();
  failMethod: string | undefined;
  onSend: ((method: string) => void) | undefined;

  async send(method: string, parameters?: object): Promise<unknown> {
    this.calls.push({
      method,
      ...(parameters === undefined ? {} : { parameters }),
    });
    this.onSend?.(method);
    if (method === this.failMethod) throw new Error(`${method} failed`);
    const responses = this.responses.get(method) ?? [];
    const response = responses.shift();
    if (response === undefined) {
      throw new Error(`Missing fake response for ${method}.`);
    }
    if (response instanceof Error) throw response;
    return response;
  }

  on(): void {
    return undefined;
  }

  off(): void {
    return undefined;
  }

  detach(): Promise<void> {
    return Promise.resolve();
  }
}

function normalizedPeripheral(
  options: Readonly<{ address?: string; secondary?: boolean }> = {},
): NormalizedPeripheral {
  const result = validatePeripheralDefinition({
    address: options.address ?? '00:11:22:33:44:55',
    name: 'Registry sensor',
    manufacturerData: [
      { companyId: 0x1234, data: [1, 2, 3, 4] },
      { companyId: 0x1235, data: [0xfb, 0xff] },
    ],
    advertisement: {
      rssi: -45,
      name: 'Advertising registry sensor',
      appearance: 0,
      txPower: -4,
      manufacturerData: [{ companyId: 0x004c, data: [0x10, 0x20, 0x30] }],
    },
    services: [
      {
        uuid: '180f',
        isPrimary: options.secondary !== true,
        characteristics: [
          {
            uuid: '2a19',
            properties: [
              'broadcast',
              'read',
              'write-without-response',
              'write',
              'notify',
              'indicate',
              'authenticated-signed-writes',
              'extended-properties',
            ],
            initialValue: [50],
            descriptors: [
              { uuid: '2902', initialValue: [0, 0] },
              { uuid: '2901', initialValue: [82] },
            ],
          },
        ],
      },
    ],
  });
  if (!result.success) throw new Error('Expected a valid fixture.');
  return result.value;
}

function createDeferred<T>(): Readonly<{
  promise: Promise<T>;
  resolve: (value: T) => void;
}> {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve(value) {
      if (resolvePromise === undefined) {
        throw new Error('Deferred promise was not initialized.');
      }
      resolvePromise(value);
    },
  };
}

function configuredSession(): EntityCdpSession {
  const session = new EntityCdpSession();
  session.responses.set('BluetoothEmulation.addService', [
    { serviceId: 'service-1' },
  ]);
  session.responses.set('BluetoothEmulation.addCharacteristic', [
    { characteristicId: 'characteristic-1' },
  ]);
  session.responses.set('BluetoothEmulation.addDescriptor', [
    { descriptorId: 'descriptor-1' },
    { descriptorId: 'descriptor-2' },
  ]);
  session.responses.set('BluetoothEmulation.simulatePreconnectedPeripheral', [
    {},
  ]);
  session.responses.set('BluetoothEmulation.simulateAdvertisement', [{}]);
  return session;
}

describe('CdpEntityRegistry', () => {
  it('constructs parent-first and maps every property and opaque id', async () => {
    const session = configuredSession();
    const registry = new CdpEntityRegistry(
      createCdpTransport('browser', session),
    );
    const peripheral = normalizedPeripheral();

    await registry.addPeripheralHierarchy(peripheral);

    expect(session.calls).toEqual([
      {
        method: 'BluetoothEmulation.simulatePreconnectedPeripheral',
        parameters: {
          address: peripheral.address,
          name: peripheral.name,
          manufacturerData: [
            { key: 0x1234, data: 'AQIDBA==' },
            { key: 0x1235, data: '+/8=' },
          ],
          knownServiceUuids: [...peripheral.knownServiceUuids],
        },
      },
      {
        method: 'BluetoothEmulation.addService',
        parameters: {
          address: peripheral.address,
          serviceUuid: peripheral.services[0]?.uuid,
        },
      },
      {
        method: 'BluetoothEmulation.addCharacteristic',
        parameters: {
          serviceId: 'service-1',
          characteristicUuid: peripheral.services[0]?.characteristics[0]?.uuid,
          properties: {
            broadcast: true,
            read: true,
            writeWithoutResponse: true,
            write: true,
            notify: true,
            indicate: true,
            authenticatedSignedWrites: true,
            extendedProperties: true,
          },
        },
      },
      {
        method: 'BluetoothEmulation.addDescriptor',
        parameters: {
          characteristicId: 'characteristic-1',
          descriptorUuid:
            peripheral.services[0]?.characteristics[0]?.descriptors[0]?.uuid,
        },
      },
      {
        method: 'BluetoothEmulation.addDescriptor',
        parameters: {
          characteristicId: 'characteristic-1',
          descriptorUuid:
            peripheral.services[0]?.characteristics[0]?.descriptors[1]?.uuid,
        },
      },
    ]);
    expect(registry.size).toBe(1);
    expect(registry.getPeripheral(peripheral.address)).toBe(peripheral);
    expect(registry.getService('service-1')?.reference).toEqual({
      kind: 'service',
      address: peripheral.address,
      serviceUuid: peripheral.services[0]?.uuid,
    });
    const registeredCharacteristic =
      registry.getCharacteristic('characteristic-1');
    expect(registeredCharacteristic?.reference).toEqual({
      kind: 'characteristic',
      address: peripheral.address,
      serviceUuid: peripheral.services[0]?.uuid,
      characteristicUuid: peripheral.services[0]?.characteristics[0]?.uuid,
    });
    if (registeredCharacteristic === undefined) {
      throw new Error('Expected a registered characteristic.');
    }
    expect(
      registry.getCharacteristicByReference(registeredCharacteristic.reference),
    ).toBe(registeredCharacteristic);
    const registeredDescriptor = registry.getDescriptor('descriptor-1');
    expect(registeredDescriptor?.reference).toEqual({
      kind: 'descriptor',
      address: peripheral.address,
      serviceUuid: peripheral.services[0]?.uuid,
      characteristicUuid: peripheral.services[0]?.characteristics[0]?.uuid,
      descriptorUuid:
        peripheral.services[0]?.characteristics[0]?.descriptors[0]?.uuid,
    });
    if (registeredDescriptor === undefined) {
      throw new Error('Expected a registered descriptor.');
    }
    expect(
      registry.getDescriptorByReference(registeredDescriptor.reference),
    ).toBe(registeredDescriptor);
    const secondDescriptor = registry.getDescriptor('descriptor-2');
    if (secondDescriptor === undefined) {
      throw new Error('Expected a second registered descriptor.');
    }
    expect(registry.getDescriptorByReference(secondDescriptor.reference)).toBe(
      secondDescriptor,
    );
  });

  it('indexes distinct characteristics in one service by stable reference', async () => {
    const definition = validatePeripheralDefinition({
      address: '00:11:22:33:44:88',
      name: 'Multi-characteristic sensor',
      services: [
        {
          uuid: '180f',
          characteristics: [
            { uuid: '2a19', properties: ['read'] },
            { uuid: '2a1a', properties: ['read'] },
          ],
        },
      ],
    });
    if (!definition.success) throw new Error('Expected a valid fixture.');
    const session = configuredSession();
    session.responses.set('BluetoothEmulation.addCharacteristic', [
      { characteristicId: 'characteristic-1' },
      { characteristicId: 'characteristic-2' },
    ]);
    const registry = new CdpEntityRegistry(
      createCdpTransport('browser', session),
    );

    await registry.addPeripheralHierarchy(definition.value);

    const first = registry.getCharacteristic('characteristic-1');
    const second = registry.getCharacteristic('characteristic-2');
    if (first === undefined || second === undefined) {
      throw new Error('Expected two registered characteristics.');
    }
    expect(registry.getCharacteristicByReference(first.reference)).toBe(first);
    expect(registry.getCharacteristicByReference(second.reference)).toBe(
      second,
    );
  });

  it('rejects duplicate addresses and secondary services before mutation', async () => {
    const session = configuredSession();
    const registry = new CdpEntityRegistry(
      createCdpTransport('browser', session),
    );
    const peripheral = normalizedPeripheral();
    await registry.addPeripheralHierarchy(peripheral);
    const callCount = session.calls.length;

    await expect(
      registry.addPeripheralHierarchy(peripheral),
    ).rejects.toBeInstanceOf(BluetoothPeripheralAlreadyRegisteredError);
    expect(session.calls).toHaveLength(callCount);

    registry.resetAfterDomainDisable();
    await expect(
      registry.addPeripheralHierarchy(
        normalizedPeripheral({ secondary: true }),
      ),
    ).rejects.toMatchObject({
      context: { capability: 'secondaryServices' },
    });
    expect(session.calls).toHaveLength(callCount);
  });

  it('bootstraps chooser identity once before advertisement or preconnection', async () => {
    const session = configuredSession();
    const registry = new CdpEntityRegistry(
      createCdpTransport('browser', session),
    );
    const peripheral = normalizedPeripheral();
    await registry.addPeripheralHierarchy(peripheral);
    const descriptorReference =
      registry.getDescriptor('descriptor-1')?.reference;
    const characteristicReference =
      registry.getCharacteristic('characteristic-1')?.reference;
    if (descriptorReference === undefined) {
      throw new Error('Expected a registered descriptor.');
    }
    if (characteristicReference === undefined) {
      throw new Error('Expected a registered characteristic.');
    }
    session.calls.length = 0;

    await expect(
      registry.simulateAdvertisement(peripheral.address),
    ).resolves.toBe('existing');
    await expect(
      registry.createPreconnectedPeripheral(peripheral.address),
    ).resolves.toBe('existing');

    expect(session.calls).toEqual([
      {
        method: 'BluetoothEmulation.simulateAdvertisement',
        parameters: {
          entry: {
            deviceAddress: peripheral.address,
            rssi: -45,
            scanRecord: {
              name: 'Advertising registry sensor',
              uuids: [...peripheral.knownServiceUuids],
              appearance: 0,
              txPower: -4,
              manufacturerData: [{ key: 0x004c, data: 'ECAw' }],
            },
          },
        },
      },
    ]);

    registry.resetAfterDomainDisable();
    expect(session.calls).toHaveLength(1);
    expect(
      registry.getDescriptorByReference(descriptorReference),
    ).toBeUndefined();
    expect(
      registry.getCharacteristicByReference(characteristicReference),
    ).toBeUndefined();
  });

  it('shares one in-flight identity bootstrap between concurrent callers', async () => {
    const definition = validatePeripheralDefinition({
      address: '00:11:22:33:44:77',
      name: 'Concurrent identity sensor',
    });
    if (!definition.success) throw new Error('Expected a valid fixture.');
    const session = configuredSession();
    const registry = new CdpEntityRegistry(
      createCdpTransport('browser', session),
    );
    await registry.addPeripheralHierarchy(definition.value);

    await expect(
      Promise.all([
        registry.createPreconnectedPeripheral(definition.value.address),
        registry.createPreconnectedPeripheral(definition.value.address),
      ]),
    ).resolves.toEqual(['created', 'existing']);
    expect(
      session.calls.filter(
        ({ method }) =>
          method === 'BluetoothEmulation.simulatePreconnectedPeripheral',
      ),
    ).toHaveLength(1);
  });

  it('replaces stale entity ids before advertising a disconnected peripheral', async () => {
    const session = configuredSession();
    const registry = new CdpEntityRegistry(
      createCdpTransport('browser', session),
    );
    const peripheral = normalizedPeripheral();
    await registry.addPeripheralHierarchy(peripheral);
    const oldCharacteristic = registry.getCharacteristic('characteristic-1');
    const oldDescriptor = registry.getDescriptor('descriptor-1');
    if (oldCharacteristic === undefined || oldDescriptor === undefined) {
      throw new Error('Expected the initial hierarchy to be registered.');
    }

    session.responses.set('BluetoothEmulation.addService', [
      { serviceId: 'service-2' },
    ]);
    session.responses.set('BluetoothEmulation.addCharacteristic', [
      { characteristicId: 'characteristic-2' },
    ]);
    session.responses.set('BluetoothEmulation.addDescriptor', [
      { descriptorId: 'descriptor-3' },
      { descriptorId: 'descriptor-4' },
    ]);

    await expect(
      registry.rehydrateAfterDisconnection(peripheral.address),
    ).resolves.toBeUndefined();
    await expect(
      registry.simulateAdvertisement(peripheral.address),
    ).resolves.toBe('existing');
    expect(registry.getPeripheral(peripheral.address)).toBe(peripheral);
    expect(registry.getService('service-1')).toBeUndefined();
    expect(registry.getCharacteristic('characteristic-1')).toBeUndefined();
    expect(registry.getDescriptor('descriptor-1')).toBeUndefined();
    expect(registry.getService('service-2')?.reference.address).toBe(
      peripheral.address,
    );
    expect(
      registry.getCharacteristicByReference(oldCharacteristic.reference)?.id,
    ).toBe('characteristic-2');
    expect(registry.getDescriptorByReference(oldDescriptor.reference)?.id).toBe(
      'descriptor-3',
    );
  });

  it('serializes repeated disconnection rehydration for one address', async () => {
    const session = configuredSession();
    const registry = new CdpEntityRegistry(
      createCdpTransport('browser', session),
    );
    const peripheral = normalizedPeripheral();
    await registry.addPeripheralHierarchy(peripheral);
    const characteristicReference =
      registry.getCharacteristic('characteristic-1')?.reference;
    if (characteristicReference === undefined) {
      throw new Error('Expected the initial characteristic.');
    }
    session.responses.set('BluetoothEmulation.addService', [
      { serviceId: 'service-2' },
      { serviceId: 'service-3' },
    ]);
    session.responses.set('BluetoothEmulation.addCharacteristic', [
      { characteristicId: 'characteristic-2' },
      { characteristicId: 'characteristic-3' },
    ]);
    session.responses.set('BluetoothEmulation.addDescriptor', [
      { descriptorId: 'descriptor-3' },
      { descriptorId: 'descriptor-4' },
      { descriptorId: 'descriptor-5' },
      { descriptorId: 'descriptor-6' },
    ]);

    await expect(
      Promise.all([
        registry.rehydrateAfterDisconnection(peripheral.address),
        registry.rehydrateAfterDisconnection(peripheral.address),
      ]),
    ).resolves.toEqual([undefined, undefined]);

    expect(registry.getCharacteristic('characteristic-2')).toBeUndefined();
    expect(
      registry.getCharacteristicByReference(characteristicReference)?.id,
    ).toBe('characteristic-3');
  });

  it('invalidates the registry when disconnection rehydration fails', async () => {
    const session = configuredSession();
    const registry = new CdpEntityRegistry(
      createCdpTransport('browser', session),
    );
    const peripheral = normalizedPeripheral();
    await registry.addPeripheralHierarchy(peripheral);
    session.failMethod = 'BluetoothEmulation.addService';

    await expect(
      registry.rehydrateAfterDisconnection(peripheral.address),
    ).rejects.toThrow('BluetoothEmulation.addService failed');

    expect(registry.requiresReset).toBe(true);
    expect(registry.size).toBe(0);
  });

  it('invalidates the registry when identity bootstrap fails', async () => {
    const session = configuredSession();
    const registry = new CdpEntityRegistry(
      createCdpTransport('browser', session),
    );
    const peripheral = normalizedPeripheral();
    session.failMethod = 'BluetoothEmulation.simulatePreconnectedPeripheral';

    await expect(registry.addPeripheralHierarchy(peripheral)).rejects.toThrow(
      'BluetoothEmulation.simulatePreconnectedPeripheral failed',
    );
    expect(registry.requiresReset).toBe(true);
    expect(registry.size).toBe(0);
  });

  it('supplies deterministic Chromium defaults for optional scan fields', async () => {
    const definition = validatePeripheralDefinition({
      address: '00:11:22:33:44:66',
      name: 'Default scan sensor',
      advertisement: { rssi: -50 },
    });
    if (!definition.success) throw new Error('Expected a valid fixture.');
    const session = configuredSession();
    const registry = new CdpEntityRegistry(
      createCdpTransport('browser', session),
    );

    await registry.addPeripheralHierarchy(definition.value);
    await registry.simulateAdvertisement(definition.value.address);

    expect(session.calls.at(-1)).toEqual({
      method: 'BluetoothEmulation.simulateAdvertisement',
      parameters: {
        entry: {
          deviceAddress: definition.value.address,
          rssi: -50,
          scanRecord: {
            name: 'Default scan sensor',
            uuids: [],
            appearance: 0,
            txPower: 0,
            manufacturerData: [],
          },
        },
      },
    });
  });

  it('hides partial entities and requires an authoritative reset after failure', async () => {
    const session = configuredSession();
    session.failMethod = 'BluetoothEmulation.addDescriptor';
    const registry = new CdpEntityRegistry(
      createCdpTransport('browser', session),
    );
    const peripheral = normalizedPeripheral();

    await expect(registry.addPeripheralHierarchy(peripheral)).rejects.toThrow(
      'BluetoothEmulation.addDescriptor failed',
    );
    expect(registry.requiresReset).toBe(true);
    expect(registry.size).toBe(0);
    expect(registry.getService('service-1')).toBeUndefined();
    expect(registry.getCharacteristic('characteristic-1')).toBeUndefined();

    await expect(
      registry.addPeripheralHierarchy(peripheral),
    ).rejects.toMatchObject({
      context: { operation: 'add peripheral hierarchy' },
    });
    await expect(
      registry.simulateAdvertisement(peripheral.address),
    ).rejects.toMatchObject({
      context: { operation: 'simulate advertisement' },
    });
    expect(() =>
      registry.createPreconnectedPeripheral(peripheral.address),
    ).toThrowError(
      expect.objectContaining({
        context: { operation: 'create preconnected peripheral' },
      }),
    );

    registry.resetAfterDomainDisable();
    expect(registry.requiresReset).toBe(false);
  });

  it('rejects an in-flight hierarchy when a concurrent failure invalidates the registry', async () => {
    const session = configuredSession();
    const addServiceStarted = createDeferred<undefined>();
    const addServiceResponse = createDeferred<{ serviceId: string }>();
    session.responses.set('BluetoothEmulation.simulatePreconnectedPeripheral', [
      {},
      new Error('Concurrent identity bootstrap failed'),
    ]);
    session.responses.set('BluetoothEmulation.addService', [
      addServiceResponse.promise,
    ]);
    session.onSend = (method) => {
      if (method === 'BluetoothEmulation.addService') {
        addServiceStarted.resolve(undefined);
      }
    };

    const registry = new CdpEntityRegistry(
      createCdpTransport('browser', session),
    );
    const first = normalizedPeripheral();
    const second = normalizedPeripheral({ address: '00:11:22:33:44:66' });

    const firstRegistration = registry.addPeripheralHierarchy(first);
    await addServiceStarted.promise;
    await expect(registry.addPeripheralHierarchy(second)).rejects.toThrow(
      'BluetoothEmulation.simulatePreconnectedPeripheral failed',
    );

    addServiceResponse.resolve({ serviceId: 'service-after-invalidation' });
    await expect(firstRegistration).rejects.toBeInstanceOf(
      BluetoothBackendStoppedError,
    );

    expect(registry.requiresReset).toBe(true);
    expect(registry.size).toBe(0);
    expect(registry.getPeripheral(first.address)).toBeUndefined();
    expect(
      session.calls.filter(
        ({ method }) =>
          method === 'BluetoothEmulation.addCharacteristic' ||
          method === 'BluetoothEmulation.addDescriptor',
      ),
    ).toHaveLength(0);
  });
});
