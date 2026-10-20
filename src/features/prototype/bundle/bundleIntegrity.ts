import { createHash } from "node:crypto";
import * as zlib from "node:zlib";

export function bundleSha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
// Node/Bun normally supply crc32. Keep the ZIP polynomial fallback local for older runtimes.
const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) {
    value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  }
  return value >>> 0;
});
export function portableBundleCrc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255]!;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
export function bundleCrc32(bytes: Uint8Array): number {
  return typeof zlib.crc32 === "function" ? zlib.crc32(bytes) : portableBundleCrc32(bytes);
}
