#!/usr/bin/env bun
/**
 * Regenerates the prototype embedding samples (#13732) from the `automobile:prototype/native`
 * resource itself, so the committed samples are exactly what an agent would receive.
 *
 *   bun scripts/prototype/generateEmbeddingSamples.ts          # write the samples
 *   bun scripts/prototype/generateEmbeddingSamples.ts --check  # fail if they drifted
 *
 * Android files land in samples/prototype-embedding/android (the consumer check in
 * scripts/android/validate-prototype-compose-consumer.sh compiles them against the published
 * renderer). The SwiftUI host lands in the EmbedConsumer fixture that the iOS library build
 * compiles (scripts/ios/prototype-library-build.sh).
 *
 * The `automobile:prototype/eject` scaffold of a second fixture spec (#16499) is written next to
 * them, so the same two builds compile the hand-owned Compose and SwiftUI output too.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import {
  readNativePrototype,
  type NativePrototypeSources,
} from "../../src/features/prototype/nativePrototype";
import { readPrototypeEject } from "../../src/features/prototype/prototypeEject";
import {
  prototypeSpecSchema,
  type PrototypeSpec,
} from "../../src/features/prototype/prototypeSpec";
import { walkPrototypeNodes } from "../../src/features/prototype/prototypeNodeChildren";
import type { MirroredSavedPrototype } from "../../src/features/prototype/savedPrototypeMirror";

const REPO = path.join(import.meta.dir, "../..");
export const SAMPLE_SPEC_PATH = "test/fixtures/prototype-embedding/sample.json";
export const EJECT_SPEC_PATH = "test/fixtures/prototype-embedding/eject-sample.json";
export const ANDROID_SAMPLE_ROOT = "samples/prototype-embedding/android";
export const IOS_SAMPLE_ROOT = "samples/prototype-embedding/ios";
export const IOS_FIXTURE_SOURCES =
  "ios/prototype-agent/Fixtures/EmbedConsumer/Sources/EmbedConsumer";
/** The version written into samples; pinned so samples do not churn on every release. */
export const SAMPLE_LIBRARY_VERSION = "0.0.0-sample";
/**
 * Placeholder LAN host: 192.168.1.10 stands in for the machine serving the sample endpoint.
 * Replace it with that machine's LAN address (the iOS egress checks reject the Android
 * emulator alias 10.0.2.2).
 */
export const IOS_SAMPLE_REQUEST_URL = "http://192.168.1.10:8080/greeting";

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ ((crc & 1) === 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (const byte of bytes) {
    a = (a + byte) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/**
 * A zlib stream of stored (BTYPE=00, uncompressed) deflate blocks, so the PNG bytes are the same
 * on every runtime and platform; a compressor's output is not guaranteed to be.
 */
function storedZlib(data: Uint8Array): Uint8Array {
  const maxBlock = 0xffff;
  const blockCount = Math.max(1, Math.ceil(data.length / maxBlock));
  const out = Buffer.alloc(2 + blockCount * 5 + data.length + 4);
  // CMF 0x78 (deflate, 32K window), FLG 0x01 (no dictionary, fastest; 0x7801 % 31 === 0).
  out[0] = 0x78;
  out[1] = 0x01;
  let offset = 2;
  for (let block = 0; block < blockCount; block++) {
    const start = block * maxBlock;
    const length = Math.min(maxBlock, data.length - start);
    out[offset] = block === blockCount - 1 ? 1 : 0;
    out.writeUInt16LE(length, offset + 1);
    out.writeUInt16LE(~length & 0xffff, offset + 3);
    Buffer.from(data.subarray(start, start + length)).copy(out, offset + 5);
    offset += 5 + length;
  }
  out.writeUInt32BE(adler32(data), offset);
  return out;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = Buffer.from(type, "ascii");
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  typeBytes.copy(chunk, 4);
  Buffer.from(data).copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + data.length)), 8 + data.length);
  return chunk;
}

