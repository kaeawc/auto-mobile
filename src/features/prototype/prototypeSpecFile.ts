import { isAbsolute } from "node:path";
import { logger } from "../../utils/logger";
import { errorMessage } from "../../utils/describeUnknownError";
import type { PrototypeAssetFileReader } from "./prototypeAssetUploader";
import { MAX_PROTOTYPE_SPEC_BYTES } from "./prototypeSpec";

export type PrototypeSpecFileRead = { json: unknown } | { error: string };

export interface PrototypeJsonFileOptions {
  /** The argument name that appears in messages; `specPath` by default. */
  label?: string;
  maxBytes?: number;
}

/**
 * Reads the JSON a `specPath` names, host-side: the path is never sent to the device. The size is
 * checked from `stat` before the file is read and again on the bytes read, so an oversize file is
 * refused without being parsed. Validation is left to the caller, which runs the same validator as
 * an inline `spec`. Every failure is a message that names the file.
 */
export async function readPrototypeSpecFile(
  path: string,
  reader: PrototypeAssetFileReader,
  { label = "specPath", maxBytes = MAX_PROTOTYPE_SPEC_BYTES }: PrototypeJsonFileOptions = {},
): Promise<PrototypeSpecFileRead> {
  const fail = (reason: string): PrototypeSpecFileRead => ({
    error: `${label} ${path}: ${reason}`,
  });
  if (!isAbsolute(path)) {
    return fail("path must be absolute; the daemon does not resolve relative paths");
  }
  let bytes: Buffer;
  try {
    const stat = await reader.stat(path);
    if (!stat.isFile()) {
      return fail("path is not a regular file");
    }
    if (stat.size > maxBytes) {
      return fail(`file is ${stat.size} bytes; the limit is ${maxBytes}`);
    }
    bytes = await reader.readFile(path);
  } catch (error) {
    logger.warn(`[prototype] Cannot read spec file ${path}: ${errorMessage(error)}`, error);
    return fail(`cannot read file: ${errorMessage(error)}`);
  }
  if (bytes.length > maxBytes) {
    return fail(`file is ${bytes.length} bytes; the limit is ${maxBytes}`);
  }
  try {
    return { json: JSON.parse(bytes.toString("utf8").replace(/^﻿/, "")) };
  } catch (error) {
    logger.warn(`[prototype] Spec file ${path} is not valid JSON: ${errorMessage(error)}`, error);
    return fail(`invalid JSON: ${errorMessage(error)}`);
  }
}
