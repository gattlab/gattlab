import {
  bytes,
  normalizeBluetoothAddress,
  normalizeBluetoothUuid,
  type BluetoothAddress,
  type BluetoothUuid,
  type ByteSource,
} from './primitives.js';

/**
 * Stable GattLab scripting names for the characteristic property bits defined
 * by Bluetooth Core Specification v6.3, Vol 3, Part G, Section 3.3.1.1. The
 * Web Bluetooth data model exposes the corresponding browser properties.
 *
 * @see https://www.bluetooth.com/specifications/specs/core-specification-6-3/
 * @see https://webbluetoothcg.github.io/web-bluetooth/#bluetoothcharacteristicproperties
 */
export const characteristicProperties = [
  'broadcast',
  'read',
  'write-without-response',
  'write',
  'notify',
  'indicate',
  'authenticated-signed-writes',
  'extended-properties',
] as const;

export type CharacteristicProperty = (typeof characteristicProperties)[number];

export interface ManufacturerDataEntry {
  companyId: number;
  data: ByteSource;
}

export interface AdvertisementDefinition {
  rssi: number;
  name?: string;
  serviceUuids?: readonly string[];
  appearance?: number;
  txPower?: number;
  manufacturerData?: readonly ManufacturerDataEntry[];
}

export type PeripheralOperationDefault = 'success';

export interface PeripheralOperationDefaults {
  connection?: PeripheralOperationDefault;
  discovery?: PeripheralOperationDefault;
}

export interface DescriptorDefinition {
  uuid: string;
  initialValue?: ByteSource;
}

export interface CharacteristicDefinition {
  uuid: string;
  properties: readonly CharacteristicProperty[];
  initialValue?: ByteSource;
  descriptors?: readonly DescriptorDefinition[];
}

export interface ServiceDefinition {
  uuid: string;
  isPrimary?: boolean;
  characteristics?: readonly CharacteristicDefinition[];
}

export interface PeripheralDefinition {
  address: string;
  name: string;
  manufacturerData?: readonly ManufacturerDataEntry[];
  knownServiceUuidsOverride?: readonly string[];
  advertisement?: AdvertisementDefinition;
  services?: readonly ServiceDefinition[];
  defaults?: PeripheralOperationDefaults;
}

export interface NormalizedManufacturerDataEntry {
  readonly companyId: number;
  readonly data: Uint8Array;
}

export interface NormalizedAdvertisement {
  readonly rssi: number;
  readonly name: string;
  readonly serviceUuids: readonly BluetoothUuid[];
  readonly appearance?: number;
  readonly txPower?: number;
  readonly manufacturerData: readonly NormalizedManufacturerDataEntry[];
}

export interface NormalizedPeripheralOperationDefaults {
  readonly connection: PeripheralOperationDefault;
  readonly discovery: PeripheralOperationDefault;
}

export interface NormalizedDescriptor {
  readonly uuid: BluetoothUuid;
  readonly initialValue?: Uint8Array;
}

export interface NormalizedCharacteristic {
  readonly uuid: BluetoothUuid;
  readonly properties: readonly CharacteristicProperty[];
  readonly initialValue?: Uint8Array;
  readonly descriptors: readonly NormalizedDescriptor[];
}

export interface NormalizedService {
  readonly uuid: BluetoothUuid;
  readonly isPrimary: boolean;
  readonly characteristics: readonly NormalizedCharacteristic[];
}

export interface NormalizedPeripheral {
  readonly address: BluetoothAddress;
  readonly name: string;
  readonly manufacturerData: readonly NormalizedManufacturerDataEntry[];
  readonly knownServiceUuids: readonly BluetoothUuid[];
  readonly advertisement?: NormalizedAdvertisement;
  readonly services: readonly NormalizedService[];
  readonly defaults: NormalizedPeripheralOperationDefaults;
}

export type ValidationIssueCode =
  | 'duplicate-property'
  | 'duplicate-company-id'
  | 'duplicate-uuid'
  | 'invalid-address'
  | 'invalid-byte-source'
  | 'invalid-default'
  | 'invalid-number'
  | 'invalid-property'
  | 'invalid-type'
  | 'invalid-uuid'
  | 'missing-cccd-descriptor';

export interface ValidationIssue {
  readonly path: readonly (string | number)[];
  readonly code: ValidationIssueCode;
  readonly message: string;
}

export type ValidationResult<T> =
  | Readonly<{ success: true; value: T }>
  | Readonly<{ success: false; issues: readonly ValidationIssue[] }>;

