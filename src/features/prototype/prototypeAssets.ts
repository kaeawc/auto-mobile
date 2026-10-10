import contract from "../../../schemas/prototype-asset-contract.json";

/**
 * Prototype image and font asset transport limits (#9301). The same `schemas/prototype-asset-contract.json` is
 * packaged into the Android protocol module, so host and device cannot disagree. Specs reference an
 * asset only by an opaque id; bytes, MIME types and caps live here, never in a spec.
 */
export const {
  MAX_PROTOTYPE_ASSET_BYTES,
  MAX_PROTOTYPE_FONT_ASSET_BYTES,
  MAX_PROTOTYPE_ASSET_COUNT,
  MAX_PROTOTYPE_ASSET_TOTAL_BYTES,
  MAX_PROTOTYPE_ASSET_ID_LENGTH,
} = contract.limits;

/** A 4 MiB asset is about 5.6 MB of base64 over adb forward, so allow more than a plain request. */
export const DEFAULT_PROTOTYPE_ASSET_TIMEOUT_MS = 15000;

export type PrototypeImageAssetMimeType = "image/png" | "image/jpeg" | "image/webp";
/** Custom fonts referenced by `style.fontFamily: {asset}`; never decoded as images (#10443). */
export type PrototypeFontAssetMimeType = "font/ttf" | "font/otf";
export type PrototypeAssetMimeType = PrototypeImageAssetMimeType | PrototypeFontAssetMimeType;

export function isPrototypeFontMimeType(mimeType: string): mimeType is PrototypeFontAssetMimeType {
  return mimeType === "font/ttf" || mimeType === "font/otf";
}

/**
 * Font files are recognised by their sfnt version tag: 0x00010000 or 'true' (TrueType outlines,
 * `font/ttf`) and 'OTTO' (CFF outlines, `font/otf`). Returns null for anything else, including
 * TrueType collections ('ttcf'), WOFF and images.
 */
export function detectFontMimeType(bytes: Uint8Array): PrototypeFontAssetMimeType | null {
  if (bytes.length < 4) {
    return null;
  }
  const tag = (bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3];
  switch (tag) {
    case 0x00010000:
    case 0x74727565: // 'true'
      return "font/ttf";
    case 0x4f54544f: // 'OTTO'
      return "font/otf";
    default:
      return null;
  }
}

/** Largest accepted asset for a MIME type: fonts have a tighter cap than images. */
export function maxPrototypeAssetBytes(mimeType: string): number {
  return isPrototypeFontMimeType(mimeType)
    ? MAX_PROTOTYPE_FONT_ASSET_BYTES
    : MAX_PROTOTYPE_ASSET_BYTES;
}

export const PROTOTYPE_ASSET_MIME_TYPES: readonly PrototypeAssetMimeType[] = contract.mimeTypes.map(
  (type) => type as PrototypeAssetMimeType,
);

/** One asset to upload. `bytes` is the encoded image file, not decoded pixels. */
export interface PrototypeAssetUpload {
  id: string;
  mimeType: PrototypeAssetMimeType;
  bytes: Uint8Array;
}

/**
 * Host-side pre-flight for an upload; returns the first problem or null. The device enforces the
 * same per-asset rules plus the count and total caps, which only it can see.
 */
export function prototypeAssetUploadProblem(asset: PrototypeAssetUpload): string | null {
  return (
    prototypeAssetIdProblem(asset.id) ??
    (!PROTOTYPE_ASSET_MIME_TYPES.includes(asset.mimeType)
      ? `Unsupported prototype asset MIME type; use one of ${PROTOTYPE_ASSET_MIME_TYPES.join(", ")}.`
      : null) ??
    (asset.bytes.length === 0 ? "Prototype asset has no data." : null) ??
    (asset.bytes.length > maxPrototypeAssetBytes(asset.mimeType)
      ? `Prototype asset is ${asset.bytes.length} bytes; the limit is ${maxPrototypeAssetBytes(asset.mimeType)}.`
      : null) ??
    (isPrototypeFontMimeType(asset.mimeType) && detectFontMimeType(asset.bytes) === null
      ? "Prototype asset bytes are not a TrueType or OpenType font (checked the file signature)."
      : null)
  );
}

/** Asset ids are opaque nonempty strings with a transport length cap. */
export function prototypeAssetIdProblem(id: string): string | null {
  return id.length === 0 || id.length > MAX_PROTOTYPE_ASSET_ID_LENGTH
    ? `Prototype asset id must be 1 to ${MAX_PROTOTYPE_ASSET_ID_LENGTH} characters.`
    : null;
}
