import { ActionableError } from "../../../../models/ActionableError";

const RES_STRING_POOL_TYPE = 0x0001;
const RES_TABLE_TYPE = 0x0002;
const RES_TABLE_PACKAGE_TYPE = 0x0200;
const RES_TABLE_TYPE_TYPE = 0x0201;
const UTF8_FLAG = 0x100;
const FLAG_SPARSE = 0x01;
const FLAG_OFFSET16 = 0x02;
const ENTRY_FLAG_COMPLEX = 0x0001;
const ENTRY_FLAG_COMPACT = 0x0008;
const TYPE_INT_COLOR_ARGB8 = 0x1c;
const TYPE_FIRST_COLOR = 0x1c;
const TYPE_LAST_COLOR = 0x1f;
const PACKAGE_NAME_BYTES = 256;

/**
 * Returns a copy of a compiled `resources.arsc` with each named `color` resource set to an ARGB
 * value in every configuration. Throws when a name is missing or is not a plain colour value, so
 * a template change can never silently drop a stamped colour.
 */
export function patchArscColors(arsc: Uint8Array, colors: ReadonlyMap<string, number>): Buffer {
  const out = Buffer.from(arsc);
  if (colors.size === 0) {
    return out;
  }
  const table = chunkAt(out, 0);
  if (table.type !== RES_TABLE_TYPE || table.size > out.length) {
    throw new ActionableError("Template resources.arsc is not a resource table.");
  }
  const patch: Patch = { buf: out, colors, patched: new Set<string>() };
  for (let offset = table.headerSize; offset < table.size;) {
    const chunk = chunkAt(out, offset);
    if (chunk.type === RES_TABLE_PACKAGE_TYPE) {
      patchPackage(patch, offset, chunk);
    }
    offset += chunk.size;
  }
  const missing = [...colors.keys()].filter((name) => !patch.patched.has(name));
  if (missing.length > 0) {
    throw new ActionableError(
      `Template resources.arsc has no colour value for ${missing.join(", ")}. Repackage the template.`,
    );
  }
  return out;
}

interface Patch {
  buf: Buffer;
  colors: ReadonlyMap<string, number>;
  patched: Set<string>;
}

interface Chunk {
  type: number;
  headerSize: number;
  size: number;
}

function chunkAt(buf: Buffer, offset: number): Chunk {
  if (offset + 8 > buf.length) {
    throw new ActionableError("Template resources.arsc is truncated.");
  }
  const chunk = {
    type: buf.readUInt16LE(offset),
    headerSize: buf.readUInt16LE(offset + 2),
    size: buf.readUInt32LE(offset + 4),
  };
  if (chunk.size < 8 || chunk.headerSize < 8 || offset + chunk.size > buf.length) {
    throw new ActionableError("Template resources.arsc has a malformed chunk.");
  }
  return chunk;
}

function patchPackage(patch: Patch, start: number, pkg: Chunk): void {
  const { buf } = patch;
  const fields = start + 8 + 4 + PACKAGE_NAME_BYTES;
  const typeStrings = readStringPool(buf, start + buf.readUInt32LE(fields));
  const keyStrings = readStringPool(buf, start + buf.readUInt32LE(fields + 8));
  const colorTypeId = typeStrings.indexOf("color") + 1;
  if (colorTypeId === 0) {
    return;
  }
  for (let offset = start + pkg.headerSize; offset < start + pkg.size;) {
    const chunk = chunkAt(buf, offset);
    if (chunk.type === RES_TABLE_TYPE_TYPE && buf.readUInt8(offset + 8) === colorTypeId) {
      patchType(patch, offset, chunk, keyStrings);
    }
    offset += chunk.size;
  }
}

function patchType(patch: Patch, start: number, type: Chunk, keys: readonly string[]): void {
  const { buf } = patch;
  const flags = buf.readUInt8(start + 9);
  const entryCount = buf.readUInt32LE(start + 12);
  const entriesStart = start + buf.readUInt32LE(start + 16);
  const offsets = start + type.headerSize;
  for (let index = 0; index < entryCount; index += 1) {
    const relative = entryOffset(buf, offsets, index, flags);
    if (relative === undefined) {
      continue;
    }
    const entry = entriesStart + relative;
    if (entry + 8 > start + type.size) {
      throw new ActionableError("Template resources.arsc has an entry outside its type chunk.");
    }
    patchEntry(patch, entry, keys);
  }
}