type Path = readonly (string | number)[];
type UnknownRecord = Record<string, unknown>;

const characteristicPropertySet = new Set<string>(characteristicProperties);

// Bluetooth Core Specification v6.3, Vol 3, Part G, Section 3.3.3.3;
// Assigned Numbers baseline dated 2026-08-05.
const clientCharacteristicConfigurationDescriptorUuid =
  normalizeBluetoothUuid('2902');

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function addIssue(
  issues: ValidationIssue[],
  path: Path,
  code: ValidationIssueCode,
  message: string,
): void {
  issues.push(Object.freeze({ path: Object.freeze([...path]), code, message }));
}

function normalizeUuidField(
  value: unknown,
  path: Path,
  issues: ValidationIssue[],
): BluetoothUuid | undefined {
  if (typeof value !== 'string') {
    addIssue(issues, path, 'invalid-type', 'Expected a UUID string.');
    return undefined;
  }

  try {
    return normalizeBluetoothUuid(value);
  } catch {
    addIssue(
      issues,
      path,
      'invalid-uuid',
      'Expected a supported Bluetooth UUID.',
    );
    return undefined;
  }
}

function normalizeAddressField(
  value: unknown,
  path: Path,
  issues: ValidationIssue[],
): BluetoothAddress | undefined {
  if (typeof value !== 'string') {
    addIssue(
      issues,
      path,
      'invalid-type',
      'Expected a Bluetooth address string.',
    );
    return undefined;
  }

  try {
    return normalizeBluetoothAddress(value);
  } catch {
    addIssue(
      issues,
      path,
      'invalid-address',
      'Expected six colon-separated hexadecimal octets.',
    );
    return undefined;
  }
}

function normalizeByteField(
  value: unknown,
  path: Path,
  issues: ValidationIssue[],
): Uint8Array | undefined {
  if (value === undefined) return undefined;

  try {
    return bytes(value as ByteSource);
  } catch {
    addIssue(
      issues,
      path,
      'invalid-byte-source',
      'Expected byte integers from 0 to 255.',
    );
    return undefined;
  }
}

function defineCopiedBytes(
  target: object,
  key: 'data' | 'initialValue',
  value: Uint8Array,
): void {
  const storedValue = new Uint8Array(value);
  Object.defineProperty(target, key, {
    enumerable: true,
    get: () => new Uint8Array(storedValue),
  });
}

function normalizeIntegerField(
  value: unknown,
  path: Path,
  issues: ValidationIssue[],
  options: Readonly<{ min?: number; max?: number }> = {},
): number | undefined {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    (options.min !== undefined && value < options.min) ||
    (options.max !== undefined && value > options.max)
  ) {
    const range =
      options.min === undefined || options.max === undefined
        ? 'a safe integer'
        : `an integer from ${String(options.min)} to ${String(options.max)}`;
    addIssue(issues, path, 'invalid-number', `Expected ${range}.`);
    return undefined;
  }

  return value;
}

function parseManufacturerDataEntry(
  value: unknown,
  path: Path,
  issues: ValidationIssue[],
): NormalizedManufacturerDataEntry | undefined {
  if (!isRecord(value)) {
    addIssue(
      issues,
      path,
      'invalid-type',
      'Expected a manufacturer data object.',
    );
    return undefined;
  }

  const companyId = normalizeIntegerField(
    value['companyId'],
    [...path, 'companyId'],
    issues,
    { min: 0, max: 0xffff },
  );
  const data = normalizeByteField(value['data'], [...path, 'data'], issues);
  if (companyId === undefined || data === undefined) return undefined;

  const entry: { companyId: number; data?: Uint8Array } = { companyId };
  defineCopiedBytes(entry, 'data', data);
  return Object.freeze(entry) as NormalizedManufacturerDataEntry;
}

function parseManufacturerDataArray(
  value: unknown,
  path: Path,
  issues: ValidationIssue[],
): readonly NormalizedManufacturerDataEntry[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value)) {
    addIssue(
      issues,
      path,
      'invalid-type',
      'Expected a manufacturer data array.',
    );
    return Object.freeze([]);
  }

  const seen = new Set<number>();
  const entries: NormalizedManufacturerDataEntry[] = [];
  value.forEach((entry, index) => {
    const parsed = parseManufacturerDataEntry(entry, [...path, index], issues);
    if (parsed === undefined) return;
    if (seen.has(parsed.companyId)) {
      addIssue(
        issues,
        [...path, index, 'companyId'],
        'duplicate-company-id',
        'Company identifiers must be unique within manufacturer data.',
      );
    }
    seen.add(parsed.companyId);
    entries.push(parsed);
  });
  return Object.freeze(entries);
}

