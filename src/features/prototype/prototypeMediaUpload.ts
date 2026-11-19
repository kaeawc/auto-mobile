import { createHash } from "node:crypto";
import * as nodeFs from "node:fs/promises";
import { extname, isAbsolute } from "node:path";
import { boundedPrototypeError } from "./prototypeErrors";
import {
  MAX_PROTOTYPE_MEDIA_CHUNK_BYTES,
  PROTOTYPE_MEDIA_SIGNATURE_PROBE_BYTES,
  type PrototypeMediaMimeType,
  type PrototypeMediaRejection,
  maxPrototypeMediaAssetBytes,
  prototypeMediaBeginProblem,
  prototypeMediaSignatureMatches,
} from "./prototypeMediaAssets";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";

/**
 * Chunked media upload (#14254). A media asset is announced with its size and sha256, streamed in
 * chunks of at most `MAX_PROTOTYPE_MEDIA_CHUNK_BYTES`, then committed; the device writes chunks to
 * a cache file and verifies the digest on commit, so neither side holds the whole asset in memory.
 * A failure after begin sends an abort so the device drops the partial file at once.
 *
 * Wire shapes, each answered by one result (request ids are added by the client):
 * - `put_prototype_asset_begin {id, mimeType, size, sha256}`
 * - `put_prototype_asset_chunk {id, offset, dataBase64}`, offsets contiguous from 0
 * - `put_prototype_asset_commit {id}`
 * - `put_prototype_asset_abort {id}`, idempotent
 */
export type PrototypeMediaTransportMessage =
  | {
      type: "put_prototype_asset_begin";
      id: string;
      mimeType: PrototypeMediaMimeType;
      size: number;
      sha256: string;
    }
  | { type: "put_prototype_asset_chunk"; id: string; offset: number; dataBase64: string }
  | { type: "put_prototype_asset_commit"; id: string }
  | { type: "put_prototype_asset_abort"; id: string };

export interface PrototypeMediaTransportResult {
  success: boolean;
  /** The device's rejection code when it refused the message. */
  code?: PrototypeMediaRejection;
  error?: string;
}

/** The one client method the uploader needs; each platform transport implements it. */
export interface PrototypeMediaTransportClient {
  sendPrototypeMediaMessage(
    message: PrototypeMediaTransportMessage,
    options?: { abortSignal?: AbortSignal },
  ): Promise<PrototypeMediaTransportResult>;
}

/** An open media file: read by offset, so only one chunk is ever in memory. */
export interface PrototypeMediaFileHandle {
  readonly size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
  close(): Promise<void>;
}

/** The file seam: tests inject an in-memory opener so nothing touches disk. */
export interface PrototypeMediaFileOpener {
  open(path: string): Promise<PrototypeMediaFileHandle>;
}

export const nodePrototypeMediaFileOpener: PrototypeMediaFileOpener = {
  async open(path) {
    const handle = await nodeFs.open(path, "r");
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) {
        throw new Error("path is not a regular file");
      }
      return {
        size: stat.size,
        async read(offset, length) {
          const buffer = Buffer.alloc(length);
          let filled = 0;
          while (filled < length) {
            const { bytesRead } = await handle.read(
              buffer,
              filled,
              length - filled,
              offset + filled,
            );
            if (bytesRead === 0) {
              throw new Error("file shrank while it was being read");
            }
            filled += bytesRead;
          }
          return buffer;
        },
        close: () => handle.close(),
      };
    } catch (error) {
      await handle.close();
      throw error;
    }
  },
};

const EXTENSION_MIME_TYPES: Readonly<Record<string, PrototypeMediaMimeType>> = {
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".m4a": "audio/mp4",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".vtt": "text/vtt",
};

/**
 * The media type a file path declares by its extension, or null when it is not a media file. MP4
 * and M4A share a container signature, so the extension decides and the signature confirms it.
 */
export function prototypeMediaMimeTypeForPath(path: string): PrototypeMediaMimeType | null {
  return EXTENSION_MIME_TYPES[extname(path).toLowerCase()] ?? null;
}

