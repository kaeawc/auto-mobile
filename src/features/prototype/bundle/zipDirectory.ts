import { bundleAssert } from "./bundleErrors";
import type { BundleLimits } from "./bundleLimits";

export interface ZipEntry {
  name: string;
  method: number;
  flags: number;
  crc: number;
  compressed: number;
  expanded: number;
  offset: number;
  version: number;
}
export interface ZipDirectory {
  entries: ZipEntry[];
  offset: number;
}
export function zipRange(bytes: Buffer, start: number, length: number, entry?: string): void {
  bundleAssert(start >= 0 && length >= 0 && start + length <= bytes.length, "zip_invalid", entry);
}
function eocdOffset(bytes: Buffer): number {
  bundleAssert(bytes.length >= 22, "eocd_invalid");
  // EOCD comments are not part of this format. Scan only the ZIP32 EOCD search window
  // to distinguish a valid EOCD followed by garbage from a missing/truncated EOCD.
  const minimum = Math.max(0, bytes.length - 22 - 65535);
  for (let at = bytes.length - 22; at >= minimum; at--) {
    if (bytes.readUInt32LE(at) === 0x06054b50) {
      bundleAssert(at + 22 === bytes.length && bytes.readUInt16LE(at + 20) === 0, "extra_data");
      return at;
    }
  }
  bundleAssert(false, "eocd_invalid");
}
export function checkZipExtras(bytes: Buffer, start: number, length: number, entry: string): void {
  zipRange(bytes, start, length, entry);
  let at = start;
  while (at < start + length) {
    bundleAssert(at + 4 <= start + length, "zip_invalid", entry);
    const tag = bytes.readUInt16LE(at);
    const size = bytes.readUInt16LE(at + 2);
    bundleAssert(tag !== 1, "zip64_unsupported", entry);
    at += 4 + size;
    bundleAssert(at <= start + length, "zip_invalid", entry);
  }
}
function entryName(raw: Buffer): string {
  const name = raw.toString("utf8");
  bundleAssert(
    raw.every((byte) => byte <= 127),
    "non_ascii_name",
    name,
  );
  bundleAssert(
    !name.includes("..") &&
      !name.includes("\\") &&
      !name.startsWith("/") &&
      !/^[A-Za-z]:/.test(name) &&
      !name.includes("\0"),
    "path_traversal",
    name,
  );
  bundleAssert(
    /^(?:bundle\.json|spec\.json|assets\/[0-9a-f]{64}\.(?:png|jpg|webp)|fonts\/[0-9a-f]{64}\.(?:ttf|otf))$/.test(
      name,
    ),
    "entry_not_allowed",
    name,
  );
  return name;
}
function checkEntryAttributes(bytes: Buffer, at: number, entry: ZipEntry): void {
  const attrs = bytes.readUInt32LE(at + 38);
  const mode = attrs >>> 16;
  bundleAssert(mode === 0 || (mode & 0xf000) === 0x8000, "unix_mode_not_regular", entry.name);
  bundleAssert((attrs & 0x10) === 0, "entry_not_allowed", entry.name);
  bundleAssert(bytes.readUInt16LE(at + 34) === 0, "multi_disk", entry.name);
  bundleAssert(
    entry.version < 45 &&
      entry.offset !== 0xffffffff &&
      entry.compressed !== 0xffffffff &&
      entry.expanded !== 0xffffffff,
    "zip64_unsupported",
    entry.name,
  );
  bundleAssert((entry.flags & (1 | 0x40 | 0x2000)) === 0, "encrypted", entry.name);
  // Data descriptors, patched data and masked headers are deliberately unsupported.
  bundleAssert((entry.flags & ~0x800) === 0, "flags_unsupported", entry.name);
  bundleAssert(entry.method === 0 || entry.method === 8, "unsupported_method", entry.name);
}
function centralEntry(bytes: Buffer, at: number, end: number): { entry: ZipEntry; next: number } {
  bundleAssert(at >= 0 && at + 46 <= end, "zip_invalid");
  bundleAssert(bytes.readUInt32LE(at) === 0x02014b50, "zip_invalid");
  const nameSize = bytes.readUInt16LE(at + 28);
  const extraSize = bytes.readUInt16LE(at + 30);
  const commentSize = bytes.readUInt16LE(at + 32);
  bundleAssert(at + 46 + nameSize + extraSize + commentSize <= end, "zip_invalid");
  const name = entryName(bytes.subarray(at + 46, at + 46 + nameSize));
  const entry: ZipEntry = {
    name,
    version: bytes.readUInt16LE(at + 6),
    flags: bytes.readUInt16LE(at + 8),
    method: bytes.readUInt16LE(at + 10),
    crc: bytes.readUInt32LE(at + 16),
    compressed: bytes.readUInt32LE(at + 20),
    expanded: bytes.readUInt32LE(at + 24),
    offset: bytes.readUInt32LE(at + 42),
  };
  checkEntryAttributes(bytes, at, entry);
  checkZipExtras(bytes, at + 46 + nameSize, extraSize, name);
  bundleAssert(commentSize === 0, "extra_data", name);
  return { entry, next: at + 46 + nameSize + extraSize + commentSize };
}
export function readZipDirectory(bytes: Buffer, limits: BundleLimits): ZipDirectory {
  const end = eocdOffset(bytes);
  bundleAssert(
    bytes.readUInt16LE(end + 4) === 0 &&
      bytes.readUInt16LE(end + 6) === 0 &&
      bytes.readUInt16LE(end + 8) === bytes.readUInt16LE(end + 10),
    "multi_disk",
  );
  const count = bytes.readUInt16LE(end + 10);
  const size = bytes.readUInt32LE(end + 12);
  const offset = bytes.readUInt32LE(end + 16);
  bundleAssert(
    count !== 0xffff && size !== 0xffffffff && offset !== 0xffffffff,
    "zip64_unsupported",
  );
  bundleAssert(count <= limits.maxEntries, "too_many_entries");
  bundleAssert(offset + size === end, "eocd_invalid");
  const entries: ZipEntry[] = [];
  const names = new Set<string>();
  const offsets = new Set<number>();
  let at = offset;
  for (let index = 0; index < count; index++) {
    const parsed = centralEntry(bytes, at, end);
    bundleAssert(!names.has(parsed.entry.name), "duplicate_entry", parsed.entry.name);
    bundleAssert(!offsets.has(parsed.entry.offset), "zip_invalid", parsed.entry.name);
    names.add(parsed.entry.name);
    offsets.add(parsed.entry.offset);
    entries.push(parsed.entry);
    at = parsed.next;
  }
  bundleAssert(at === end, "extra_data");
  return { entries, offset };
}
