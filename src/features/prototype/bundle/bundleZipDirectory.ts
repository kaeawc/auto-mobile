import { MAX_PROTOTYPE_ASSET_BYTES, MAX_PROTOTYPE_FONT_ASSET_BYTES } from "../prototypeAssets";
import {
  bundleAssert,
  BUNDLE_MAX_ENTRIES,
  BUNDLE_MAX_SPEC_BYTES,
  BUNDLE_MAX_MANIFEST_BYTES,
} from "./bundleContract";

export interface BundleZipEntry {
  name: string;
  method: number;
  flags: number;
  crc: number;
  compressed: number;
  expanded: number;
  offset: number;
  start: number;
  end: number;
}
export function bundleEntryCap(name: string): number {
  if (name === "spec.json") {
    return BUNDLE_MAX_SPEC_BYTES;
  }
  if (name === "bundle.json") {
    return BUNDLE_MAX_MANIFEST_BYTES;
  }
  return name.startsWith("fonts/") ? MAX_PROTOTYPE_FONT_ASSET_BYTES : MAX_PROTOTYPE_ASSET_BYTES;
}
const ENTRY_PATTERN =
  /^(?:bundle\.json|spec\.json|assets\/[0-9a-f]{64}\.(?:png|jpg|webp)|fonts\/[0-9a-f]{64}\.(?:ttf|otf))$/;
