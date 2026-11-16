import { bytes, type ByteSource } from '@gattlab/core';

const base64Alphabet =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Encode a validated byte source without Node or browser globals. */
export function encodeBase64(source: ByteSource): string {
  const data = bytes(source);
  let result = '';
  for (let offset = 0; offset < data.length; offset += 3) {
    const first = data[offset] ?? 0;
    const second = data[offset + 1];
    const third = data[offset + 2];
    const group = (first << 16) | ((second ?? 0) << 8) | (third ?? 0);
    result += base64Alphabet[(group >> 18) & 0x3f] ?? '';
    result += base64Alphabet[(group >> 12) & 0x3f] ?? '';
    result +=
      second === undefined ? '=' : (base64Alphabet[(group >> 6) & 0x3f] ?? '');
    result += third === undefined ? '=' : (base64Alphabet[group & 0x3f] ?? '');
  }
  return result;
}
