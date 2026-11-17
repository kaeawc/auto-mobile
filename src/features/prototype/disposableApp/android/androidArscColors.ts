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
  const patched = new Set<string>();
  for (let offset = table.headerSize; offset < table.size;) {
    const chunk = chunkAt(out, offset);
    if (chunk.type === RES_TABLE_PACKAGE_TYPE) {
      patchPackage(out, offset, chunk, colors, patched);
    }
    offset += chunk.size;
  }
  const missing = [...colors.keys()].filter((name) => !patched.has(name));
  if (missing.length > 0) {
    throw new ActionableError(
      `Template resources.arsc has no colour value for ${missing.join(", ")}. Repackage the template.`,
    );
  }
  return out;
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

function patchPackage(
  buf: Buffer,
  start: number,
  pkg: Chunk,
  colors: ReadonlyMap<string, number>,
  patched: Set<string>,
): void {
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
      patchType(buf, offset, chunk, keyStrings, colors, patched);
    }
    offset += chunk.size;
  }
}

function patchType(
  buf: Buffer,
  start: number,
  type: Chunk,
  keys: readonly string[],
  colors: ReadonlyMap<string, number>,
  patched: Set<string>,
): void {
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
    const entryFlags = buf.readUInt16LE(entry + 2);
    const compact = (entryFlags & ENTRY_FLAG_COMPACT) !== 0;
    const name = keys[compact ? buf.readUInt16LE(entry) : buf.readUInt32LE(entry + 4)];
    const argb = name === undefined ? undefined : colors.get(name);
    if (name === undefined || argb === undefined) {
      continue;
    }
    if ((entryFlags & ENTRY_FLAG_COMPLEX) !== 0) {
      throw new ActionableError(`Template colour ${name} is not a plain colour value.`);
    }
    if (compact) {
      writeCompactColor(buf, entry, entryFlags, name, argb);
    } else {
      writeValueColor(buf, entry + buf.readUInt16LE(entry), name, argb);
    }
    patched.add(name);
  }
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

function writeValueColor(buf: Buffer, value: number, name: string, argb: number): void {
  assertColorType(buf.readUInt8(value + 3), name);
  buf.writeUInt8(TYPE_INT_COLOR_ARGB8, value + 3);
  buf.writeUInt32LE(argb >>> 0, value + 4);
}

function writeCompactColor(
  buf: Buffer,
  entry: number,
  flags: number,
  name: string,
  argb: number,
): void {
  assertColorType(flags >> 8, name);
  buf.writeUInt16LE((TYPE_INT_COLOR_ARGB8 << 8) | (flags & 0xff), entry + 2);
  buf.writeUInt32LE(argb >>> 0, entry + 4);
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
