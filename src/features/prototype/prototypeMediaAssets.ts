import { prototypeAssetIdProblem } from "./prototypeAssets";
import contract from "../../../schemas/prototype-asset-contract.json";

/**
 * Prototype media asset contract (#14254): video, audio and WebVTT captions. Media has its own
 * budget in `schemas/prototype-asset-contract.json` (`media`), separate from images and fonts, and
 * travels in chunks instead of one base64 frame. The Android protocol module reads the same JSON.
 */
export const {
  MAX_PROTOTYPE_MEDIA_ASSET_BYTES,
  MAX_PROTOTYPE_VTT_ASSET_BYTES,
  MAX_PROTOTYPE_MEDIA_ASSET_COUNT,
  MAX_PROTOTYPE_MEDIA_ASSET_TOTAL_BYTES,
  MAX_PROTOTYPE_MEDIA_CHUNK_BYTES,
} = contract.media.limits;

export type PrototypeMediaMimeType =
  | "video/mp4"
  | "video/webm"
  | "audio/mp4"
  | "audio/mpeg"
  | "audio/ogg"
  | "text/vtt";

export const PROTOTYPE_MEDIA_MIME_TYPES: readonly PrototypeMediaMimeType[] =
  contract.media.mimeTypes.map((type) => type as PrototypeMediaMimeType);

/** Leading bytes that decide every media signature; a shorter file is judged on all it has. */
export const PROTOTYPE_MEDIA_SIGNATURE_PROBE_BYTES = 16;

/**
 * Closed rejection vocabulary shared with the Kotlin receiver and the
 * `test/fixtures/prototype-media-transport/cases.json` corpus.
 */
export const PROTOTYPE_MEDIA_REJECTIONS = [
  "invalid_id",
  "unsupported_mime_type",
  "empty",
  "too_large",
  "invalid_sha256",
  "count_limit",
  "total_limit",
  "unknown_upload",
  "offset_mismatch",
  "empty_chunk",
  "chunk_too_large",
  "invalid_base64",
  "overflow",
  "truncated",
  "sha256_mismatch",
  "content_mismatch",
  "not_utf8",
  "storage_failure",
] as const;

export type PrototypeMediaRejection = (typeof PROTOTYPE_MEDIA_REJECTIONS)[number];

export interface PrototypeMediaProblem {
  code: PrototypeMediaRejection;
  message: string;
}

export function isPrototypeMediaMimeType(mimeType: string): mimeType is PrototypeMediaMimeType {
  return PROTOTYPE_MEDIA_MIME_TYPES.some((type) => type === mimeType);
}

/** Largest accepted media asset for a MIME type: captions have a much tighter cap. */
export function maxPrototypeMediaAssetBytes(mimeType: PrototypeMediaMimeType): number {
  return mimeType === "text/vtt" ? MAX_PROTOTYPE_VTT_ASSET_BYTES : MAX_PROTOTYPE_MEDIA_ASSET_BYTES;
}

function startsWith(bytes: Uint8Array, prefix: readonly number[], at = 0): boolean {
  return (
    bytes.length >= at + prefix.length &&
    prefix.every((value, index) => bytes[at + index] === value)
  );
}

const FTYP = [0x66, 0x74, 0x79, 0x70];
const EBML = [0x1a, 0x45, 0xdf, 0xa3];
const ID3 = [0x49, 0x44, 0x33];
const OGGS = [0x4f, 0x67, 0x67, 0x53];
const UTF8_BOM = [0xef, 0xbb, 0xbf];
const WEBVTT = [0x57, 0x45, 0x42, 0x56, 0x54, 0x54];
/** After `WEBVTT` the header line must end or continue with a space or tab. */
const WEBVTT_TERMINATORS = new Set([0x20, 0x09, 0x0a, 0x0d]);

function isWebVttHeader(bytes: Uint8Array): boolean {
  const start = startsWith(bytes, UTF8_BOM) ? UTF8_BOM.length : 0;
  if (!startsWith(bytes, WEBVTT, start)) {
    return false;
  }
  const next = start + WEBVTT.length;
  return next === bytes.length || WEBVTT_TERMINATORS.has(bytes[next]);
}

function isMpegAudio(bytes: Uint8Array): boolean {
  return (
    startsWith(bytes, ID3) || (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)
  );
}

/**
 * Whether the leading bytes match the declared type's container signature: an ISO BMFF `ftyp` box
 * at offset 4 (MP4 and M4A share it, so the declared type decides), the EBML magic (WebM), an ID3
 * tag or MPEG frame sync (MP3), `OggS`, or a `WEBVTT` header after an optional UTF-8 BOM.
 */
export function prototypeMediaSignatureMatches(
  mimeType: PrototypeMediaMimeType,
  head: Uint8Array,
): boolean {
  switch (mimeType) {
    case "video/mp4":
    case "audio/mp4":
      return startsWith(head, FTYP, 4);
    case "video/webm":
      return startsWith(head, EBML);
    case "audio/mpeg":
      return isMpegAudio(head);
    case "audio/ogg":
      return startsWith(head, OGGS);
    case "text/vtt":
      return isWebVttHeader(head);
  }
}

/** What `put_prototype_asset_begin` declares before any bytes are sent. */
export interface PrototypeMediaBegin {
  id: string;
  mimeType: string;
  size: number;
  sha256: string;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * Host pre-flight for a media begin; the device repeats it and adds the count and total caps,
 * which only it can see. Returns the first problem, or null.
 */
export function prototypeMediaBeginProblem(
  begin: PrototypeMediaBegin,
): PrototypeMediaProblem | null {
  const idProblem = prototypeAssetIdProblem(begin.id);
  if (idProblem !== null) {
    return { code: "invalid_id", message: idProblem };
  }
  if (!isPrototypeMediaMimeType(begin.mimeType)) {
    return {
      code: "unsupported_mime_type",
      message: `Unsupported prototype media MIME type; use one of ${PROTOTYPE_MEDIA_MIME_TYPES.join(", ")}.`,
    };
  }
  if (!Number.isSafeInteger(begin.size) || begin.size <= 0) {
    return { code: "empty", message: "Prototype media asset has no data." };
  }
  const limit = maxPrototypeMediaAssetBytes(begin.mimeType);
  if (begin.size > limit) {
    return {
      code: "too_large",
      message: `Prototype media asset is ${begin.size} bytes; the limit for ${begin.mimeType} is ${limit}.`,
    };
  }
  if (!SHA256_HEX.test(begin.sha256)) {
    return { code: "invalid_sha256", message: "sha256 must be 64 lowercase hex characters." };
  }
  return null;
}