export function heroPng(): Uint8Array {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(96, 0);
  header.writeUInt32BE(96, 4);
  header[8] = 8;
  header[9] = 6;
  const pixels = Buffer.alloc(96 * (1 + 96 * 4));
  for (let y = 0; y < 96; y++) {
    const row = y * (1 + 96 * 4);
    for (let x = 0; x < 96; x++) {
      const pixel = row + 1 + x * 4;
      pixels[pixel] = 0;
      pixels[pixel + 1] = 0;
      pixels[pixel + 2] = 255;
      pixels[pixel + 3] = 255;
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", storedZlib(pixels)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/** A copy of `spec` whose every node `onTap` request, at any nesting depth, targets `url`. */
export function withRequestUrl(spec: PrototypeSpec, url: string): PrototypeSpec {
  const copy = structuredClone(spec);
  walkPrototypeNodes(copy, (node) => {
    if (!Array.isArray(node.onTap)) {
      return;
    }
    for (const action of node.onTap) {
      if (typeof action === "object" && action !== null && action.type === "request") {
        action.url = url;
      }
    }
  });
  return copy;
}

/**
 * The sample is served as a saved prototype whose image has a known type but no bytes, so the
 * generated host references `hero.png` and the resource notes that the app must supply it. The
 * eject sample has no assets.
 */
function sampleSources(
  spec: unknown,
  assets: MirroredSavedPrototype["assets"] = [{ id: "hero", mimeType: "image/png" }],
): NativePrototypeSources {
  const parsed = prototypeSpecSchema.parse(spec);
  return {
    shownSpec: () => ({ kind: "unknown" }),
    devicesShowing: () => ["sample"],
    savedPrototypes: async () => [
      {
        id: parsed.id,
        spec: parsed,
        label: "Embedding sample",
        assets,
      },
    ],
    platformOf: async () => undefined,
    libraryVersion: () => SAMPLE_LIBRARY_VERSION,
  };
}

/** Repository-relative path to content for the Compose and SwiftUI eject scaffolds. */
export async function renderEjectSamples(spec: unknown): Promise<Map<string, string>> {
  const sources = sampleSources(spec, []);
  const id = prototypeSpecSchema.parse(spec).id;
  const files = new Map<string, string>();
  for (const [platform, root] of [
    ["android", ANDROID_SAMPLE_ROOT],
    ["ios", IOS_FIXTURE_SOURCES],
  ] as const) {
    const eject = await readPrototypeEject({ id, platform }, sources);
    for (const file of eject.files) {
      files.set(`${root}/${file.path}`, `${file.content.trimEnd()}\n`);
    }
  }
  return files;
}

/** Repository-relative path to file content for every generated native-host sample file. */
export async function renderEmbeddingSamples(
  spec: unknown,
): Promise<Map<string, string | Uint8Array>> {
  const sources = sampleSources(spec);
  const id = prototypeSpecSchema.parse(spec).id;
  const files = new Map<string, string | Uint8Array>();
  const android = await readNativePrototype({ id, platform: "android" }, sources);
  for (const file of android.files) {
    files.set(`${ANDROID_SAMPLE_ROOT}/${file.path}`, `${file.content.trimEnd()}\n`);
  }
  const androidHero = android.assets.find((asset) => asset.id === "hero");
  if (androidHero) {
    files.set(`${ANDROID_SAMPLE_ROOT}/${androidHero.path}`, heroPng());
  }
  const iosSources = sampleSources(
    withRequestUrl(prototypeSpecSchema.parse(spec), IOS_SAMPLE_REQUEST_URL),
  );
  const ios = await readNativePrototype({ id, platform: "ios" }, iosSources);
  for (const file of ios.files) {
    // The host compiles inside the fixture target; the spec ships with the iOS sample layout.
    const target = file.path.endsWith(".swift")
      ? `${IOS_FIXTURE_SOURCES}/${file.path}`
      : `${IOS_SAMPLE_ROOT}/${file.path}`;
    files.set(target, `${file.content.trimEnd()}\n`);
  }
  const iosHero = ios.assets.find((asset) => asset.id === "hero");
  if (iosHero) {
    files.set(`${IOS_SAMPLE_ROOT}/${iosHero.path}`, heroPng());
  }
  return files;
}

function readSpec(relative: string): unknown {
  return JSON.parse(readFileSync(path.join(REPO, relative), "utf8"));
}

async function renderAllSamples(): Promise<Map<string, string | Uint8Array>> {
  return new Map([
    ...(await renderEmbeddingSamples(readSpec(SAMPLE_SPEC_PATH))),
    ...(await renderEjectSamples(readSpec(EJECT_SPEC_PATH))),
  ]);
}

/** Paths whose committed content differs from a fresh render. */
export async function driftedEmbeddingSamples(): Promise<string[]> {
  const files = await renderAllSamples();
  return [...files]
    .filter(([relative, content]) => {
      const absolute = path.join(REPO, relative);
      if (!existsSync(absolute)) {
        return true;
      }
      const committed = readFileSync(absolute);
      return typeof content === "string"
        ? committed.toString("utf8") !== content
        : !committed.equals(Buffer.from(content));
    })
    .map(([relative]) => relative);
}

async function main(): Promise<void> {
  if (process.argv.includes("--check")) {
    const drifted = await driftedEmbeddingSamples();
    if (drifted.length > 0) {
      console.error(
        `Embedding samples are stale; run bun ${path.relative(REPO, import.meta.path)}:\n${drifted.join("\n")}`,
      );
      process.exit(1);
    }
    console.log("Embedding samples match the native resource output.");
    return;
  }
  for (const [relative, content] of await renderAllSamples()) {
    const absolute = path.join(REPO, relative);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
    console.log(`wrote ${relative}`);
  }
}

if (import.meta.main) {
  await main();
}
