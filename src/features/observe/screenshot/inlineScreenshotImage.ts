import { stat, readFile } from "node:fs/promises";
import { extname } from "node:path";
import {
  detectImageMimeType,
  type ImageMimeType,
} from "../../../utils/screenshot/imageHeaderDimensions";
import { createImageToolResponse, throwIfAborted } from "../../../utils/toolUtils";
import { errorMessage } from "../../../utils/describeUnknownError";
import { logger } from "../../../utils/logger";
import type { ObserveResult } from "../../../models/ObserveResult";

export const MAX_INLINE_SCREENSHOT_BYTES = 5 * 1024 * 1024;

export type ScreenshotImageStatus =
  | { included: true; mimeType: string; sizeBytes: number }
  | { included: false; reason: string; sizeBytes?: number; capBytes?: number };

export type InlineScreenshotImageResult =
  | {
      screenshotImage: Extract<ScreenshotImageStatus, { included: true }>;
      image: { type: "image"; data: string; mimeType: string };
    }
  | { screenshotImage: Extract<ScreenshotImageStatus, { included: false }>; image?: never };

export interface ScreenshotImageFileSystem {
  stat(path: string): Promise<{ size: number; isFile(): boolean }>;
  readFile(path: string): Promise<Buffer>;
}

const defaultFileSystem: ScreenshotImageFileSystem = { stat, readFile };
type ScreenshotImageMetadata = Pick<ObserveResult, "screenshotFormat" | "screenshotMimeType">;
const mimeTypesByExtension = new Map<string, ImageMimeType>([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
]);

function screenshotMimeType(
  path: string,
  bytes: Buffer,
  metadata: ScreenshotImageMetadata,
): ImageMimeType | undefined {
  const fallback =
    detectImageMimeType(bytes) ?? mimeTypesByExtension.get(extname(path).toLowerCase());
  if (!fallback) {
    return undefined;
  }
  return (
    metadata.screenshotMimeType ??
    (metadata.screenshotFormat ? `image/${metadata.screenshotFormat}` : fallback)
  );
}

/** Inspect only the file from an already completed capture. Never starts a capture. */
export async function inlineScreenshotImage(
  path: string | undefined,
  metadata: ScreenshotImageMetadata,
  signal?: AbortSignal,
  fileSystem: ScreenshotImageFileSystem = defaultFileSystem,
  capBytes = MAX_INLINE_SCREENSHOT_BYTES,
): Promise<InlineScreenshotImageResult> {
  throwIfAborted(signal);
  if (!path) {
    return {
      screenshotImage: {
        included: false,
        reason:
          "Settled capture has no screenshot path. Inspect the observation screenshot resource.",
      },
    };
  }
  let sizeBytes: number | undefined;
  try {
    const file = await fileSystem.stat(path);
    throwIfAborted(signal);
    sizeBytes = file.size;
    if (!file.isFile()) {
      return {
        screenshotImage: {
          included: false,
          reason: `Screenshot path ${path} is not a file. Inspect the capture path.`,
        },
      };
    }
    if (file.size > capBytes) {
      return {
        screenshotImage: {
          included: false,
          reason: `Screenshot exceeds the ${capBytes}-byte inline limit. Read the existing screenshot path or resource.`,
          sizeBytes: file.size,
          capBytes,
        },
      };
    }
    const bytes = await fileSystem.readFile(path);
    throwIfAborted(signal);
    sizeBytes = bytes.length;
    if (bytes.length > capBytes) {
      return {
        screenshotImage: {
          included: false,
          reason: `Screenshot grew beyond the ${capBytes}-byte inline limit. Read the existing screenshot path or resource.`,
          sizeBytes: bytes.length,
          capBytes,
        },
      };
    }
    const mimeType = screenshotMimeType(path, bytes, metadata);
    if (!mimeType) {
      return {
        screenshotImage: {
          included: false,
          reason:
            "Screenshot is not a supported PNG, JPEG, or WebP image. Inspect the existing file.",
          sizeBytes,
        },
      };
    }
    return {
      screenshotImage: { included: true, mimeType, sizeBytes },
      image: createImageToolResponse(bytes.toString("base64"), mimeType).content[0],
    };
  } catch (error) {
    throwIfAborted(signal);
    logger.warn(`Could not read captured screenshot ${path}: ${errorMessage(error)}`, error);
    return {
      screenshotImage: {
        included: false,
        reason: `Could not read captured screenshot ${path}: ${errorMessage(error)}. Read the existing screenshot path or resource.`,
        ...(sizeBytes === undefined ? {} : { sizeBytes }),
      },
    };
  }
}
