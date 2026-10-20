import { bundleCrc32 } from "./bundleIntegrity";
import { bundleAssert } from "./bundleErrors";
import { BUNDLE_LIMITS, entryExpandedCap } from "./bundleLimits";

function preflightEntries(entries: ReadonlyMap<string, Uint8Array>): void {
  bundleAssert(entries.size <= BUNDLE_LIMITS.maxEntries, "too_many_entries");
  let expanded = 0;
  let compressed = 22;
  for (const [name, data] of entries) {
    expanded += data.byteLength;
    compressed += 30 + 46 + 2 * Buffer.byteLength(name, "ascii") + data.byteLength;
    bundleAssert(
      data.byteLength <= entryExpandedCap(name) && expanded <= BUNDLE_LIMITS.maxExpandedBytes,
      "expanded_too_large",
      name,
    );
  }
  bundleAssert(compressed <= BUNDLE_LIMITS.maxCompressedBytes, "compressed_too_large");
}
/** Canonical ZIP32: STORED, ASCII-sorted names, 1980-01-01 00:00, DOS regular
 * attributes, no extras/comments/descriptors. STORED avoids runtime-specific deflate bytes. */
export function writePrototypeZip(entries: ReadonlyMap<string, Uint8Array>): Uint8Array {
  preflightEntries(entries);
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, data] of [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const filename = Buffer.from(name, "ascii");
    const crc = bundleCrc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(33, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(filename.length, 26);
    local.push(header, filename, Buffer.from(data));
    const index = Buffer.alloc(46);
    index.writeUInt32LE(0x02014b50);
    index.writeUInt16LE(20, 4);
    index.writeUInt16LE(20, 6);
    index.writeUInt16LE(33, 14);
    index.writeUInt32LE(crc, 16);
    index.writeUInt32LE(data.length, 20);
    index.writeUInt32LE(data.length, 24);
    index.writeUInt16LE(filename.length, 28);
    index.writeUInt32LE(offset, 42);
    central.push(index, filename);
    offset += header.length + filename.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.size, 8);
  end.writeUInt16LE(entries.size, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  const length = offset + directory.length + end.length;
  bundleAssert(length <= BUNDLE_LIMITS.maxCompressedBytes, "compressed_too_large");
  return Buffer.concat([...local, directory, end], length);
}
