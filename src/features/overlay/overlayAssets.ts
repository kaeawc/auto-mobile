import contract from "../../../schemas/overlay-asset-contract.json";

/**
 * Overlay image-asset transport limits (#9301). The same `schemas/overlay-asset-contract.json` is
 * packaged into the Android protocol module, so host and device cannot disagree. Specs reference an
 * asset only by an opaque id; bytes, MIME types and caps live here, never in a spec.
 */
export const {
  MAX_OVERLAY_ASSET_BYTES,
  MAX_OVERLAY_ASSET_COUNT,
  MAX_OVERLAY_ASSET_TOTAL_BYTES,
  MAX_OVERLAY_ASSET_ID_LENGTH,
} = contract.limits;

export type OverlayAssetMimeType = "image/png" | "image/jpeg" | "image/webp";

export const OVERLAY_ASSET_MIME_TYPES: readonly OverlayAssetMimeType[] = contract.mimeTypes.map(
  (type) => type as OverlayAssetMimeType,
);

/** One asset to upload. `bytes` is the encoded image file, not decoded pixels. */
export interface OverlayAssetUpload {
  id: string;
  mimeType: OverlayAssetMimeType;
  bytes: Uint8Array;
}

/**
 * Host-side pre-flight for an upload; returns the first problem or null. The device enforces the
 * same per-asset rules plus the count and total caps, which only it can see.
 */
export function overlayAssetUploadProblem(asset: OverlayAssetUpload): string | null {
  return (
    overlayAssetIdProblem(asset.id) ??
    (!OVERLAY_ASSET_MIME_TYPES.includes(asset.mimeType)
      ? `Unsupported overlay asset MIME type; use one of ${OVERLAY_ASSET_MIME_TYPES.join(", ")}.`
      : null) ??
    (asset.bytes.length === 0 ? "Overlay asset has no data." : null) ??
    (asset.bytes.length > MAX_OVERLAY_ASSET_BYTES
      ? `Overlay asset is ${asset.bytes.length} bytes; the limit is ${MAX_OVERLAY_ASSET_BYTES}.`
      : null)
  );
}

/** Asset ids are opaque nonempty strings with a transport length cap. */
export function overlayAssetIdProblem(id: string): string | null {
  return id.length === 0 || id.length > MAX_OVERLAY_ASSET_ID_LENGTH
    ? `Overlay asset id must be 1 to ${MAX_OVERLAY_ASSET_ID_LENGTH} characters.`
    : null;
}
