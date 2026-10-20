import { record } from "../prototypeTemplate";
import { inflateRawSync } from "node:zlib";
import { PrototypeBundleError, bundleAssert } from "./bundleErrors";
import { bundleCrc32 } from "./bundleIntegrity";
import { entryExpandedCap, type BundleLimits } from "./bundleLimits";
import { checkZipExtras, zipRange, type ZipEntry, type ZipDirectory } from "./zipDirectory";

function localPayload(
  bytes: Buffer,
  entry: ZipEntry,
  directoryOffset: number,
): { data: Buffer; end: number } {
  const at = entry.offset;
  zipRange(bytes, at, 30, entry.name);
  bundleAssert(bytes.readUInt32LE(at) === 0x04034b50, "zip_invalid", entry.name);
  const nameSize = bytes.readUInt16LE(at + 26);
  const extraSize = bytes.readUInt16LE(at + 28);
  const start = at + 30 + nameSize + extraSize;
  zipRange(bytes, at + 30, nameSize + extraSize, entry.name);
  bundleAssert(
    bytes.subarray(at + 30, at + 30 + nameSize).equals(Buffer.from(entry.name, "ascii")),
    "size_mismatch",
    entry.name,
  );
  const pairs = [
    [4, entry.version],
    [6, entry.flags],
    [8, entry.method],
  ];
  bundleAssert(
    pairs.every(([offset, value]) => bytes.readUInt16LE(at + offset!) === value) &&
      bytes.readUInt32LE(at + 14) === entry.crc &&
      bytes.readUInt32LE(at + 18) === entry.compressed &&
      bytes.readUInt32LE(at + 22) === entry.expanded,
    "size_mismatch",
    entry.name,
  );
  checkZipExtras(bytes, at + 30 + nameSize, extraSize, entry.name);
  const end = start + entry.compressed;
  bundleAssert(end <= directoryOffset, "size_mismatch", entry.name);
  return { data: bytes.subarray(start, end), end };
}
function isInflateResult(
  value: unknown,
): value is { buffer: Buffer; engine: { bytesWritten: number } } {
  const object = record(value);
  return (
    Buffer.isBuffer(object?.buffer) && typeof record(object?.engine)?.bytesWritten === "number"
  );
}
function inflate(
  data: Buffer,
  entry: ZipEntry,
  cap: number,
  capCode: "expanded_too_large" | "ratio_exceeded",
): Buffer {
  if (entry.method === 0) {
    bundleAssert(data.length <= cap, capCode, entry.name);
    return Buffer.from(data);
  }
  try {
    // zlib counts output while inflating and aborts before returning more than cap.
    // info.bytesWritten also rejects an otherwise-valid stream with appended bytes.
    const result: unknown = inflateRawSync(data, { maxOutputLength: Math.max(1, cap), info: true });
    bundleAssert(isInflateResult(result), "inflate_invalid", entry.name);
    bundleAssert(result.engine.bytesWritten === data.length, "extra_data", entry.name);
    bundleAssert(result.buffer.length <= cap, capCode, entry.name);
    return result.buffer;
  } catch (error) {
    if (error instanceof PrototypeBundleError) {
      throw error;
    }
    const overCap =
      error instanceof Error && "code" in error && error.code === "ERR_BUFFER_TOO_LARGE";
    throw new PrototypeBundleError(overCap ? capCode : "inflate_invalid", entry.name);
  }
}
export function inflateZipEntries(
  bytes: Buffer,
  directory: ZipDirectory,
  limits: BundleLimits,
): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  let cursor = 0;
  let total = 0;
  for (const entry of [...directory.entries].sort((a, b) => a.offset - b.offset)) {
    bundleAssert(entry.offset === cursor, "extra_data", entry.name);
    const payload = localPayload(bytes, entry, directory.offset);
    const expandedCap = Math.min(entryExpandedCap(entry.name), limits.maxExpandedBytes - total);
    const ratioCap = entry.compressed * limits.maxRatio;
    bundleAssert(entry.expanded <= expandedCap, "expanded_too_large", entry.name);
    bundleAssert(entry.expanded <= ratioCap, "ratio_exceeded", entry.name);
    const cap = Math.min(expandedCap, ratioCap);
    const inflated = inflate(
      payload.data,
      entry,
      cap,
      ratioCap < expandedCap ? "ratio_exceeded" : "expanded_too_large",
    );
    total += inflated.length;
    bundleAssert(inflated.length === entry.expanded, "size_mismatch", entry.name);
    bundleAssert(bundleCrc32(inflated) === entry.crc, "crc_mismatch", entry.name);
    out.set(entry.name, inflated);
    cursor = payload.end;
  }
  bundleAssert(cursor === directory.offset, "extra_data");
  return out;
}
