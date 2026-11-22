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
const TYPE_STRING = 0x03;
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
  const patched = new Set<string>();
  visitResourceValues(out, "color", new Set(colors.keys()), ({ name, typeOffset, dataOffset }) => {
    assertColorType(out.readUInt8(typeOffset), name);
    out.writeUInt8(TYPE_INT_COLOR_ARGB8, typeOffset);
    out.writeUInt32LE(colors.get(name)! >>> 0, dataOffset);
    patched.add(name);
  });
  const missing = [...colors.keys()].filter((name) => !patched.has(name));
  if (missing.length > 0) {
    throw new ActionableError(
      `Template resources.arsc has no colour value for ${missing.join(", ")}. Repackage the template.`,
    );
  }
  return out;
}

/** Resolves every compiled file path for the named drawables, including shortened ZIP paths. */
export function resolveArscDrawablePaths(
  arsc: Buffer,
  names: readonly string[],
): ReadonlyMap<string, ReadonlySet<string>> {
  const table = chunkAt(arsc, 0);
  const strings = readStringPool(arsc, table.headerSize);
  const paths = new Map(names.map((name) => [name, new Set<string>()]));
  visitResourceValues(arsc, "drawable", new Set(names), ({ name, typeOffset, dataOffset }) => {
    const path = strings[arsc.readUInt32LE(dataOffset)];
    if (arsc.readUInt8(typeOffset) !== TYPE_STRING || !path?.startsWith("res/")) {
      throw new ActionableError(
        `Template drawable ${name} is not a compiled resource file. Repackage the template.`,
      );
    }
    paths.get(name)!.add(path);
  });
  const missing = names.filter((name) => paths.get(name)!.size === 0);
  if (missing.length > 0) {
    throw new ActionableError(
      `Template resources.arsc has no drawable file for ${missing.join(", ")}. Repackage the template.`,
    );
  }
  return paths;
}

interface ResourceValue {
  name: string;
  typeOffset: number;
  dataOffset: number;
}

interface ResourceVisitor {
  buf: Buffer;
  typeName: string;
  names: ReadonlySet<string>;
  visit(value: ResourceValue): void;
}

function visitResourceValues(
  buf: Buffer,
  typeName: string,
  names: ReadonlySet<string>,
  visit: ResourceVisitor["visit"],
): void {
  const table = chunkAt(buf, 0);
  if (table.type !== RES_TABLE_TYPE) {
    throw new ActionableError("Template resources.arsc is not a resource table.");
  }
  const visitor = { buf, typeName, names, visit };
  for (let offset = table.headerSize; offset < table.size;) {
    const chunk = chunkAt(buf, offset);
    if (chunk.type === RES_TABLE_PACKAGE_TYPE) {
      visitPackage(visitor, offset, chunk);
    }
    offset += chunk.size;
  }
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
  if (
    chunk.size < 8 ||
    chunk.headerSize < 8 ||
    chunk.headerSize > chunk.size ||
    offset + chunk.size > buf.length
  ) {
    throw new ActionableError("Template resources.arsc has a malformed chunk.");
  }
  return chunk;
}

function visitPackage(visitor: ResourceVisitor, start: number, pkg: Chunk): void {
  const { buf } = visitor;
  const fields = start + 8 + 4 + PACKAGE_NAME_BYTES;
  const typeStrings = readStringPool(buf, start + buf.readUInt32LE(fields));
  const keyStrings = readStringPool(buf, start + buf.readUInt32LE(fields + 8));
  const typeId = typeStrings.indexOf(visitor.typeName) + 1;
  if (typeId === 0) {
    return;
  }
  for (let offset = start + pkg.headerSize; offset < start + pkg.size;) {
    const chunk = chunkAt(buf, offset);
    if (chunk.type === RES_TABLE_TYPE_TYPE && buf.readUInt8(offset + 8) === typeId) {
      visitType(visitor, offset, chunk, keyStrings);
    }
    offset += chunk.size;
  }
}

function visitType(
  visitor: ResourceVisitor,
  start: number,
  type: Chunk,
  keys: readonly string[],
): void {
  const { buf } = visitor;
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
    visitEntry(visitor, entry, start + type.size, keys);
  }
}

function visitEntry(
  { buf, names, typeName, visit }: ResourceVisitor,
  entry: number,
  end: number,
  keys: readonly string[],
): void {
  const entryFlags = buf.readUInt16LE(entry + 2);
  const compact = (entryFlags & ENTRY_FLAG_COMPACT) !== 0;
  const name = keys[compact ? buf.readUInt16LE(entry) : buf.readUInt32LE(entry + 4)];
  if (name === undefined || !names.has(name)) {
    return;
  }
  if ((entryFlags & ENTRY_FLAG_COMPLEX) !== 0) {
    const role = typeName === "color" ? "colour" : typeName;
    throw new ActionableError(`Template ${role} ${name} is not a plain ${role} value.`);
  }
  if (compact) {
    // Compact entries keep the value type in the high byte of flags and the data inline.
    visit({ name, typeOffset: entry + 3, dataOffset: entry + 4 });
  } else {
    const value = entry + buf.readUInt16LE(entry);
    if (value + 8 > end) {
      throw new ActionableError("Template resources.arsc has a value outside its type chunk.");
    }
    visit({ name, typeOffset: value + 3, dataOffset: value + 4 });
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
