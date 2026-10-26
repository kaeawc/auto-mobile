import { crc32, deflateRawSync } from "node:zlib";
import { bundleSha256 } from "../../src/features/prototype/bundle/bundleManifest";
import { type CorpusZipEntry, corpusZip } from "./bundleCorpusZip";
import { assetRecord, fixtureEntries, minimalSpec, referencedSpec } from "./bundleCorpusFixtures";

/**
 * Deterministic generators for the ProtoViewer bundle import fuzz corpus (#14159). Every output is
 * a pure function of the seed so the checked-in `fuzz-corpus.json` (the shared TS/Kotlin/Swift
 * differential corpus) regenerates byte-identically and the same generators drive the fast-check
 * property tests. The ZIP builder stays the independent `corpusZip` fixture writer.
 */
export interface FuzzRng {
  next(): number;
  int(bound: number): number;
  pick<T>(items: readonly T[]): T;
  chance(probability: number): boolean;
}

/** mulberry32: 32-bit state, reproducible across runtimes. */
export function fuzzRng(seed: number): FuzzRng {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (bound) => Math.floor(next() * bound),
    pick: (items) => items[Math.floor(next() * items.length)],
    chance: (probability) => next() < probability,
  };
}

const INTERESTING_U32 = [
  0, 1, 0xff, 0xffff, 0x7fffffff, 0x80000000, 0xfffffffe, 0xffffffff, 0x04034b50, 0x02014b50,
  0x06054b50,
];

/** Byte-level mutation of an arbitrary buffer: flips, overwrites, truncation, splices, header lies. */
export function mutateBytes(rng: FuzzRng, base: Uint8Array, rounds = 1 + rng.int(3)): Buffer {
  let data = Buffer.from(base);
  for (let i = 0; i < rounds && data.length > 0; i++) {
    const at = rng.int(data.length);
    switch (rng.int(8)) {
      case 0:
        data[at] ^= 1 << rng.int(8);
        break;
      case 1:
        data[at] = rng.int(256);
        break;
      case 2:
        data = data.subarray(0, at);
        break;
      case 3:
        data = Buffer.concat([
          data.subarray(0, at),
          Buffer.from(Array.from({ length: 1 + rng.int(16) }, () => rng.int(256))),
          data.subarray(at),
        ]);
        break;
      case 4:
        data = Buffer.concat([data.subarray(0, at), data.subarray(at + 1 + rng.int(16))]);
        break;
      case 5: {
        const length = 1 + rng.int(Math.min(64, data.length - at));
        data = Buffer.concat([data.subarray(0, at + length), data.subarray(at)]);
        break;
      }
      case 6:
        if (data.length - at >= 4) {
          data.writeUInt32LE(rng.pick(INTERESTING_U32), at);
        }
        break;
      default:
        if (data.length - at >= 2) {
          data.writeUInt16LE(rng.pick(INTERESTING_U32) & 0xffff, at);
        }
        break;
    }
  }
  return data;
}

const NASTY_NAMES = [
  "bundle.json",
  "spec.json",
  "../spec.json",
  "/spec.json",
  "./spec.json",
  "assets/../spec.json",
  "assets/",
  "assets\\a.png",
  "assets/\u0000.png",
  "assets/é.png",
  "__MACOSX/spec.json",
  "BUNDLE.JSON",
  "spec.json ",
  "spec.json.",
  `assets/${"a".repeat(64)}.png`,
  `assets/${"A".repeat(64)}.png`,
  `fonts/${"0".repeat(64)}.ttf`,
  `assets/${"0".repeat(63)}.png`,
  "a".repeat(5000),
  "",
  "C:/spec.json",
  "library.json",
];
const ATTRS = [0, 0, 0, 0x81a40000, 0xa1ff0000, 0xa0000000, 0x10000000, 0x40000000, 0xc0000000, 1];
const METHODS = [0, 0, 0, 8, 8, 1, 9, 12, 14, 99];

/** A ZIP whose entry table (names, methods, flags, attrs, header lies, duplicates) is random. */
export function structuralBundle(rng: FuzzRng): Buffer {
  const entries: CorpusZipEntry[] = fixtureEntries(minimalSpec).map((entry) => ({ ...entry }));
  const rounds = 1 + rng.int(3);
  for (let i = 0; i < rounds; i++) {
    const target = entries[rng.int(entries.length)];
    switch (rng.int(12)) {
      case 0:
        target.name = rng.pick(NASTY_NAMES);
        break;
      case 1:
        entries.push({ ...target });
        break;
      case 2:
        target.attrs = rng.pick(ATTRS);
        break;
      case 3:
        target.method = rng.pick(METHODS);
        break;
      case 4:
        target.flags = rng.pick([0, 1, 8, 64, 0x800, 0x808, 0xffff]);
        break;
      case 5:
        target.expanded = rng.pick(INTERESTING_U32);
        break;
      case 6:
        target.compressed = rng.pick(INTERESTING_U32);
        break;
      case 7:
        target.crc = rng.pick(INTERESTING_U32);
        break;
      case 8:
        target.extra = 1 + rng.int(8);
        break;
      case 9:
        target.localExtra = 1 + rng.int(8);
        break;
      case 10:
        target.localName = rng.pick(NASTY_NAMES);
        break;
      default:
        target.localOffset = rng.pick(INTERESTING_U32);
        break;
    }
  }
  return corpusZip(entries, {
    ...(rng.chance(0.1) ? { disk: 1 + rng.int(3) } : {}),
    ...(rng.chance(0.1) ? { count: Math.min(rng.int(70000), 0xffff) } : {}),
    ...(rng.chance(0.05) ? { zip64: true } : {}),
    ...(rng.chance(0.1) ? { trailing: Buffer.from("PK\u0005\u0006trailing") } : {}),
    ...(rng.chance(0.1) ? { comment: Buffer.from("comment") } : {}),
  });
}

