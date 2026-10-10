import { isAbsolute } from "node:path";
import * as nodeFs from "node:fs/promises";
import type { PrototypeAssetResult } from "../observe/android/ctrlProxyProtocol";
import type { PrototypeAssetRequestOptions } from "../observe/android/CtrlProxyPrototypes";
import {
  type PrototypeAssetUpload,
  MAX_PROTOTYPE_ASSET_BYTES,
  MAX_PROTOTYPE_ASSET_COUNT,
  MAX_PROTOTYPE_ASSET_TOTAL_BYTES,
  detectFontMimeType,
  prototypeAssetUploadProblem,
} from "./prototypeAssets";
import { detectImageMimeType } from "../../utils/screenshot/imageHeaderDimensions";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";

/**
 * One image the caller wants available to the prototype: a file the daemon can open (`path`) or the
 * screenshot captured with an observation (`observation`, an `automobile:observation/.../screenshot`
 * URI). Exactly one of the two is set.
 */
export interface PrototypeAssetSource {
  id: string;
  path?: string;
  observation?: string;
}

/** Resolves an observation screenshot URI to image bytes, or says why it cannot. */
export type PrototypeObservationScreenshotReader = (
  uri: string,
) => Promise<{ bytes: Buffer } | { error: string }>;

/** The file seam: tests inject an in-memory reader so nothing touches disk. */
export interface PrototypeAssetFileReader {
  stat(path: string): Promise<{ isFile(): boolean; size: number }>;
  readFile(path: string): Promise<Buffer>;
}

export const nodePrototypeAssetFileReader: PrototypeAssetFileReader = {
  stat: (path) => nodeFs.stat(path),
  readFile: (path) => nodeFs.readFile(path),
};

/** The one client method the uploader needs. */
export interface PrototypeAssetPutClient {
  requestPutPrototypeAsset(
    asset: PrototypeAssetUpload,
    options?: PrototypeAssetRequestOptions,
  ): Promise<PrototypeAssetResult>;
}

export interface UploadedPrototypeAsset {
  id: string;
  mimeType: string;
  bytes: number;
}

export interface PrototypeAssetUploadOutcome {
  success: boolean;
  /** Assets the device confirmed before the call ended; they stay until the prototype session ends. */
  uploaded: UploadedPrototypeAsset[];
  error?: string;
}

type Prepared = { assets: PrototypeAssetUpload[] } | { error: string };

/** Font files are checked by signature and size only; they are never decoded as images. */
function validateFontBytes(id: string, bytes: Buffer): PrototypeAssetUpload | string | null {
  const mimeType = detectFontMimeType(bytes);
  if (mimeType === null) {
    return null;
  }
  const asset: PrototypeAssetUpload = { id, mimeType, bytes };
  return prototypeAssetUploadProblem(asset) ?? asset;
}

function validateImageBytes(id: string, bytes: Buffer): PrototypeAssetUpload | string {
  const mimeType = detectImageMimeType(bytes);
  if (mimeType === null) {
    return "file is not a PNG, JPEG or WebP image (checked the file signature)";
  }
  const asset: PrototypeAssetUpload = { id, mimeType, bytes };
  return prototypeAssetUploadProblem(asset) ?? asset;
}

/** A file source may be an image or a font; fonts are told apart by their sfnt signature. */
function validateFileBytes(id: string, bytes: Buffer): PrototypeAssetUpload | string {
  return validateFontBytes(id, bytes) ?? validateImageBytes(id, bytes);
}

async function readFileSource(
  source: { id: string; path: string },
  reader: PrototypeAssetFileReader,
): Promise<PrototypeAssetUpload | string> {
  if (!isAbsolute(source.path)) {
    return "path must be absolute; the daemon does not resolve relative paths";
  }
  try {
    const stat = await reader.stat(source.path);
    if (!stat.isFile()) {
      return "path is not a regular file";
    }
    if (stat.size > MAX_PROTOTYPE_ASSET_BYTES) {
      return `file is ${stat.size} bytes; the limit is ${MAX_PROTOTYPE_ASSET_BYTES}`;
    }
    return validateFileBytes(source.id, await reader.readFile(source.path));
  } catch (error) {
    logger.warn(`[prototype] Cannot read asset file ${source.path}: ${errorMessage(error)}`, error);
    return `cannot read file: ${errorMessage(error)}`;
  }
}

async function readObservationSource(
  source: { id: string; observation: string },
  readObservation: PrototypeObservationScreenshotReader | undefined,
): Promise<PrototypeAssetUpload | string> {
  if (!readObservation) {
    return "observation screenshots are not available here";
  }
  try {
    const read = await readObservation(source.observation);
    if ("error" in read) {
      return read.error;
    }
    if (read.bytes.length > MAX_PROTOTYPE_ASSET_BYTES) {
      return `screenshot is ${read.bytes.length} bytes; the limit is ${MAX_PROTOTYPE_ASSET_BYTES}`;
    }
    return validateImageBytes(source.id, read.bytes);
  } catch (error) {
    logger.warn(
      `[prototype] Cannot read observation screenshot ${source.observation}: ${errorMessage(error)}`,
      error,
    );
    return `cannot read observation screenshot: ${errorMessage(error)}`;
  }
}

