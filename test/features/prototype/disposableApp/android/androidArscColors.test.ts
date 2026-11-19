import { expect, test } from "bun:test";
import { patchArscColors } from "../../../../../src/features/prototype/disposableApp/android/androidArscColors";

interface FixtureEntry {
  key: number;
  dataType: number;
  data: number;
  complex?: boolean;
}
interface FixtureOptions {
  utf8?: boolean;
  offset16?: boolean;
  sparse?: boolean;
  compact?: boolean;
  /** Leading NO_ENTRY slots before the real entries. */
  holes?: number;
}

function chunk(type: number, headerSize: number, header: Buffer, body: Buffer): Buffer {
  const out = Buffer.alloc(8);
  out.writeUInt16LE(type, 0);
  out.writeUInt16LE(headerSize, 2);
  out.writeUInt32LE(8 + header.length + body.length, 4);
  return Buffer.concat([out, header, body]);
}

function stringPool(strings: readonly string[], utf8: boolean): Buffer {
  const encoded = strings.map((value) => {
    if (utf8) {
      const bytes = Buffer.from(value, "utf8");
      return Buffer.concat([Buffer.from([value.length, bytes.length]), bytes, Buffer.from([0])]);
    }
    const length = Buffer.alloc(2);
    length.writeUInt16LE(value.length);
    return Buffer.concat([length, Buffer.from(value, "utf16le"), Buffer.alloc(2)]);
  });
  const offsets = Buffer.alloc(strings.length * 4);
  let cursor = 0;
  encoded.forEach((bytes, index) => {
    offsets.writeUInt32LE(cursor, index * 4);
    cursor += bytes.length;
  });
  let data = Buffer.concat(encoded);
  data = Buffer.concat([data, Buffer.alloc((4 - (data.length % 4)) % 4)]);
  const header = Buffer.alloc(20);
  header.writeUInt32LE(strings.length, 0);
  header.writeUInt32LE(0, 4);
  header.writeUInt32LE(utf8 ? 0x100 : 0, 8);
  header.writeUInt32LE(28 + offsets.length, 12);
  return chunk(0x0001, 28, header, Buffer.concat([offsets, data]));
}

function entryBytes(entry: FixtureEntry, compact: boolean): Buffer {
  if (compact) {
    const out = Buffer.alloc(8);
    out.writeUInt16LE(entry.key, 0);
    out.writeUInt16LE((entry.dataType << 8) | 0x08, 2);
    out.writeUInt32LE(entry.data, 4);
    return out;
  }
  const out = Buffer.alloc(16);
  out.writeUInt16LE(8, 0);
  out.writeUInt16LE(entry.complex ? 1 : 0, 2);
  out.writeUInt32LE(entry.key, 4);
  out.writeUInt16LE(8, 8);
  out.writeUInt8(entry.dataType, 11);
  out.writeUInt32LE(entry.data, 12);
  return out;
}

function typeChunk(
  typeId: number,
  entries: readonly FixtureEntry[],
  options: FixtureOptions,
): Buffer {
  const holes = options.holes ?? 0;
  const bodies = entries.map((entry) => entryBytes(entry, options.compact ?? false));
  const width = options.offset16 || options.sparse ? (options.sparse ? 4 : 2) : 4;
  const count = options.sparse ? entries.length : holes + entries.length;
  const offsets = Buffer.alloc(Math.ceil((count * width) / 4) * 4);
  let cursor = 0;
  for (let slot = 0; slot < count; slot += 1) {
    const index = options.sparse ? slot : slot - holes;
    const present = index >= 0;
    if (options.sparse) {
      offsets.writeUInt16LE(holes + slot, slot * 4);
      offsets.writeUInt16LE(cursor / 4, slot * 4 + 2);
    } else if (options.offset16) {
      offsets.writeUInt16LE(present ? cursor / 4 : 0xffff, slot * 2);
    } else {
      offsets.writeUInt32LE(present ? cursor : 0xffffffff, slot * 4);
    }
    if (present) {
      cursor += bodies[index]!.length;
    }
  }
  const config = Buffer.alloc(64);
  config.writeUInt32LE(64, 0);
  const headerSize = 8 + 12 + config.length;
  const header = Buffer.alloc(12);
  header.writeUInt8(typeId, 0);
  header.writeUInt8((options.sparse ? 1 : 0) | (options.offset16 ? 2 : 0), 1);
  header.writeUInt32LE(count, 4);
  header.writeUInt32LE(headerSize + offsets.length, 8);
  return chunk(
    0x0201,
    headerSize,
    Buffer.concat([header, config]),
    Buffer.concat([offsets, ...bodies]),
  );
}