function patchEntry(patch: Patch, entry: number, keys: readonly string[]): void {
  const { buf } = patch;
  const entryFlags = buf.readUInt16LE(entry + 2);
  const compact = (entryFlags & ENTRY_FLAG_COMPACT) !== 0;
  const name = keys[compact ? buf.readUInt16LE(entry) : buf.readUInt32LE(entry + 4)];
  const argb = name === undefined ? undefined : patch.colors.get(name);
  if (name === undefined || argb === undefined) {
    return;
  }
  if ((entryFlags & ENTRY_FLAG_COMPLEX) !== 0) {
    throw new ActionableError(`Template colour ${name} is not a plain colour value.`);
  }
  if (compact) {
    // Compact entries keep the value type in the high byte of flags and the data inline.
    assertColorType(entryFlags >> 8, name);
    buf.writeUInt16LE((TYPE_INT_COLOR_ARGB8 << 8) | (entryFlags & 0xff), entry + 2);
    buf.writeUInt32LE(argb >>> 0, entry + 4);
  } else {
    const value = entry + buf.readUInt16LE(entry);
    assertColorType(buf.readUInt8(value + 3), name);
    buf.writeUInt8(TYPE_INT_COLOR_ARGB8, value + 3);
    buf.writeUInt32LE(argb >>> 0, value + 4);
  }
  patch.patched.add(name);
}

function entryOffset(
  buf: Buffer,
  offsets: number,
  index: number,
  flags: number,
): number | undefined {
  if ((flags & FLAG_SPARSE) !== 0) {
    // Sparse tables list only present entries as (u16 index, u16 offset / 4) pairs.
    return buf.readUInt16LE(offsets + index * 4 + 2) * 4;
  }
  if ((flags & FLAG_OFFSET16) !== 0) {
    const value = buf.readUInt16LE(offsets + index * 2);
    return value === 0xffff ? undefined : value * 4;
  }
  const value = buf.readUInt32LE(offsets + index * 4);
  return value === 0xffffffff ? undefined : value;
}

function assertColorType(dataType: number, name: string): void {
  if (dataType < TYPE_FIRST_COLOR || dataType > TYPE_LAST_COLOR) {
    throw new ActionableError(`Template colour ${name} is not a literal colour value.`);
  }
}

function readStringPool(buf: Buffer, start: number): string[] {
  const pool = chunkAt(buf, start);
  if (pool.type !== RES_STRING_POOL_TYPE) {
    throw new ActionableError("Template resources.arsc has a malformed string pool.");
  }
  const count = buf.readUInt32LE(start + 8);
  const utf8 = (buf.readUInt32LE(start + 16) & UTF8_FLAG) !== 0;
  const stringsStart = start + buf.readUInt32LE(start + 20);
  return Array.from({ length: count }, (_, index) => {
    const at = stringsStart + buf.readUInt32LE(start + pool.headerSize + index * 4);
    return utf8 ? readUtf8(buf, at) : readUtf16(buf, at);
  });
}

function readUtf8(buf: Buffer, at: number): string {
  // UTF-8 pool strings carry a UTF-16 length then a byte length, each 1 or 2 bytes.
  const skip = (buf.readUInt8(at) & 0x80) !== 0 ? 2 : 1;
  const first = buf.readUInt8(at + skip);
  const long = (first & 0x80) !== 0;
  const length = long ? ((first & 0x7f) << 8) | buf.readUInt8(at + skip + 1) : first;
  const begin = at + skip + (long ? 2 : 1);
  return buf.toString("utf8", begin, begin + length);
}

function readUtf16(buf: Buffer, at: number): string {
  const first = buf.readUInt16LE(at);
  const long = (first & 0x8000) !== 0;
  const length = long ? ((first & 0x7fff) << 16) | buf.readUInt16LE(at + 2) : first;
  const begin = at + (long ? 4 : 2);
  return buf.toString("utf16le", begin, begin + length * 2);
}