export interface PrototypeMediaUploadOutcome {
  success: boolean;
  id: string;
  mimeType?: PrototypeMediaMimeType;
  bytes?: number;
  code?: PrototypeMediaRejection;
  error?: string;
}

interface ScannedMedia {
  size: number;
  sha256: string;
}

/** Offsets and lengths of every chunk for a file of `size` bytes. */
export function prototypeMediaChunkRanges(
  size: number,
  chunkBytes: number = MAX_PROTOTYPE_MEDIA_CHUNK_BYTES,
): { offset: number; length: number }[] {
  return Array.from({ length: Math.ceil(size / chunkBytes) }, (_, index) => {
    const offset = index * chunkBytes;
    return { offset, length: Math.min(chunkBytes, size - offset) };
  });
}

class MediaUploadFailure extends Error {
  constructor(
    readonly code: PrototypeMediaRejection | undefined,
    message: string,
    /** The device answered and said no, so it holds nothing for the message it refused. */
    readonly refused = false,
  ) {
    super(message);
  }
}

/**
 * First pass: the digest the begin message must carry, plus the signature and (for captions)
 * strict UTF-8 checks, one chunk at a time.
 */
async function scanMedia(
  file: PrototypeMediaFileHandle,
  mimeType: PrototypeMediaMimeType,
  chunkBytes: number,
): Promise<ScannedMedia> {
  const hash = createHash("sha256");
  const decoder = mimeType === "text/vtt" ? new TextDecoder("utf-8", { fatal: true }) : null;
  const head = await file.read(0, Math.min(PROTOTYPE_MEDIA_SIGNATURE_PROBE_BYTES, file.size));
  if (!prototypeMediaSignatureMatches(mimeType, head)) {
    throw new MediaUploadFailure(
      "content_mismatch",
      `file content is not ${mimeType} (checked the file signature)`,
    );
  }
  for (const { offset, length } of prototypeMediaChunkRanges(file.size, chunkBytes)) {
    const bytes = await file.read(offset, length);
    hash.update(bytes);
    try {
      decoder?.decode(bytes, { stream: true });
    } catch {
      // A fatal TextDecoder throws only for malformed UTF-8; the code below is the whole report.
      throw new MediaUploadFailure("not_utf8", "WebVTT captions must be valid UTF-8");
    }
  }
  try {
    decoder?.decode();
  } catch {
    // The flush throws only for a code point cut off at end of file.
    throw new MediaUploadFailure("not_utf8", "WebVTT captions must be valid UTF-8");
  }
  return { size: file.size, sha256: hash.digest("hex") };
}

async function send(
  client: PrototypeMediaTransportClient,
  message: PrototypeMediaTransportMessage,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (signal?.aborted) {
    throw new MediaUploadFailure(undefined, "upload was cancelled");
  }
  const result = await client.sendPrototypeMediaMessage(message, { abortSignal: signal });
  if (!result.success) {
    throw new MediaUploadFailure(
      result.code,
      `device refused ${message.type}: ${result.error ?? "no detail"}`,
      true,
    );
  }
}

async function abortOnDevice(client: PrototypeMediaTransportClient, id: string): Promise<void> {
  try {
    await client.sendPrototypeMediaMessage({ type: "put_prototype_asset_abort", id });
  } catch (error) {
    // The device also drops a partial upload when the session ends, so a lost abort only delays it.
    logger.warn(`[prototype] Abort of media upload '${id}' failed: ${errorMessage(error)}`, error);
  }
}

/** One open upload: everything the stream and commit steps share. */
interface MediaUploadContext {
  client: PrototypeMediaTransportClient;
  file: PrototypeMediaFileHandle;
  id: string;
  chunkBytes: number;
  signal: AbortSignal | undefined;
}

async function streamMedia({
  client,
  file,
  id,
  chunkBytes,
  signal,
}: MediaUploadContext): Promise<void> {
  for (const { offset, length } of prototypeMediaChunkRanges(file.size, chunkBytes)) {
    const bytes = await file.read(offset, length);
    const dataBase64 = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString(
      "base64",
    );
    await send(client, { type: "put_prototype_asset_chunk", id, offset, dataBase64 }, signal);
  }
  await send(client, { type: "put_prototype_asset_commit", id }, signal);
}

