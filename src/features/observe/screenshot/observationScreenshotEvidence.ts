import * as fs from "node:fs/promises";
import nodePath from "node:path";
import { ActionableError } from "../../../models/ActionableError";
import { defaultTimer, type Timer } from "../../../utils/SystemTimer";

export interface ScreenshotEvidenceFiles {
  stat(path: string): Promise<{ isFile(): boolean; size: number; mtimeMs: number }>;
}

export interface ObservationScreenshotEvidence {
  screenshotPath: string;
  screenshotSource: "fresh" | "cached";
  screenshotCaptureSource: "device" | "observation-cache";
  screenshotCapturedAt: string;
  screenshotAgeMs: number;
  screenshotFormat: "png" | "jpeg" | "webp";
  screenshotMimeType: "image/png" | "image/jpeg" | "image/webp";
  screenshotFreshFailure?: { code: string; message: string; retryable: boolean };
}

export function screenshotFormatForPath(filePath: string): "png" | "jpeg" | "webp" {
  const extension = nodePath.extname(filePath).toLowerCase();
  const format: Record<string, "png" | "jpeg" | "webp"> = {
    ".png": "png",
    ".jpg": "jpeg",
    ".jpeg": "jpeg",
    ".webp": "webp",
  };
  const resolved = format[extension];
  if (!resolved) {
    throw new ActionableError("Screenshot file has an unrecognized format.");
  }
  return resolved;
}

/** Describe only an existing screenshot file; never advertise an absent path. */
export async function observationScreenshotEvidence(
  path: string,
  source: "fresh" | "cached",
  freshFailure?: string,
  files: ScreenshotEvidenceFiles = fs,
  timer: Timer = defaultTimer,
): Promise<ObservationScreenshotEvidence> {
  const stat = await files.stat(path);
  if (!stat.isFile() || stat.size === 0) {
    throw new ActionableError("Screenshot file is missing or empty.");
  }
  const capturedAt = Number.isFinite(stat.mtimeMs) ? stat.mtimeMs : timer.now();
  const screenshotFormat = screenshotFormatForPath(path);
  return {
    screenshotPath: path,
    screenshotSource: source,
    screenshotCaptureSource: source === "fresh" ? "device" : "observation-cache",
    screenshotCapturedAt: new Date(capturedAt).toISOString(),
    screenshotAgeMs: Math.max(0, timer.now() - capturedAt),
    screenshotFormat,
    screenshotMimeType: `image/${screenshotFormat}`,
    ...(freshFailure
      ? {
          screenshotFreshFailure: {
            code: "SCREENSHOT_CAPTURE_FAILED",
            message: freshFailure,
            retryable: true,
          },
        }
      : {}),
  };
}