function parseDescriptor(
  value: unknown,
  path: Path,
  issues: ValidationIssue[],
): NormalizedDescriptor | undefined {
  if (!isRecord(value)) {
    addIssue(issues, path, 'invalid-type', 'Expected a descriptor object.');
    return undefined;
  }

  const uuid = normalizeUuidField(value['uuid'], [...path, 'uuid'], issues);
  const initialValue = normalizeByteField(
    value['initialValue'],
    [...path, 'initialValue'],
    issues,
  );
  if (uuid === undefined) return undefined;

  const descriptor: { uuid: BluetoothUuid; initialValue?: Uint8Array } = {
    uuid,
  };
  if (initialValue !== undefined) {
    defineCopiedBytes(descriptor, 'initialValue', initialValue);
  }
  return Object.freeze(descriptor);
}

function parseDescriptorArray(
  value: unknown,
  path: Path,
  issues: ValidationIssue[],
): readonly NormalizedDescriptor[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value)) {
    addIssue(issues, path, 'invalid-type', 'Expected a descriptor array.');
    return Object.freeze([]);
  }

  const parsedDescriptors = value.map((descriptor, index) =>
    parseDescriptor(descriptor, [...path, index], issues),
  );
  const descriptors = parsedDescriptors.filter(
    (descriptor): descriptor is NormalizedDescriptor =>
      descriptor !== undefined,
  );
  reportDuplicateUuids(
    descriptors,
    parsedDescriptors.flatMap((descriptor, index) =>
      descriptor === undefined ? [] : [index],
    ),
    path,
    issues,
  );
  return Object.freeze(descriptors);
}

function parseProperties(
  value: unknown,
  path: Path,
  issues: ValidationIssue[],
): readonly CharacteristicProperty[] {
  if (!Array.isArray(value)) {
    addIssue(
      issues,
      path,
      'invalid-type',
      'Expected a characteristic property array.',
    );
    return Object.freeze([]);
  }

  const seen = new Set<string>();
  const properties: CharacteristicProperty[] = [];
  value.forEach((property: unknown, index) => {
    if (
      typeof property !== 'string' ||
      !characteristicPropertySet.has(property)
    ) {
      addIssue(
        issues,
        [...path, index],
        'invalid-property',
        'Expected a supported characteristic property.',
      );
      return;
    }

    if (seen.has(property)) {
      addIssue(
        issues,
        [...path, index],
        'duplicate-property',
        'Characteristic properties must be unique.',
      );
      return;
    }

    seen.add(property);
    properties.push(property as CharacteristicProperty);
  });
  return Object.freeze(properties);
}

function parseCharacteristic(
  value: unknown,
  path: Path,
  issues: ValidationIssue[],
): NormalizedCharacteristic | undefined {
  if (!isRecord(value)) {
    addIssue(issues, path, 'invalid-type', 'Expected a characteristic object.');
    return undefined;
  }

  const uuid = normalizeUuidField(value['uuid'], [...path, 'uuid'], issues);
  const properties = parseProperties(
    value['properties'],
    [...path, 'properties'],
    issues,
  );
  const initialValue = normalizeByteField(
    value['initialValue'],
    [...path, 'initialValue'],
    issues,
  );
  const descriptors = parseDescriptorArray(
    value['descriptors'],
    [...path, 'descriptors'],
    issues,
  );
  const requiresClientCharacteristicConfiguration = properties.some(
    (property) => property === 'notify' || property === 'indicate',
  );
  if (
    requiresClientCharacteristicConfiguration &&
    !descriptors.some(
      ({ uuid }) => uuid === clientCharacteristicConfigurationDescriptorUuid,
    )
  ) {
    addIssue(
      issues,
      [...path, 'descriptors'],
      'missing-cccd-descriptor',
      'Characteristics with notify or indicate must define the Client Characteristic Configuration descriptor (0x2902).',
    );
  }
  if (uuid === undefined) return undefined;

  const characteristic: {
    uuid: BluetoothUuid;
    properties: readonly CharacteristicProperty[];
    initialValue?: Uint8Array;
    descriptors: readonly NormalizedDescriptor[];
  } = {
    uuid,
    properties,
    descriptors,
  };
  if (initialValue !== undefined) {
    defineCopiedBytes(characteristic, 'initialValue', initialValue);
  }
  return Object.freeze(characteristic);
}