export interface PrototypeMediaUploadOptions {
  signal?: AbortSignal;
  opener?: PrototypeMediaFileOpener;
  /** Test seam; production always uses the contract chunk size. */
  chunkBytes?: number;
}

async function uploadOpenMedia(
  context: MediaUploadContext,
  mimeType: PrototypeMediaMimeType,
): Promise<number> {
  const { client, file, id, chunkBytes, signal } = context;
  const limit = maxPrototypeMediaAssetBytes(mimeType);
  if (file.size > limit) {
    // Checked before hashing so an oversize file is never read.
    throw new MediaUploadFailure(
      "too_large",
      `file is ${file.size} bytes; the limit for ${mimeType} is ${limit}`,
    );
  }
  const scanned = await scanMedia(file, mimeType, chunkBytes);
  const begin = { id, mimeType, size: scanned.size, sha256: scanned.sha256 };
  const problem = prototypeMediaBeginProblem(begin);
  if (problem !== null) {
    throw new MediaUploadFailure(problem.code, problem.message);
  }
  try {
    await send(client, { type: "put_prototype_asset_begin", ...begin }, signal);
  } catch (error) {
    // A begin lost in transit may still have reserved space on the device; only a refusal did not.
    if (!(error instanceof MediaUploadFailure && error.refused)) {
      await abortOnDevice(client, id);
    }
    throw error;
  }
  try {
    await streamMedia(context);
  } catch (error) {
    await abortOnDevice(client, id);
    throw error;
  }
  return scanned.size;
}

function failure(
  id: string,
  mimeType: PrototypeMediaMimeType | undefined,
  error: unknown,
): PrototypeMediaUploadOutcome {
  const code = error instanceof MediaUploadFailure ? error.code : undefined;
  return {
    success: false,
    id,
    mimeType,
    code,
    error: boundedPrototypeError(
      `Prototype media asset '${id}' was not uploaded: ${errorMessage(error)}. The device discards an upload that never commits.`,
    ),
  };
}

/**
 * Uploads one media file by absolute path. Validates type, size, signature and (for captions)
 * UTF-8 before anything is sent; after begin, any failure aborts the device-side upload.
 */
export async function uploadPrototypeMediaAsset(
  client: PrototypeMediaTransportClient,
  source: { id: string; path: string },
  options: PrototypeMediaUploadOptions = {},
): Promise<PrototypeMediaUploadOutcome> {
  const mimeType = prototypeMediaMimeTypeForPath(source.path) ?? undefined;
  if (!isAbsolute(source.path)) {
    return failure(source.id, mimeType, new MediaUploadFailure(undefined, "path must be absolute"));
  }
  if (mimeType === undefined) {
    return failure(
      source.id,
      mimeType,
      new MediaUploadFailure(
        "unsupported_mime_type",
        `unsupported media file extension; use one of ${Object.keys(EXTENSION_MIME_TYPES).join(", ")}`,
      ),
    );
  }
  let file: PrototypeMediaFileHandle;
  try {
    file = await (options.opener ?? nodePrototypeMediaFileOpener).open(source.path);
  } catch (error) {
    logger.warn(`[prototype] Cannot open media file ${source.path}: ${errorMessage(error)}`, error);
    return failure(source.id, mimeType, error);
  }
  try {
    const chunkBytes = Math.min(
      options.chunkBytes ?? MAX_PROTOTYPE_MEDIA_CHUNK_BYTES,
      MAX_PROTOTYPE_MEDIA_CHUNK_BYTES,
    );
    const context = { client, file, id: source.id, chunkBytes, signal: options.signal };
    const bytes = await uploadOpenMedia(context, mimeType);
    return { success: true, id: source.id, mimeType, bytes };
  } catch (error) {
    if (!(error instanceof MediaUploadFailure)) {
      logger.warn(`[prototype] Media upload '${source.id}' failed: ${errorMessage(error)}`, error);
    }
    return failure(source.id, mimeType, error);
  } finally {
    await file.close();
  }
}
