import { crc32, inflateRawSync } from "node:zlib";
import { logger } from "../../../utils/logger";
import {
  BUNDLE_MAX_COMPRESSED_BYTES,
  BUNDLE_MAX_EXPANDED_BYTES,
  BUNDLE_MAX_RATIO,
  BundleFailure,
  bundleAssert,
  type BundleErrorCode,
} from "./bundleContract";
import { bundleEntryCap, readBundleZipDirectory, type BundleZipEntry } from "./bundleZipDirectory";

interface OutputBudget {
  limit: number;
  code: BundleErrorCode;
}
function outputBudget(
  entry: BundleZipEntry,
  remaining: number,
  ratioRemaining: number,
): OutputBudget {
  const budgets: OutputBudget[] = [
    { limit: bundleEntryCap(entry.name), code: "entry_too_large" },
    { limit: remaining, code: "expanded_too_large" },
    { limit: ratioRemaining, code: "ratio_exceeded" },
  ];
  return budgets.reduce((a, b) => (b.limit < a.limit ? b : a));
}
function inflate(bytes: Buffer, entry: BundleZipEntry, budget: OutputBudget): Buffer {
  const compressed = bytes.subarray(entry.start, entry.end);
  if (entry.method === 0) {
    bundleAssert(compressed.length <= budget.limit, budget.code, entry.name);
    return Buffer.from(compressed);
  }
  try {
    // zlib enforces the budget DURING inflation, regardless of claimed expanded size. +1 identifies
    // a real overage; actual output and consumed input are checked before accepting the entry.
    const result: unknown = inflateRawSync(compressed, {
      maxOutputLength: budget.limit + 1,
      info: true,
    });
    const output = inflatedOutput(result, compressed.length, entry.name);
    bundleAssert(output.length <= budget.limit, budget.code, entry.name);
    return output;
  } catch (error) {
    // Corrupt/oversize compressed streams are expected hostile input; boundary returns a typed failure.
    logger.debug("Bundle DEFLATE stream rejected", error);
    if (error instanceof BundleFailure) {
      throw error;
    }
    const code =
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ERR_BUFFER_TOO_LARGE"
        ? budget.code
        : "size_mismatch";
    throw new BundleFailure(code, entry.name);
  }
}
function inflatedOutput(result: unknown, compressedLength: number, path: string): Buffer {
  bundleAssert(
    typeof result === "object" &&
      result !== null &&
      "buffer" in result &&
      Buffer.isBuffer(result.buffer),
    "size_mismatch",
    path,
  );
  bundleAssert(
    "engine" in result &&
      typeof result.engine === "object" &&
      result.engine !== null &&
      "bytesWritten" in result.engine,
    "size_mismatch",
    path,
  );
  bundleAssert(result.engine.bytesWritten === compressedLength, "size_mismatch", path);
  return result.buffer;
}
export function readBundleZip(bytes: Buffer): Map<string, Uint8Array> {
  bundleAssert(bytes.length <= BUNDLE_MAX_COMPRESSED_BYTES, "archive_too_large");
  const entries = readBundleZipDirectory(bytes);
  const compressedTotal = entries.reduce((sum, entry) => sum + entry.compressed, 0);
  const result = new Map<string, Uint8Array>();
  let expanded = 0;
  for (const entry of entries) {
    bundleAssert(entry.expanded <= bundleEntryCap(entry.name), "entry_too_large", entry.name);
    const budget = outputBudget(
      entry,
      BUNDLE_MAX_EXPANDED_BYTES - expanded,
      compressedTotal * BUNDLE_MAX_RATIO - expanded,
    );
    const output = inflate(bytes, entry, budget);
    expanded += output.length;
    bundleAssert(output.length === entry.expanded, "size_mismatch", entry.name);
    bundleAssert(crc32(output) === entry.crc, "crc_mismatch", entry.name);
    result.set(entry.name, output);
  }
  return result;
}
