export const foregroundPath = "res/E4.png";
export const monochromePath = "res/F5.png";

interface FixtureEntry {
  key: number;
  dataType: number;
  data: number;
  complex?: boolean;
}
export interface FixtureOptions {
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

export function arsc(
  entries: readonly FixtureEntry[] = template,
  options: FixtureOptions = {},
): Buffer {
  const utf8 = options.utf8 ?? true;
  const types = stringPool(["attr", "color", "drawable"], utf8);
  const keys = stringPool(
    [
      "other_color",
      "prototype_icon_background",
      "prototype_icon_foreground",
      "prototype_icon_monochrome",
    ],
    utf8,
  );
  const headerSize = 8 + 4 + 256 + 5 * 4;
  const header = Buffer.alloc(headerSize - 8);
  header.writeUInt32LE(0x7f, 0);
  Buffer.from("dev.example", "utf16le").copy(header, 4);
  header.writeUInt32LE(headerSize, 260);
  header.writeUInt32LE(headerSize + types.length, 268);
  const attrs = typeChunk(1, [{ key: 1, dataType: 0x10, data: 7 }], options);
  const drawables = typeChunk(
    3,
    [
      { key: 2, dataType: 0x03, data: 0 },
      { key: 3, dataType: 0x03, data: 1 },
    ],
    options,
  );
  const pkg = chunk(
    0x0200,
    headerSize,
    header,
    Buffer.concat([types, keys, attrs, typeChunk(2, entries, options), drawables]),
  );
  const tableHeader = Buffer.alloc(4);
  tableHeader.writeUInt32LE(1, 0);
  return chunk(
    0x0002,
    12,
    tableHeader,
    Buffer.concat([stringPool([foregroundPath, monochromePath], utf8), pkg]),
  );
}

export const template: FixtureEntry[] = [
  { key: 1, dataType: 0x1d, data: 0xfff5f5f5 },
  { key: 0, dataType: 0x1d, data: 0xff263238 },
];