function describeSource(source: PrototypeAssetSource): string {
  return source.observation ?? source.path ?? "no source";
}

async function readSource(
  source: PrototypeAssetSource,
  reader: PrototypeAssetFileReader,
  readObservation: PrototypeObservationScreenshotReader | undefined,
): Promise<PrototypeAssetUpload | string> {
  const { id, path, observation } = source;
  if (path !== undefined && observation === undefined) {
    return readFileSource({ id, path }, reader);
  }
  if (observation !== undefined && path === undefined) {
    return readObservationSource({ id, observation }, readObservation);
  }
  return "give exactly one of path or observation";
}

/**
 * Reads and validates every source before anything is sent, so a bad file, an unsupported format
 * or an exceeded cap fails the call with nothing uploaded.
 */
export async function preparePrototypeAssets(
  sources: readonly PrototypeAssetSource[],
  reader: PrototypeAssetFileReader = nodePrototypeAssetFileReader,
  readObservation?: PrototypeObservationScreenshotReader,
): Promise<Prepared> {
  const fail = (message: string): Prepared => ({
    error: `${message} No assets were uploaded and the prototype was not changed.`,
  });
  if (sources.length > MAX_PROTOTYPE_ASSET_COUNT) {
    return fail(
      `At most ${MAX_PROTOTYPE_ASSET_COUNT} prototype assets per call; got ${sources.length}.`,
    );
  }
  const seen = new Set<string>();
  const assets: PrototypeAssetUpload[] = [];
  let total = 0;
  for (const source of sources) {
    if (seen.has(source.id)) {
      return fail(`Prototype asset id '${source.id}' appears more than once.`);
    }
    seen.add(source.id);
    const read = await readSource(source, reader, readObservation);
    if (typeof read === "string") {
      return fail(`Prototype asset '${source.id}' (${describeSource(source)}): ${read}.`);
    }
    total += read.bytes.length;
    if (total > MAX_PROTOTYPE_ASSET_TOTAL_BYTES) {
      return fail(
        `Prototype assets total more than ${MAX_PROTOTYPE_ASSET_TOTAL_BYTES} bytes (reached at '${source.id}').`,
      );
    }
    assets.push(read);
  }
  return { assets };
}

function describeUploaded(uploaded: readonly UploadedPrototypeAsset[]): string {
  return uploaded.length === 0
    ? "No assets were uploaded."
    : `Already uploaded: ${uploaded.map((asset) => asset.id).join(", ")}; they stay on the device until the prototype session ends, and re-sending the call replaces them.`;
}

const OUTCOME_AFTER_STOP = {
  show: "The new spec was not sent; a prototype already showing stays as it was.",
  resend: "The prototype stays as first sent, with placeholders for the missing assets.",
} as const;

/**
 * Uploads prepared assets one at a time, in order. The first failure stops the run. The error
 * names the asset, says whether its outcome is indeterminate (written but never answered), and
 * lists what was already stored, so a half-finished upload is never silent.
 */
export async function uploadPrototypeAssets(
  client: PrototypeAssetPutClient,
  assets: readonly PrototypeAssetUpload[],
  options: { signal?: AbortSignal; action: "show" | "resend" },
): Promise<PrototypeAssetUploadOutcome> {
  const uploaded: UploadedPrototypeAsset[] = [];
  const stop = (reason: string): PrototypeAssetUploadOutcome => ({
    success: false,
    uploaded,
    error: `${reason} ${describeUploaded(uploaded)} ${OUTCOME_AFTER_STOP[options.action]}`,
  });
  for (const asset of assets) {
    if (options.signal?.aborted) {
      return stop(`Prototype asset upload was cancelled before '${asset.id}'.`);
    }
    let result: PrototypeAssetResult;
    try {
      result = await client.requestPutPrototypeAsset(asset, { abortSignal: options.signal });
    } catch (error) {
      logger.warn(`[prototype] Asset '${asset.id}' upload failed: ${errorMessage(error)}`, error);
      return stop(`Prototype asset '${asset.id}' was not uploaded: ${errorMessage(error)}.`);
    }
    if (!result.success) {
      const outcome =
        result.dispatched && !result.acknowledged
          ? "Outcome is indeterminate"
          : "Device refused the upload";
      return stop(
        `Prototype asset '${asset.id}' failed. ${outcome}: ${result.error ?? "no detail"}.`,
      );
    }
    uploaded.push({ id: asset.id, mimeType: asset.mimeType, bytes: asset.bytes.length });
  }
  return { success: true, uploaded };
}
