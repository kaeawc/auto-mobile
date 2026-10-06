import { isAbsolute } from "node:path";
import * as nodeFs from "node:fs/promises";
import type { OverlayAssetResult } from "../observe/android/ctrlProxyProtocol";
import type { OverlayAssetRequestOptions } from "../observe/android/CtrlProxyOverlays";
import {
  type OverlayAssetUpload,
  MAX_OVERLAY_ASSET_BYTES,
  MAX_OVERLAY_ASSET_COUNT,
  MAX_OVERLAY_ASSET_TOTAL_BYTES,
  overlayAssetUploadProblem,
} from "./overlayAssets";
import { detectImageMimeType } from "../../utils/screenshot/imageHeaderDimensions";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";

/** One image the caller wants available to the overlay, read from a file the daemon can open. */
export interface OverlayAssetSource {
  id: string;
  path: string;
}

/** The file seam: tests inject an in-memory reader so nothing touches disk. */
export interface OverlayAssetFileReader {
  stat(path: string): Promise<{ isFile(): boolean; size: number }>;
  readFile(path: string): Promise<Buffer>;
}

export const nodeOverlayAssetFileReader: OverlayAssetFileReader = {
  stat: (path) => nodeFs.stat(path),
  readFile: (path) => nodeFs.readFile(path),
};

/** The one client method the uploader needs. */
export interface OverlayAssetPutClient {
  requestPutOverlayAsset(
    asset: OverlayAssetUpload,
    options?: OverlayAssetRequestOptions,
  ): Promise<OverlayAssetResult>;
}

export interface UploadedOverlayAsset {
  id: string;
  mimeType: string;
  bytes: number;
}

export interface OverlayAssetUploadOutcome {
  success: boolean;
  /** Assets the device confirmed before the call ended; they stay until the overlay session ends. */
  uploaded: UploadedOverlayAsset[];
  error?: string;
}

type Prepared = { assets: OverlayAssetUpload[] } | { error: string };

async function readSource(
  source: OverlayAssetSource,
  reader: OverlayAssetFileReader,
): Promise<OverlayAssetUpload | string> {
  if (!isAbsolute(source.path)) {
    return "path must be absolute; the daemon does not resolve relative paths";
  }
  try {
    const stat = await reader.stat(source.path);
    if (!stat.isFile()) {
      return "path is not a regular file";
    }
    if (stat.size > MAX_OVERLAY_ASSET_BYTES) {
      return `file is ${stat.size} bytes; the limit is ${MAX_OVERLAY_ASSET_BYTES}`;
    }
    const bytes = await reader.readFile(source.path);
    const mimeType = detectImageMimeType(bytes);
    if (mimeType === null) {
      return "file is not a PNG, JPEG or WebP image (checked the file signature)";
    }
    const asset: OverlayAssetUpload = { id: source.id, mimeType, bytes };
    return overlayAssetUploadProblem(asset) ?? asset;
  } catch (error) {
    logger.warn(`[overlay] Cannot read asset file ${source.path}: ${errorMessage(error)}`, error);
    return `cannot read file: ${errorMessage(error)}`;
  }
}

/**
 * Reads and validates every source before anything is sent, so a bad file, an unsupported format
 * or an exceeded cap fails the call with nothing uploaded.
 */
export async function prepareOverlayAssets(
  sources: readonly OverlayAssetSource[],
  reader: OverlayAssetFileReader = nodeOverlayAssetFileReader,
): Promise<Prepared> {
  const fail = (message: string): Prepared => ({
    error: `${message} No assets were uploaded and the overlay was not changed.`,
  });
  if (sources.length > MAX_OVERLAY_ASSET_COUNT) {
    return fail(
      `At most ${MAX_OVERLAY_ASSET_COUNT} overlay assets per call; got ${sources.length}.`,
    );
  }
  const seen = new Set<string>();
  const assets: OverlayAssetUpload[] = [];
  let total = 0;
  for (const source of sources) {
    if (seen.has(source.id)) {
      return fail(`Overlay asset id '${source.id}' appears more than once.`);
    }
    seen.add(source.id);
    const read = await readSource(source, reader);
    if (typeof read === "string") {
      return fail(`Overlay asset '${source.id}' (${source.path}): ${read}.`);
    }
    total += read.bytes.length;
    if (total > MAX_OVERLAY_ASSET_TOTAL_BYTES) {
      return fail(
        `Overlay assets total more than ${MAX_OVERLAY_ASSET_TOTAL_BYTES} bytes (reached at '${source.id}').`,
      );
    }
    assets.push(read);
  }
  return { assets };
}

function describeUploaded(uploaded: readonly UploadedOverlayAsset[]): string {
  return uploaded.length === 0
    ? "No assets were uploaded."
    : `Already uploaded: ${uploaded.map((asset) => asset.id).join(", ")}; they stay on the device until the overlay session ends, and re-sending the call replaces them.`;
}

/**
 * Uploads prepared assets one at a time, in order. The first failure stops the run. The error
 * names the asset, says whether its outcome is indeterminate (written but never answered), and
 * lists what was already stored, so a half-finished upload is never silent.
 */
export async function uploadOverlayAssets(
  client: OverlayAssetPutClient,
  assets: readonly OverlayAssetUpload[],
  options: { signal?: AbortSignal; action: "show" | "update" },
): Promise<OverlayAssetUploadOutcome> {
  const uploaded: UploadedOverlayAsset[] = [];
  const stop = (reason: string): OverlayAssetUploadOutcome => ({
    success: false,
    uploaded,
    error: `${reason} ${describeUploaded(uploaded)} The overlay was not ${options.action === "show" ? "shown" : "updated"}.`,
  });
  for (const asset of assets) {
    if (options.signal?.aborted) {
      return stop(`Overlay asset upload was cancelled before '${asset.id}'.`);
    }
    let result: OverlayAssetResult;
    try {
      result = await client.requestPutOverlayAsset(asset, { abortSignal: options.signal });
    } catch (error) {
      logger.warn(`[overlay] Asset '${asset.id}' upload failed: ${errorMessage(error)}`, error);
      return stop(`Overlay asset '${asset.id}' was not uploaded: ${errorMessage(error)}.`);
    }
    if (!result.success) {
      const outcome =
        result.dispatched && !result.acknowledged
          ? "Outcome is indeterminate"
          : "Device refused the upload";
      return stop(
        `Overlay asset '${asset.id}' failed. ${outcome}: ${result.error ?? "no detail"}.`,
      );
    }
    uploaded.push({ id: asset.id, mimeType: asset.mimeType, bytes: asset.bytes.length });
  }
  return { success: true, uploaded };
}
