import { z } from "zod/v4";
import { addDeviceTargetingToSchema } from "./toolSchemaHelpers";
import type { Platform } from "../models";
import { errorMessage } from "../utils/describeUnknownError";

export interface SharedStorageFileInput {
  destinationPath: string;
  sourcePath?: string;
  contentText?: string;
  contentBase64?: string;
}

export interface StageSharedStorageArgs {
  namespace: string;
  reset?: boolean;
  indexMedia?: boolean;
  files: SharedStorageFileInput[];
  platform?: Platform;
  deviceId?: string;
  device?: string;
  sessionUuid?: string;
  keepScreenAwake?: boolean;
}

export interface SharedStorageIndexingResult {
  status: "completed" | "notRequested";
  reason?: string;
}

export interface StagedSharedStorageFile {
  destinationPath: string;
  byteCount: number;
  mediaIndexing: SharedStorageIndexingResult;
}

export interface StageSharedStorageResult {
  success: true;
  deviceId: string;
  platform: "android";
  namespace: string;
  destinationDirectory: string;
  reset: boolean;
  files: StagedSharedStorageFile[];
}

function countDefined(values: unknown[]): number {
  return values.filter(value => value !== undefined).length;
}

/** A namespace is exactly one Downloads child, keeping reset scope auditable. */
export function normalizeSharedStorageNamespace(namespace: string): string {
  const normalized = namespace.trim();
  if (
    normalized.length === 0 ||
    normalized === "." ||
    normalized === ".." ||
    normalized.includes("/") ||
    normalized.includes("\\") ||
    normalized.includes("\0")
  ) {
    throw new Error("namespace must be a non-empty single directory name without path separators or traversal segments");
  }
  return normalized;
}

export function normalizeSharedStorageRelativePath(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/^\.\/+/, "");
  const segments = normalized.split("/");
  if (
    normalized.length === 0 ||
    normalized.startsWith("/") ||
    segments.some(segment => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw new Error("destinationPath must be a non-empty relative path without '.' or '..' segments");
  }
  return normalized;
}

const sharedStorageFileSchema = z.object({
  sourcePath: z.string().min(1).optional().describe("Host file path"),
  contentText: z.string().optional().describe("UTF-8 content"),
  contentBase64: z.string().optional().describe("Base64 content"),
  destinationPath: z.string().describe("Path relative to the declared Downloads namespace"),
}).superRefine((file, ctx) => {
  if (countDefined([file.sourcePath, file.contentText, file.contentBase64]) !== 1) {
    ctx.addIssue({
      code: "custom",
      message: "Provide exactly one content source: sourcePath, contentText, or contentBase64.",
      path: ["sourcePath"],
    });
  }
  try {
    normalizeSharedStorageRelativePath(file.destinationPath);
  } catch (error) {
    ctx.addIssue({
      code: "custom",
      message: error instanceof Error ? error.message : "destinationPath must be a safe relative path",
      path: ["destinationPath"],
    });
  }
  if (file.contentBase64 !== undefined) {
    try {
      const decoded = Buffer.from(file.contentBase64, "base64");
      const canonical = decoded.toString("base64");
      const unpadded = canonical.replace(/=+$/, "");
      if ((file.contentBase64 !== canonical && file.contentBase64 !== unpadded) || decoded.length === 0) {
        throw new Error("invalid payload");
      }
    } catch (error) {
      ctx.addIssue({
        code: "custom",
        message: `contentBase64 must be valid, non-empty base64 (${errorMessage(error)}).`,
        path: ["contentBase64"],
      });
    }
  }
});

export const stageSharedStorageSchema = addDeviceTargetingToSchema(z.object({
  platform: z.literal("android").optional().default("android").describe("Android platform"),
  namespace: z.string().describe("One caller-named child directory beneath Downloads"),
  reset: z.boolean().optional().default(false).describe("Remove only this declared namespace before writing"),
  indexMedia: z.boolean().optional().default(true).describe("Request Android media indexing for media files"),
  files: z.array(sharedStorageFileSchema).min(1).describe("Files to stage into the namespace"),
})).superRefine((args, ctx) => {
  try {
    normalizeSharedStorageNamespace(args.namespace);
  } catch (error) {
    ctx.addIssue({
      code: "custom",
      message: error instanceof Error ? error.message : "namespace must be safe",
      path: ["namespace"],
    });
  }
});