function parseCharacteristicArray(
  value: unknown,
  path: Path,
  issues: ValidationIssue[],
): readonly NormalizedCharacteristic[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value)) {
    addIssue(issues, path, 'invalid-type', 'Expected a characteristic array.');
    return Object.freeze([]);
  }

  const parsedCharacteristics = value.map((characteristic, index) =>
    parseCharacteristic(characteristic, [...path, index], issues),
  );
  const characteristics = parsedCharacteristics.filter(
    (characteristic): characteristic is NormalizedCharacteristic =>
      characteristic !== undefined,
  );
  reportDuplicateUuids(
    characteristics,
    parsedCharacteristics.flatMap((characteristic, index) =>
      characteristic === undefined ? [] : [index],
    ),
    path,
    issues,
  );
  return Object.freeze(characteristics);
}

function parseService(
  value: unknown,
  path: Path,
  issues: ValidationIssue[],
): NormalizedService | undefined {
  if (!isRecord(value)) {
    addIssue(issues, path, 'invalid-type', 'Expected a service object.');
    return undefined;
  }

  const uuid = normalizeUuidField(value['uuid'], [...path, 'uuid'], issues);
  const isPrimaryValue = value['isPrimary'];
  if (isPrimaryValue !== undefined && typeof isPrimaryValue !== 'boolean') {
    addIssue(
      issues,
      [...path, 'isPrimary'],
      'invalid-type',
      'Expected a boolean.',
    );
  }
  const characteristics = parseCharacteristicArray(
    value['characteristics'],
    [...path, 'characteristics'],
    issues,
  );
  if (uuid === undefined) return undefined;

  return Object.freeze({
    uuid,
    isPrimary: typeof isPrimaryValue === 'boolean' ? isPrimaryValue : true,
    characteristics,
  });
}

function parseServiceArray(
  value: unknown,
  path: Path,
  issues: ValidationIssue[],
): readonly NormalizedService[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value)) {
    addIssue(issues, path, 'invalid-type', 'Expected a service array.');
    return Object.freeze([]);
  }

  const parsedServices = value.map((service, index) =>
    parseService(service, [...path, index], issues),
  );
  const services = parsedServices.filter(
    (service): service is NormalizedService => service !== undefined,
  );
  reportDuplicateUuids(
    services,
    parsedServices.flatMap((service, index) =>
      service === undefined ? [] : [index],
    ),
    path,
    issues,
  );
  return Object.freeze(services);
}

function reportDuplicateUuids(
  values: readonly { readonly uuid: BluetoothUuid }[],
  sourceIndices: readonly number[],
  path: Path,
  issues: ValidationIssue[],
): void {
  const seen = new Set<BluetoothUuid>();
  values.forEach(({ uuid }, index) => {
    if (seen.has(uuid)) {
      addIssue(
        issues,
        [...path, sourceIndices[index] ?? index, 'uuid'],
        'duplicate-uuid',
        'Normalized UUIDs must be unique among siblings.',
      );
    }
    seen.add(uuid);
  });
}

function parseKnownServiceUuidOverride(
  value: unknown,
  path: Path,
  issues: ValidationIssue[],
): readonly BluetoothUuid[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    addIssue(issues, path, 'invalid-type', 'Expected a UUID array.');
    return Object.freeze([]);
  }

  const parsedUuids = value.map((uuid, index) =>
    normalizeUuidField(uuid, [...path, index], issues),
  );
  const uuids = parsedUuids.filter(
    (uuid): uuid is BluetoothUuid => uuid !== undefined,
  );
  const wrapped = uuids.map((uuid) => ({ uuid }));
  reportDuplicateUuids(
    wrapped,
    parsedUuids.flatMap((uuid, index) => (uuid === undefined ? [] : [index])),
    path,
    issues,
  );
  return Object.freeze(uuids);
}

