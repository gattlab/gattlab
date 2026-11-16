import {
  createBluetoothTimeline,
  normalizeBluetoothAddress,
  validatePeripheralDefinition,
  type BluetoothAddress,
  type BluetoothAutomationBackendFactory,
  type BluetoothTimelineEvent,
  type CharacteristicWriteType,
  type CharacteristicOperationResponse,
  type NormalizedPeripheral,
  type PeripheralDefinition,
} from '../src/index.js';

const definition = {
  address: '00:11:22:33:44:55',
  name: 'Battery sensor',
  advertisement: { rssi: -45 },
  services: [
    {
      uuid: '180f',
      characteristics: [
        {
          uuid: '2a19',
          properties: ['read', 'write'],
          initialValue: [87],
        },
      ],
    },
  ],
} satisfies PeripheralDefinition;

const validation = validatePeripheralDefinition(definition);
if (!validation.success) throw new Error('Expected a valid type fixture.');

export const normalizedPeripheral: NormalizedPeripheral = validation.value;
export const normalizedAddress: BluetoothAddress = normalizeBluetoothAddress(
  definition.address,
);
export const deprecatedDefaultWrite: CharacteristicWriteType =
  'default-deprecated';

const timeline = createBluetoothTimeline({
  limit: 10,
  clock: { now: () => 0 },
});
timeline.append({
  category: 'peripheral',
  type: 'registered',
  entity: { kind: 'peripheral', address: normalizedAddress },
  status: 'succeeded',
});
export const timelineSnapshot: readonly BluetoothTimelineEvent[] =
  timeline.snapshot();

export async function exerciseBackendContract(
  factory: BluetoothAutomationBackendFactory,
): Promise<void> {
  const backend = await factory.start({ centralState: 'powered-on' });
  await backend.addPeripheral(normalizedPeripheral);

  const response = {
    operationId: 'read-1',
    type: 'read',
    result: 'success',
    data: [87],
  } satisfies CharacteristicOperationResponse;
  await backend.respondToCharacteristicOperation(response);
  await backend.stop();
}

// @ts-expect-error Raw strings must pass through address normalization.
export const rejectedRawAddress: BluetoothAddress = '00:11:22:33:44:55';

// @ts-expect-error A successful characteristic read requires response data.
export const rejectedReadResponse: CharacteristicOperationResponse = {
  operationId: 'read-2',
  type: 'read',
  result: 'success',
};

// @ts-expect-error Timeline categories are a closed domain union.
timeline.append({ category: 'transport', type: 'internal-command' });
