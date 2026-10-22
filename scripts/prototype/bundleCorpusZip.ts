import { crc32, deflateRawSync } from "node:zlib";

/** Low-level fixture builder, deliberately independent of the production exporter. */
export interface CorpusZipEntry {
  name: string;
  bytes: Uint8Array;
  method?: number;
  flags?: number;
  attrs?: number;
  disk?: number;
  expanded?: number;
  compressed?: number;
  crc?: number;
  extra?: number;
  localExtra?: number;
  version?: number;
  localName?: string;
  localMethod?: number;
  localExpanded?: number;
  localCompressed?: number;
  localCrc?: number;
  localOffset?: number;
  encoded?: Uint8Array;
}
export interface CorpusZipOptions {
  disk?: number;
  count?: number;
  zip64?: boolean;
  trailing?: Uint8Array;
  comment?: Uint8Array;
}
const compressedCache = new WeakMap<Uint8Array, Buffer>();
function compressed(entry: CorpusZipEntry): Buffer {
  if (entry.encoded) {
    return Buffer.from(entry.encoded);
  }
  if (entry.method !== 8) {
    return Buffer.from(entry.bytes);
  }
  let value = compressedCache.get(entry.bytes);
  if (!value) {
    value = deflateRawSync(entry.bytes, { level: 9 });
    compressedCache.set(entry.bytes, value);
  }
  return value;
}
export function corpusZip(entries: CorpusZipEntry[], options: CorpusZipOptions = {}): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const localName = Buffer.from(entry.localName ?? entry.name);
    const body = compressed(entry);
    const size = entry.expanded ?? entry.bytes.length;
    const packed = entry.compressed ?? body.length;
    const crc = entry.crc ?? crc32(entry.bytes);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(entry.version ?? 20, 4);
    local.writeUInt16LE(entry.flags ?? 0, 6);
    local.writeUInt16LE(entry.localMethod ?? entry.method ?? 0, 8);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(entry.localCrc ?? crc, 14);
    local.writeUInt32LE(entry.localCompressed ?? packed, 18);
    local.writeUInt32LE(entry.localExpanded ?? size, 22);
    local.writeUInt16LE(localName.length, 26);
    local.writeUInt16LE(entry.localExtra ?? 0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50);
    central.writeUInt16LE(entry.attrs ? 0x0314 : 20, 4);
    central.writeUInt16LE(entry.version ?? 20, 6);
    central.writeUInt16LE(entry.flags ?? 0, 8);
    central.writeUInt16LE(entry.method ?? 0, 10);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(entry.extra ?? 0, 30);
    central.writeUInt16LE(entry.disk ?? 0, 34);
    central.writeUInt32LE(entry.attrs ?? 0, 38);
    central.writeUInt32LE(entry.localOffset ?? offset, 42);
    const extra = Buffer.alloc(entry.localExtra ?? 0);
    locals.push(local, localName, extra, body);
    centrals.push(central, name, Buffer.alloc(entry.extra ?? 0));
    offset += local.length + localName.length + extra.length + body.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(options.disk ?? 0, 4);
  end.writeUInt16LE(options.count ?? entries.length, 8);
  end.writeUInt16LE(options.count ?? entries.length, 10);
  end.writeUInt32LE(options.zip64 ? 0xffffffff : directory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(options.comment?.length ?? 0, 20);
  return Buffer.concat([
    ...locals,
    directory,
    end,
    options.comment ?? Buffer.alloc(0),
    options.trailing ?? Buffer.alloc(0),
  ]);
}
