import {
  BluetoothBackendStoppedError,
  BluetoothCapabilityUnsupportedError,
  PeripheralAddressRegistry,
  type BluetoothAddress,
  type CharacteristicProperty,
  type CharacteristicReference,
  type DescriptorReference,
  type NormalizedCharacteristic,
  type NormalizedDescriptor,
  type NormalizedPeripheral,
  type NormalizedService,
  type ServiceReference,
} from '@gattlab/core';

import { encodeBase64 } from './base64.js';
import type { CdpCommandArguments, CdpTransport } from './transport.js';

interface EntityMutation {
  readonly transport: Pick<CdpTransport<'browser'>, 'send'>;
  assertCommittable(): void;
  markModelEffect(): void;
}

type CdpCharacteristicProperties =
  CdpCommandArguments<'BluetoothEmulation.addCharacteristic'>[0]['properties'];

const cdpCharacteristicPropertyNames = {
  broadcast: 'broadcast',
  read: 'read',
  'write-without-response': 'writeWithoutResponse',
  write: 'write',
  notify: 'notify',
  indicate: 'indicate',
  'authenticated-signed-writes': 'authenticatedSignedWrites',
  'extended-properties': 'extendedProperties',
} as const satisfies Record<
  CharacteristicProperty,
  keyof CdpCharacteristicProperties
>;

export interface RegisteredCdpService {
  readonly id: string;
  readonly reference: ServiceReference;
  readonly definition: NormalizedService;
}

export interface RegisteredCdpCharacteristic {
  readonly id: string;
  readonly reference: CharacteristicReference;
  readonly definition: NormalizedCharacteristic;
}

export interface RegisteredCdpDescriptor {
  readonly id: string;
  readonly reference: DescriptorReference;
  readonly definition: NormalizedDescriptor;
}

export type CdpIdentityRegistration = 'created' | 'existing';

/** Owns the CDP identity and entity mappings for one backend lifecycle. */
export class CdpEntityRegistry {
  readonly #transport: CdpTransport<'browser'>;
  readonly #addresses = new PeripheralAddressRegistry();
  readonly #peripherals = new Map<BluetoothAddress, NormalizedPeripheral>();
  readonly #services = new Map<string, RegisteredCdpService>();
  readonly #characteristics = new Map<string, RegisteredCdpCharacteristic>();
  readonly #characteristicsByReference = new Map<
    string,
    RegisteredCdpCharacteristic
  >();
  readonly #descriptors = new Map<string, RegisteredCdpDescriptor>();
  readonly #descriptorsByReference = new Map<string, RegisteredCdpDescriptor>();
  readonly #identityRegistrations = new Map<BluetoothAddress, Promise<void>>();
  readonly #disconnectRehydrations = new Map<BluetoothAddress, Promise<void>>();
  #requiresReset = false;

  constructor(transport: CdpTransport<'browser'>) {
    this.#transport = transport;
  }

  get requiresReset(): boolean {
    return this.#requiresReset;
  }

  get size(): number {
    return this.#peripherals.size;
  }

  getPeripheral(address: BluetoothAddress): NormalizedPeripheral | undefined {
    return this.#peripherals.get(address);
  }

  getService(id: string): RegisteredCdpService | undefined {
    return this.#services.get(id);
  }

  getCharacteristic(id: string): RegisteredCdpCharacteristic | undefined {
    return this.#characteristics.get(id);
  }

