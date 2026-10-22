import { crc32, deflateSync } from "node:zlib";
import { bundleSha256 } from "../../src/features/prototype/bundle/bundleManifest";
import { savedPrototypeAssetPath } from "../../src/features/prototype/savedPrototypeLayout";
import type { PrototypeAssetMimeType } from "../../src/features/prototype/prototypeAssets";
import type { BundleManifestAsset } from "../../src/features/prototype/bundle/bundleManifest";
import type { CorpusZipEntry } from "./bundleCorpusZip";

export const minimalSpec = Buffer.from(
  '{"id":"bundle-demo","window":{"placement":{"type":"fullscreen"}},"root":{"type":"text","text":"Hello"}}',
);
export interface CorpusExportAsset {
  id: string;
  mediaType: PrototypeAssetMimeType;
  base64: string;
}
export interface CorpusExportInputs {
  specBase64: string;
  assets: CorpusExportAsset[];
  fonts: CorpusExportAsset[];
}
export function pngChunk(tag: string, body: Buffer): Buffer {
  const name = Buffer.from(tag);
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(body.length);
  const suffix = Buffer.alloc(4);
  suffix.writeUInt32BE(crc32(Buffer.concat([name, body])));
  return Buffer.concat([prefix, name, body, suffix]);
}
/** Generated fixtures, never captured files. PNG is a 1x1 image; the other fixtures are tiny
 * signature/font-tag probes, not renderer conformance samples (the bundle layer checks magic).
 */
export function tinyAsset(type: PrototypeAssetMimeType, salt = 0): Buffer {
  if (type === "image/png") {
    const header = Buffer.alloc(13);
    header.writeUInt32BE(1, 0);
    header.writeUInt32BE(1, 4);
    header[8] = 8;
    header[9] = 6;
    return Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      pngChunk("IHDR", header),
      pngChunk("IDAT", deflateSync(Buffer.from([0, salt, 0, 0, 255]))),
      pngChunk("IEND", Buffer.alloc(0)),
    ]);
  }
  if (type === "image/jpeg") {
    return Buffer.from([
      255,
      216,
      255,
      224,
      0,
      16,
      74,
      70,
      73,
      70,
      0,
      1,
      1,
      0,
      0,
      1,
      0,
      1,
      0,
      salt,
      255,
      217,
    ]);
  }
  if (type === "image/webp") {
    const data = Buffer.alloc(20);
    data.write("RIFF");
    data.writeUInt32LE(12, 4);
    data.write("WEBPVP8L", 8);
    data[19] = salt;
    return data;
  }
  const data = Buffer.alloc(12);
  if (type === "font/otf") {
    data.write("OTTO");
  } else {
    data.writeUInt32BE(0x00010000);
  }
  data[11] = salt;
  return data;
}
export function assetRecord(
  id: string,
  mediaType: PrototypeAssetMimeType,
  bytes = tinyAsset(mediaType),
): { manifest: BundleManifestAsset; entry: CorpusZipEntry } {
  const sha256 = bundleSha256(bytes);
  const file = savedPrototypeAssetPath(mediaType, sha256);
  return { manifest: { id, file, sha256, mediaType }, entry: { name: file, bytes } };
}
export function fixtureEntries(
  spec: Uint8Array = minimalSpec,
  assets: ReturnType<typeof assetRecord>[] = [],
  fonts: ReturnType<typeof assetRecord>[] = [],
  requires: string[] = [],
): CorpusZipEntry[] {
  return [
    {
      name: "bundle.json",
      bytes: Buffer.from(
        JSON.stringify({
          bundleFormatVersion: 1,
          specSha256: bundleSha256(spec),
          assets: assets.map((a) => a.manifest),
          fonts: fonts.map((a) => a.manifest),
          requires,
        }),
      ),
    },
    { name: "spec.json", bytes: spec },
    ...assets.map((a) => a.entry).sort((a, b) => (a.name < b.name ? -1 : 1)),
    ...fonts.map((a) => a.entry).sort((a, b) => (a.name < b.name ? -1 : 1)),
  ];
}
export function referencedSpec(images: string[], fonts: string[] = []): Buffer {
  return Buffer.from(
    JSON.stringify({
      id: "bundle-demo",
      window: { placement: { type: "fullscreen" } },
      root: {
        type: "column",
        children: [
          ...images.map((asset) => ({ type: "image", asset })),
          ...fonts.map((asset) => ({
            type: "text",
            text: "Font",
            style: { fontFamily: { asset } },
          })),
        ],
      },
    }),
  );
}
/** ~1/96 deterministic entropy keeps compressed boundary probes under the 100x ratio cap. */
const boundaryCache = new Map<string, Buffer>();
/** Cache only deterministic compression inputs; every ZIP/header/manifest is still rebuilt. */
export function zeroBoundaryBytes(size: number, prefix: Uint8Array): Buffer {
  const key = `zero:${size}:${Buffer.from(prefix).toString("hex")}`;
  let bytes = boundaryCache.get(key);
  if (!bytes) {
    bytes = Buffer.alloc(size);
    bytes.set(prefix);
    boundaryCache.set(key, bytes);
  }
  return bytes;
}
export function boundaryBytes(size: number, prefix: Uint8Array): Buffer {
  const key = `entropy:${size}:${Buffer.from(prefix).toString("hex")}`;
  const cached = boundaryCache.get(key);
  if (cached) {
    return cached;
  }
  const bytes = Buffer.alloc(size);
  let seed = 0x12345678;
  for (let i = 0; i < Math.ceil(size / 96); i++) {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    bytes[i] = seed & 255;
  }
  bytes.set(prefix);
  boundaryCache.set(key, bytes);
  return bytes;
}