function safeName(raw: Buffer): string {
  const name = raw.toString("utf8");
  bundleAssert(
    !raw.some((byte) => byte === 0 || byte > 127) && !name.includes("\\"),
    "entry_name_forbidden",
    name,
  );
  bundleAssert(
    !name.startsWith("/") && !name.split("/").includes("..") && !name.includes("__MACOSX"),
    "entry_name_forbidden",
    name,
  );
  bundleAssert(!name.endsWith("/"), "entry_name_forbidden", name);
  return name;
}
function endOfDirectory(bytes: Buffer): number {
  const positions: number[] = [];
  for (let i = Math.max(0, bytes.length - 65557); i <= bytes.length - 4; i++) {
    if (bytes.readUInt32LE(i) === 0x06054b50) {
      positions.push(i);
    }
  }
  bundleAssert(positions.length === 1, "not_a_zip");
  const end = positions[0];
  bundleAssert(end + 22 <= bytes.length, "not_a_zip");
  bundleAssert(end < 20 || bytes.readUInt32LE(end - 20) !== 0x07064b50, "zip64_unsupported");
  const comment = bytes.readUInt16LE(end + 20);
  bundleAssert(end + 22 + comment === bytes.length, "trailing_bytes");
  bundleAssert(comment === 0, "extra_field_forbidden");
  bundleAssert(
    bytes.readUInt16LE(end + 4) === 0 && bytes.readUInt16LE(end + 6) === 0,
    "multi_disk",
  );
  bundleAssert(bytes.readUInt16LE(end + 8) === bytes.readUInt16LE(end + 10), "multi_disk");
  bundleAssert(
    bytes.readUInt16LE(end + 10) !== 0xffff &&
      bytes.readUInt32LE(end + 12) !== 0xffffffff &&
      bytes.readUInt32LE(end + 16) !== 0xffffffff,
    "zip64_unsupported",
  );
  bundleAssert(bytes.readUInt16LE(end + 10) <= BUNDLE_MAX_ENTRIES, "too_many_entries");
  return end;
}
function entryAttributes(bytes: Buffer, at: number, entry: BundleZipEntry): void {
  const path = entry.name;
  const type = (bytes.readUInt32LE(at + 38) >>> 16) & 0xf000;
  bundleAssert(type === 0 || type === 0x8000, "link_entry", path);
  bundleAssert((bytes.readUInt32LE(at + 38) & 0x10) === 0, "link_entry", path);
  bundleAssert((entry.flags & 0x41) === 0, "encrypted_entry", path);
  bundleAssert(entry.method === 0 || entry.method === 8, "method_unsupported", path);
  bundleAssert(bytes.readUInt16LE(at + 34) === 0, "multi_disk", path);
  bundleAssert(
    entry.compressed !== 0xffffffff &&
      entry.expanded !== 0xffffffff &&
      entry.offset !== 0xffffffff &&
      bytes.readUInt16LE(at + 6) < 45,
    "zip64_unsupported",
    path,
  );
  bundleAssert(
    bytes.readUInt16LE(at + 30) === 0 && bytes.readUInt16LE(at + 32) === 0,
    "extra_field_forbidden",
    path,
  );
  // No descriptors: all sizes and CRC must be present in both headers. Only UTF-8/deflate hints remain.
  bundleAssert((entry.flags & ~0x0806) === 0, "header_mismatch", path);
}
function centralEntry(
  bytes: Buffer,
  at: number,
  end: number,
): { entry: BundleZipEntry; next: number } {
  bundleAssert(at + 46 <= end && bytes.readUInt32LE(at) === 0x02014b50, "header_mismatch");
  const next =
    at +
    46 +
    bytes.readUInt16LE(at + 28) +
    bytes.readUInt16LE(at + 30) +
    bytes.readUInt16LE(at + 32);
  bundleAssert(next <= end, "header_mismatch");
  const name = safeName(bytes.subarray(at + 46, at + 46 + bytes.readUInt16LE(at + 28)));
  const entry: BundleZipEntry = {
    name,
    flags: bytes.readUInt16LE(at + 8),
    method: bytes.readUInt16LE(at + 10),
    crc: bytes.readUInt32LE(at + 16),
    compressed: bytes.readUInt32LE(at + 20),
    expanded: bytes.readUInt32LE(at + 24),
    offset: bytes.readUInt32LE(at + 42),
    start: 0,
    end: 0,
  };
  entryAttributes(bytes, at, entry);
  return { entry, next };
}
function localEntry(bytes: Buffer, entry: BundleZipEntry, directory: number): void {
  const at = entry.offset;
  const path = entry.name;
  bundleAssert(
    at + 30 <= directory && bytes.readUInt32LE(at) === 0x04034b50,
    "header_mismatch",
    path,
  );
  const nameEnd = at + 30 + bytes.readUInt16LE(at + 26);
  bundleAssert(nameEnd <= directory, "header_mismatch", path);
  bundleAssert(bytes.readUInt16LE(at + 28) === 0, "extra_field_forbidden", path);
  bundleAssert(
    bytes.subarray(at + 30, nameEnd).equals(Buffer.from(path, "ascii")),
    "header_mismatch",
    path,
  );
  const fields = [
    [6, entry.flags, 2],
    [8, entry.method, 2],
    [14, entry.crc, 4],
    [18, entry.compressed, 4],
    [22, entry.expanded, 4],
  ];
  for (const [offset, value, width] of fields) {
    bundleAssert(
      (width === 2 ? bytes.readUInt16LE(at + offset) : bytes.readUInt32LE(at + offset)) === value,
      "header_mismatch",
      path,
    );
  }
  bundleAssert(bytes.readUInt16LE(at + 4) < 45, "zip64_unsupported", path);
  entry.start = nameEnd;
  entry.end = nameEnd + entry.compressed;
  bundleAssert(entry.end <= directory, "header_mismatch", path);
}
export function readBundleZipDirectory(bytes: Buffer): BundleZipEntry[] {
  const end = endOfDirectory(bytes);
  const directory = bytes.readUInt32LE(end + 16);
  bundleAssert(directory + bytes.readUInt32LE(end + 12) === end, "header_mismatch");
  const entries: BundleZipEntry[] = [];
  const names = new Set<string>();
  let at = directory;
  for (let i = 0; i < bytes.readUInt16LE(end + 10); i++) {
    const parsed = centralEntry(bytes, at, end);
    const entry = parsed.entry;
    bundleAssert(!names.has(entry.name.toLowerCase()), "duplicate_entry", entry.name);
    names.add(entry.name.toLowerCase());
    entries.push(entry);
    at = parsed.next;
  }
  bundleAssert(at === end, "header_mismatch");
  for (const entry of entries) {
    bundleAssert(ENTRY_PATTERN.test(entry.name), "entry_not_allowed", entry.name);
    localEntry(bytes, entry, directory);
  }
  let previousEnd = 0;
  for (const entry of [...entries].sort((a, b) => a.offset - b.offset)) {
    // Reject overlapping headers/data as well as hidden local records and self-extracting preambles.
    bundleAssert(entry.offset === previousEnd, "header_mismatch", entry.name);
    previousEnd = entry.end;
  }
  bundleAssert(previousEnd === directory, "header_mismatch");
  return entries;
}