  getCharacteristicByReference(
    reference: CharacteristicReference,
  ): RegisteredCdpCharacteristic | undefined {
    return this.#characteristicsByReference.get(
      characteristicReferenceKey(reference),
    );
  }

  getDescriptor(id: string): RegisteredCdpDescriptor | undefined {
    return this.#descriptors.get(id);
  }

  getDescriptorByReference(
    reference: DescriptorReference,
  ): RegisteredCdpDescriptor | undefined {
    return this.#descriptorsByReference.get(descriptorReferenceKey(reference));
  }

  async addPeripheralHierarchy(
    peripheral: NormalizedPeripheral,
    mutation?: EntityMutation,
  ): Promise<CdpIdentityRegistration | undefined> {
    this.#assertUsable('add peripheral hierarchy');
    this.#assertPrimaryServices(peripheral);

    let identity: CdpIdentityRegistration | undefined;
    await this.#addresses.register(peripheral.address, async () => {
      try {
        if (peripheral.services.length > 0) {
          identity = await this.#ensureIdentity(
            peripheral,
            'add peripheral hierarchy',
            mutation,
          );
        }
        const staged = await this.#createHierarchy(peripheral, mutation);
        this.#commit(peripheral, staged, mutation);
      } catch (cause) {
        this.#invalidate();
        throw cause;
      }
    });
    return identity;
  }

  async simulateAdvertisement(
    address: BluetoothAddress,
    mutation?: EntityMutation,
  ): Promise<CdpIdentityRegistration> {
    this.#assertUsable('simulate advertisement');
    const peripheral = this.#requirePeripheral(address);
    const advertisement = peripheral.advertisement;
    if (advertisement === undefined) {
      throw new TypeError(
        `Bluetooth peripheral ${address} has no advertisement definition.`,
      );
    }

    const identity = await this.#ensureIdentity(
      peripheral,
      'simulate advertisement',
      mutation,
    );
    try {
      this.#assertUsable('simulate advertisement');
      await (mutation?.transport ?? this.#transport).send(
        'BluetoothEmulation.simulateAdvertisement',
        {
          entry: {
            deviceAddress: peripheral.address,
            rssi: advertisement.rssi,
            scanRecord: {
              name: advertisement.name,
              uuids: [...advertisement.serviceUuids],
              // Chromium 151 leaves the command pending when either optional
              // field is omitted. Appearance 0 means unknown, while txPower 0 is
              // an application-visible 0 dBm substitute rather than a sentinel.
              appearance: advertisement.appearance ?? 0,
              txPower: advertisement.txPower ?? 0,
              manufacturerData: toCdpManufacturerData(
                advertisement.manufacturerData,
              ),
            },
          },
        },
      );
      this.#assertUsable('simulate advertisement');
    } catch (cause) {
      this.#invalidate();
      throw cause;
    }
    return identity;
  }

  async rehydrateAfterDisconnection(
    address: BluetoothAddress,
    mutation?: EntityMutation,
  ): Promise<void> {
    this.#assertUsable('rehydrate disconnected peripheral');
    const previous = this.#disconnectRehydrations.get(address);
    const rehydration = (previous ?? Promise.resolve())
      .catch(() => undefined)
      .then(async () => {
        this.#assertUsable('rehydrate disconnected peripheral');
        const peripheral = this.#requirePeripheral(address);
        mutation?.markModelEffect();
        this.#removeHierarchy(address);
        try {
          const staged = await this.#createHierarchy(peripheral, mutation);
          this.#commit(peripheral, staged, mutation);
        } catch (cause) {
          this.#invalidate();
          throw cause;
        }
      });
    this.#disconnectRehydrations.set(address, rehydration);
    try {
      await rehydration;
    } finally {
      if (this.#disconnectRehydrations.get(address) === rehydration) {
        this.#disconnectRehydrations.delete(address);
      }
    }
  }

  createPreconnectedPeripheral(
    address: BluetoothAddress,
    mutation?: EntityMutation,
  ): Promise<CdpIdentityRegistration> {
    this.#assertUsable('create preconnected peripheral');
    return this.#ensureIdentity(
      this.#requirePeripheral(address),
      'create preconnected peripheral',
      mutation,
    );
  }

  invalidate(): void {
    this.#requiresReset = true;
    this.#peripherals.clear();
    this.#services.clear();
    this.#characteristics.clear();
    this.#characteristicsByReference.clear();
    this.#descriptors.clear();
    this.#descriptorsByReference.clear();
  }

  resetAfterDomainDisable(): void {
    this.#clearEntities();
    this.#requiresReset = false;
  }

  async #createHierarchy(
    peripheral: NormalizedPeripheral,
    mutation?: EntityMutation,
  ): Promise<{
    readonly services: readonly RegisteredCdpService[];
    readonly characteristics: readonly RegisteredCdpCharacteristic[];
    readonly descriptors: readonly RegisteredCdpDescriptor[];
  }> {
    const services: RegisteredCdpService[] = [];
    const characteristics: RegisteredCdpCharacteristic[] = [];
    const descriptors: RegisteredCdpDescriptor[] = [];

    for (const service of peripheral.services) {
      this.#assertUsable('add peripheral hierarchy');
      const { serviceId } = await (mutation?.transport ?? this.#transport).send(
        'BluetoothEmulation.addService',
        { address: peripheral.address, serviceUuid: service.uuid },
      );
      this.#assertUsable('add peripheral hierarchy');
      this.#assertUniqueId(serviceId, this.#services, services);
      services.push(
        Object.freeze({
          id: serviceId,
          reference: Object.freeze({
            kind: 'service',
            address: peripheral.address,
            serviceUuid: service.uuid,
          }),
          definition: service,
        }),
      );

      for (const characteristic of service.characteristics) {
        this.#assertUsable('add peripheral hierarchy');
        const { characteristicId } = await (
          mutation?.transport ?? this.#transport
        ).send('BluetoothEmulation.addCharacteristic', {
          serviceId,
          characteristicUuid: characteristic.uuid,
          properties: toCdpCharacteristicProperties(characteristic.properties),
        });
        this.#assertUsable('add peripheral hierarchy');
        this.#assertUniqueId(
          characteristicId,
          this.#characteristics,
          characteristics,
        );
        characteristics.push(
          Object.freeze({
            id: characteristicId,
            reference: Object.freeze({
              kind: 'characteristic',
              address: peripheral.address,
              serviceUuid: service.uuid,
              characteristicUuid: characteristic.uuid,
            }),
            definition: characteristic,
          }),
        );

        for (const descriptor of characteristic.descriptors) {
          this.#assertUsable('add peripheral hierarchy');
          const { descriptorId } = await (
            mutation?.transport ?? this.#transport
          ).send('BluetoothEmulation.addDescriptor', {
            characteristicId,
            descriptorUuid: descriptor.uuid,
          });
          this.#assertUsable('add peripheral hierarchy');
          this.#assertUniqueId(descriptorId, this.#descriptors, descriptors);
          descriptors.push(
            Object.freeze({
              id: descriptorId,
              reference: Object.freeze({
                kind: 'descriptor',
                address: peripheral.address,
                serviceUuid: service.uuid,
                characteristicUuid: characteristic.uuid,
                descriptorUuid: descriptor.uuid,
              }),
              definition: descriptor,
            }),
          );
        }
      }
    }

    return { services, characteristics, descriptors };
  }

  #commit(
    peripheral: NormalizedPeripheral,
    staged: Readonly<{
      services: readonly RegisteredCdpService[];
      characteristics: readonly RegisteredCdpCharacteristic[];
      descriptors: readonly RegisteredCdpDescriptor[];
    }>,
    mutation?: EntityMutation,
  ): void {
    mutation?.assertCommittable();
    mutation?.markModelEffect();
    this.#assertUsable('add peripheral hierarchy');
    this.#peripherals.set(peripheral.address, peripheral);
    for (const entity of staged.services) this.#services.set(entity.id, entity);
    for (const entity of staged.characteristics) {
      this.#characteristics.set(entity.id, entity);
      this.#characteristicsByReference.set(
        characteristicReferenceKey(entity.reference),
        entity,
      );
    }
    for (const entity of staged.descriptors) {
      this.#descriptors.set(entity.id, entity);
      this.#descriptorsByReference.set(
        descriptorReferenceKey(entity.reference),
        entity,
      );
    }
  }

  #assertUniqueId<T extends Readonly<{ id: string }>>(
    id: string,
    committed: ReadonlyMap<string, T>,
    staged: readonly T[],
  ): void {
    if (committed.has(id) || staged.some((candidate) => candidate.id === id)) {
      throw new TypeError(`Chromium returned a duplicate entity id: ${id}.`);
    }
  }

  #assertPrimaryServices(peripheral: NormalizedPeripheral): void {
    const unsupported = peripheral.services.find(
      (service) => !service.isPrimary,
    );
    if (unsupported === undefined) return;
    throw new BluetoothCapabilityUnsupportedError(
      'The Chromium CDP backend cannot represent a secondary GATT service.',
      {
        context: {
          address: peripheral.address,
          serviceUuid: unsupported.uuid,
          capability: 'secondaryServices',
        },
      },
    );
  }

  #assertUsable(operation: string): void {
    if (!this.#requiresReset) return;
    throw new BluetoothBackendStoppedError(
      'Cannot mutate CDP entities until BluetoothEmulation has been reset.',
      { context: { operation } },
    );
  }

  #requirePeripheral(address: BluetoothAddress): NormalizedPeripheral {
    const peripheral = this.#peripherals.get(address);
    if (peripheral !== undefined) return peripheral;
    throw new TypeError(`Bluetooth peripheral ${address} is not registered.`);
  }

  async #ensureIdentity(
    peripheral: NormalizedPeripheral,
    operation: string,
    mutation?: EntityMutation,
  ): Promise<CdpIdentityRegistration> {
    const existing = this.#identityRegistrations.get(peripheral.address);
    if (existing !== undefined) {
      await existing;
      mutation?.assertCommittable();
      this.#assertUsable(operation);
      return 'existing';
    }

    mutation?.assertCommittable();
    const registration = (mutation?.transport ?? this.#transport)
      .send('BluetoothEmulation.simulatePreconnectedPeripheral', {
        address: peripheral.address,
        name: peripheral.name,
        manufacturerData: toCdpManufacturerData(peripheral.manufacturerData),
        knownServiceUuids: [...peripheral.knownServiceUuids],
      })
      .then(() => undefined);
    this.#identityRegistrations.set(peripheral.address, registration);
    try {
      await registration;
      mutation?.assertCommittable();
      this.#assertUsable(operation);
      return 'created';
    } catch (cause) {
      this.#invalidate();
      throw cause;
    }
  }

  #invalidate(): void {
    this.#clearEntities();
    this.#requiresReset = true;
  }

  #clearEntities(): void {
    this.#addresses.clear();
    this.#peripherals.clear();
    this.#services.clear();
    this.#characteristics.clear();
    this.#characteristicsByReference.clear();
    this.#descriptors.clear();
    this.#descriptorsByReference.clear();
    this.#identityRegistrations.clear();
    this.#disconnectRehydrations.clear();
  }

  #removeHierarchy(address: BluetoothAddress): void {
    for (const [id, service] of this.#services) {
      if (service.reference.address === address) this.#services.delete(id);
    }
    for (const [id, characteristic] of this.#characteristics) {
      if (characteristic.reference.address !== address) continue;
      this.#characteristics.delete(id);
      this.#characteristicsByReference.delete(
        characteristicReferenceKey(characteristic.reference),
      );
    }
    for (const [id, descriptor] of this.#descriptors) {
      if (descriptor.reference.address !== address) continue;
      this.#descriptors.delete(id);
      this.#descriptorsByReference.delete(
        descriptorReferenceKey(descriptor.reference),
      );
    }
  }
}

function characteristicReferenceKey(
  reference: CharacteristicReference,
): string {
  return entityReferenceKey(
    reference.address,
    reference.serviceUuid,
    reference.characteristicUuid,
  );
}

function descriptorReferenceKey(reference: DescriptorReference): string {
  return entityReferenceKey(
    reference.address,
    reference.serviceUuid,
    reference.characteristicUuid,
    reference.descriptorUuid,
  );
}

function entityReferenceKey(...components: readonly string[]): string {
  return JSON.stringify(components);
}

function toCdpManufacturerData(
  entries: NormalizedPeripheral['manufacturerData'],
): { key: number; data: string }[] {
  return entries.map(({ companyId, data }) => ({
    key: companyId,
    data: encodeBase64(data),
  }));
}

function toCdpCharacteristicProperties(
  properties: readonly CharacteristicProperty[],
): CdpCharacteristicProperties {
  const result: CdpCharacteristicProperties = {};
  for (const property of properties) {
    result[cdpCharacteristicPropertyNames[property]] = true;
  }
  return result;
}
