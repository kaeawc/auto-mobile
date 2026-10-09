import { isAbsolute } from "node:path";
import { logger } from "../../utils/logger";
import { errorMessage } from "../../utils/describeUnknownError";
import type { OverlayAssetFileReader } from "./overlayAssetUploader";
import { MAX_OVERLAY_SPEC_BYTES } from "./overlaySpec";

export type OverlaySpecFileRead = { json: unknown } | { error: string };

/**
 * Reads the JSON a `specPath` names, host-side: the path is never sent to the device. The size is
 * checked from `stat` before the file is read and again on the bytes read, so an oversize file is
 * refused without being parsed. Validation is left to the caller, which runs the same validator as
 * an inline `spec`. Every failure is a message that names the file.
 */
export async function readOverlaySpecFile(
  path: string,
  reader: OverlayAssetFileReader,
): Promise<OverlaySpecFileRead> {
  const fail = (reason: string): OverlaySpecFileRead => ({ error: `specPath ${path}: ${reason}` });
  if (!isAbsolute(path)) {
    return fail("path must be absolute; the daemon does not resolve relative paths");
  }
  let bytes: Buffer;
  try {
    const stat = await reader.stat(path);
    if (!stat.isFile()) {
      return fail("path is not a regular file");
    }
    if (stat.size > MAX_OVERLAY_SPEC_BYTES) {
      return fail(`file is ${stat.size} bytes; the limit is ${MAX_OVERLAY_SPEC_BYTES}`);
    }
    bytes = await reader.readFile(path);
  } catch (error) {
    logger.warn(`[overlay] Cannot read spec file ${path}: ${errorMessage(error)}`, error);
    return fail(`cannot read file: ${errorMessage(error)}`);
  }
  if (bytes.length > MAX_OVERLAY_SPEC_BYTES) {
    return fail(`file is ${bytes.length} bytes; the limit is ${MAX_OVERLAY_SPEC_BYTES}`);
  }
  try {
    return { json: JSON.parse(bytes.toString("utf8").replace(/^﻿/, "")) };
  } catch (error) {
    logger.warn(`[overlay] Spec file ${path} is not valid JSON: ${errorMessage(error)}`, error);
    return fail(`invalid JSON: ${errorMessage(error)}`);
  }
}