const nested = (depth: number, open: string, close: string, leaf: string): string =>
  open.repeat(depth) + leaf + close.repeat(depth);

/** JSON text variants that stress duplicate-key, depth, escape, BOM and UTF-8 handling. */
export function hostileJsonText(rng: FuzzRng): Buffer {
  const bom = Buffer.from([0xef, 0xbb, 0xbf]);
  const candidates: Buffer[] = [
    Buffer.from('{"a":1,"a":2}'),
    Buffer.from('{"a":1,"\\u0061":2}'),
    Buffer.from('{"x":{"a":1,"a":1}}'),
    Buffer.from('[{"a":1,"a":2}]'),
    Buffer.from(nested(63, "[", "]", "0")),
    Buffer.from(nested(64, "[", "]", "0")),
    Buffer.from(nested(65, "[", "]", "0")),
    Buffer.from(nested(2000, "[", "]", "0")),
    Buffer.from(nested(70, '{"k":', "}", "0")),
    Buffer.concat([bom, Buffer.from("{}")]),
    Buffer.concat([bom, bom, Buffer.from("{}")]),
    Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xff, 0xfe, 0x22, 0x7d]),
    Buffer.from([0x7b, 0x22, 0xc0, 0xaf, 0x22, 0x3a, 0x31, 0x7d]),
    Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xed, 0xa0, 0x80, 0x22, 0x7d]),
    Buffer.from('{"a":"\\ud800"}'),
    Buffer.from('{"a":"\\ud800\\udc00","\\ud800\\udc00":1}'),
    Buffer.from('{"__proto__":1,"__proto__":2}'),
    Buffer.from('{"a":1e999}'),
    Buffer.from('{"a":-0,"b":1E2,"c":0.1e-400}'),
    Buffer.from('{"a":01}'),
    Buffer.from("{'a':1}"),
    Buffer.from('{"a":1,}'),
    Buffer.from('{"a":NaN}'),
    Buffer.from("\u0000"),
    Buffer.alloc(0),
    Buffer.from('{"a":1} {"b":2}'),
    Buffer.from('{"a":"\u2028\u2029"}'),
    Buffer.from(' \t\r\n{"a":1}\n'),
    Buffer.from('{"a":"\\u0000"}'),
  ];
  return rng.pick(candidates);
}

/** A well-formed bundle whose bundle.json or spec.json bytes are replaced; CRC and SHA stay honest. */
export function jsonBundle(rng: FuzzRng): Buffer {
  const image = assetRecord("image", "image/png");
  const spec = referencedSpec(["image"]);
  const entries = fixtureEntries(spec, [image]);
  const index = rng.int(2);
  const hostile = rng.chance(0.5) ? hostileJsonText(rng) : mutateBytes(rng, entries[index].bytes);
  entries[index] = { ...entries[index], bytes: hostile };
  if (index === 1 && rng.chance(0.7)) {
    // Keep the manifest consistent with the hostile spec so the failure surfaces in spec parsing.
    const manifest = JSON.parse(Buffer.from(entries[0].bytes).toString("utf8")) as {
      specSha256: string;
    };
    manifest.specSha256 = bundleSha256(hostile);
    entries[0] = { ...entries[0], bytes: Buffer.from(JSON.stringify(manifest)) };
  }
  return corpusZip(entries.map((entry) => ({ ...entry, method: rng.pick([0, 8]) })));
}

/** DEFLATE bomb: `size` zero bytes as spec.json plus `count - 1` identical asset-named entries. */
export function bombBundle(size: number, count = 1): Buffer {
  const zeros = Buffer.alloc(size);
  const packed = deflateRawSync(zeros, { level: 9 });
  const entries: CorpusZipEntry[] = fixtureEntries().map((entry) => ({ ...entry }));
  entries[1] = {
    name: "spec.json",
    bytes: zeros,
    method: 8,
    encoded: packed,
    expanded: size,
    compressed: packed.length,
    crc: crc32(zeros),
  };
  for (let i = 1; i < count; i++) {
    entries.push({ ...entries[1], name: `assets/${String(i).padStart(64, "0")}.png` });
  }
  return corpusZip(entries);
}

export type FuzzFamily = "bytes" | "structural" | "json";
export function fuzzBundle(family: FuzzFamily, rng: FuzzRng, seeds: readonly Uint8Array[]): Buffer {
  if (family === "bytes") {
    return mutateBytes(rng, rng.pick(seeds));
  }
  return family === "structural" ? structuralBundle(rng) : jsonBundle(rng);
}
