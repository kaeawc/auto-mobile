import * as realFs from "node:fs/promises";
import {
  screenshotPathProtection,
  type ScreenshotPathProtection,
} from "../features/observe/ScreenshotPathProtection";
import { detectImageMimeType } from "../utils/screenshot/imageHeaderDimensions";

export interface ScreenshotFileSystem {
  stat(path: string): Promise<{ isFile(): boolean }>;
  readFile(path: string): Promise<Buffer>;
}

export function screenshotMimeType(path: string, imageBuffer: Buffer): string {
  const detected = detectImageMimeType(imageBuffer);
  if (detected) {
    return detected;
  }
  if (path.endsWith(".webp")) {
    return "image/webp";
  }
  if (path.endsWith(".jpg") || path.endsWith(".jpeg")) {
    return "image/jpeg";
  }
  return "image/png";
}

/** Share the observation-resource read and its existing retention lease. */
export async function readRetainedScreenshot(options: {
  path: string;
  fileSystem?: ScreenshotFileSystem;
  protection?: ScreenshotPathProtection;
}): Promise<{ data: string; mimeType: string; expiresAt: number }> {
  const { path, fileSystem = realFs, protection = screenshotPathProtection } = options;
  const expiresAt = await protection.protect(path);
  const bytes = await fileSystem.readFile(path);
  return { data: bytes.toString("base64"), mimeType: screenshotMimeType(path, bytes), expiresAt };
}
