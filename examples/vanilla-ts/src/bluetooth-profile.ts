export const serviceUuid = '12345678-1234-5678-9abc-def123457000';
export const ioCharacteristicUuid = '12345678-1234-5678-9abc-def123457001';
export const firmwareCharacteristicUuid =
  '12345678-1234-5678-9abc-def123457003';
export const ioDescriptorUuid = '12345678-1234-5678-9abc-def123457004';
export const notificationCharacteristicUuid =
  '12345678-1234-5678-9abc-def123457002';
export const clientCharacteristicConfigurationUuid =
  '00002902-0000-1000-8000-00805f9b34fb';
export const writePayload: readonly number[] = Object.freeze([16, 32, 48]);
export const descriptorWritePayload: readonly number[] = Object.freeze([
  65, 0, 255,
]);
export const withoutResponsePayload: readonly number[] = Object.freeze([
  64, 80, 96,
]);
export const burstPayloads: readonly (readonly number[])[] = Object.freeze([
  Object.freeze([1, 161]),
  Object.freeze([2, 162]),
  Object.freeze([3, 163]),
  Object.freeze([4, 164]),
  Object.freeze([5, 165]),
]);