function arsc(entries: readonly FixtureEntry[], options: FixtureOptions = {}): Buffer {
  const utf8 = options.utf8 ?? true;
  const types = stringPool(["attr", "color"], utf8);
  const keys = stringPool(["prototype_icon_foreground", "prototype_icon_background"], utf8);
  const headerSize = 8 + 4 + 256 + 5 * 4;
  const header = Buffer.alloc(headerSize - 8);
  header.writeUInt32LE(0x7f, 0);
  Buffer.from("dev.example", "utf16le").copy(header, 4);
  header.writeUInt32LE(headerSize, 260);
  header.writeUInt32LE(headerSize + types.length, 268);
  const attrs = typeChunk(1, [{ key: 1, dataType: 0x10, data: 7 }], options);
  const pkg = chunk(
    0x0200,
    headerSize,
    header,
    Buffer.concat([types, keys, attrs, typeChunk(2, entries, options)]),
  );
  const tableHeader = Buffer.alloc(4);
  tableHeader.writeUInt32LE(1, 0);
  return chunk(0x0002, 12, tableHeader, Buffer.concat([stringPool([], true), pkg]));
}

const template: FixtureEntry[] = [
  { key: 1, dataType: 0x1d, data: 0xfff5f5f5 },
  { key: 0, dataType: 0x1d, data: 0xff263238 },
];
const colors = new Map([["prototype_icon_background", 0x80123456]]);

function valueOf(buf: Buffer, data: number): number {
  return buf.indexOf(Buffer.from(new Uint32Array([data]).buffer));
}

test.each([
  ["utf8 pools with 32-bit offsets", { utf8: true }],
  ["utf16 pools", { utf8: false }],
  ["16-bit offsets with missing entries", { offset16: true, holes: 2 }],
  ["32-bit offsets with missing entries", { holes: 3 }],
  ["sparse entries", { sparse: true, holes: 1 }],
  ["compact entries", { compact: true }],
])("patches only the named colour with %s", (_name, options: FixtureOptions) => {
  const input = arsc(template, options);
  const output = patchArscColors(input, colors);
  expect(output.length).toBe(input.length);
  expect(valueOf(output, 0xfff5f5f5)).toBe(-1);
  expect(valueOf(output, 0x80123456)).toBeGreaterThan(0);
  expect(valueOf(output, 0xff263238)).toBe(valueOf(input, 0xff263238));
  expect(valueOf(input, 0xfff5f5f5)).toBeGreaterThan(0);
  const changed = [...input].filter((byte, index) => byte !== output[index]).length;
  // The four data bytes plus the RGB8 -> ARGB8 type byte, nothing else.
  expect(changed).toBeLessThanOrEqual(5);
});

test("an empty colour map returns the bytes unchanged", () => {
  const input = arsc(template);
  expect(patchArscColors(input, new Map()).equals(input)).toBe(true);
});

test("refuses a missing, complex or non-colour entry and a non-table input", () => {
  expect(() => patchArscColors(arsc([template[1]!]), colors)).toThrow("no colour value");
  expect(() => patchArscColors(arsc([{ ...template[0]!, complex: true }]), colors)).toThrow(
    "not a plain colour",
  );
  expect(() => patchArscColors(arsc([{ ...template[0]!, dataType: 0x01 }]), colors)).toThrow(
    "not a literal colour",
  );
  expect(() => patchArscColors(Buffer.from("not an arsc table"), colors)).toThrow("resources.arsc");
  expect(() => patchArscColors(arsc(template).subarray(0, 40), colors)).toThrow();
});