function parseDefaults(
  value: unknown,
  path: Path,
  issues: ValidationIssue[],
): NormalizedPeripheralOperationDefaults {
  if (value !== undefined && !isRecord(value)) {
    addIssue(issues, path, 'invalid-type', 'Expected a defaults object.');
    return Object.freeze({ connection: 'success', discovery: 'success' });
  }

  const definition = value;
  const parseDefault = (
    key: keyof PeripheralOperationDefaults,
  ): PeripheralOperationDefault => {
    const candidate = definition?.[key];
    if (candidate !== undefined && candidate !== 'success') {
      addIssue(
        issues,
        [...path, key],
        'invalid-default',
        'The only supported operation default is success.',
      );
    }
    return 'success';
  };

  return Object.freeze({
    connection: parseDefault('connection'),
    discovery: parseDefault('discovery'),
  });
}

function parseAdvertisement(
  value: unknown,
  path: Path,
  issues: ValidationIssue[],
  fallback: Readonly<{
    name: string;
    serviceUuids: readonly BluetoothUuid[];
    manufacturerData: readonly NormalizedManufacturerDataEntry[];
  }>,
): NormalizedAdvertisement | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    addIssue(issues, path, 'invalid-type', 'Expected an advertisement object.');
    return undefined;
  }

  const rssi = normalizeIntegerField(value['rssi'], [...path, 'rssi'], issues);
  const nameValue = value['name'];
  if (nameValue !== undefined && typeof nameValue !== 'string') {
    addIssue(
      issues,
      [...path, 'name'],
      'invalid-type',
      'Expected an advertisement name string.',
    );
  }
  const parsedServiceUuids = parseKnownServiceUuidOverride(
    value['serviceUuids'],
    [...path, 'serviceUuids'],
    issues,
  );
  const appearance =
    value['appearance'] === undefined
      ? undefined
      : normalizeIntegerField(
          value['appearance'],
          [...path, 'appearance'],
          issues,
          { min: 0, max: 0xffff },
        );
  const txPower =
    value['txPower'] === undefined
      ? undefined
      : normalizeIntegerField(value['txPower'], [...path, 'txPower'], issues);
  const manufacturerData =
    value['manufacturerData'] === undefined
      ? fallback.manufacturerData
      : parseManufacturerDataArray(
          value['manufacturerData'],
          [...path, 'manufacturerData'],
          issues,
        );
  if (rssi === undefined) return undefined;

  return Object.freeze({
    rssi,
    name: typeof nameValue === 'string' ? nameValue : fallback.name,
    serviceUuids: parsedServiceUuids ?? fallback.serviceUuids,
    ...(appearance === undefined ? {} : { appearance }),
    ...(txPower === undefined ? {} : { txPower }),
    manufacturerData,
  });
}

/** Validates and normalizes an untrusted peripheral definition atomically. */
export function validatePeripheralDefinition(
  input: unknown,
): ValidationResult<NormalizedPeripheral> {
  const issues: ValidationIssue[] = [];
  if (!isRecord(input)) {
    addIssue(issues, [], 'invalid-type', 'Expected a peripheral object.');
    return Object.freeze({ success: false, issues: Object.freeze(issues) });
  }

  const address = normalizeAddressField(input['address'], ['address'], issues);
  const nameValue = input['name'];
  if (typeof nameValue !== 'string') {
    addIssue(
      issues,
      ['name'],
      'invalid-type',
      'Expected a peripheral name string.',
    );
  }
  const services = parseServiceArray(input['services'], ['services'], issues);
  const manufacturerData = parseManufacturerDataArray(
    input['manufacturerData'],
    ['manufacturerData'],
    issues,
  );
  const override = parseKnownServiceUuidOverride(
    input['knownServiceUuidsOverride'],
    ['knownServiceUuidsOverride'],
    issues,
  );
  const primaryServiceUuids = Object.freeze(
    services.filter(({ isPrimary }) => isPrimary).map(({ uuid }) => uuid),
  );
  const advertisement = parseAdvertisement(
    input['advertisement'],
    ['advertisement'],
    issues,
    {
      name: typeof nameValue === 'string' ? nameValue : '',
      serviceUuids: primaryServiceUuids,
      manufacturerData,
    },
  );
  const defaults = parseDefaults(input['defaults'], ['defaults'], issues);

  if (
    issues.length > 0 ||
    address === undefined ||
    typeof nameValue !== 'string'
  ) {
    return Object.freeze({ success: false, issues: Object.freeze(issues) });
  }

  const knownServiceUuids = override ?? primaryServiceUuids;
  return Object.freeze({
    success: true,
    value: Object.freeze({
      address,
      name: nameValue,
      manufacturerData,
      knownServiceUuids,
      ...(advertisement === undefined ? {} : { advertisement }),
      services,
      defaults,
    }),
  });
}
