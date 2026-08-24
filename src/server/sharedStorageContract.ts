import { z } from "zod/v4";
import { addDeviceTargetingToSchema } from "./toolSchemaHelpers";
import type { Platform } from "../models";
import { normalizeAppFileRelativePath } from "./appFileContract";

export interface SharedStorageFile {
  destinationPath: string;
  sourcePath?: string;
  contentText?: string;
  contentBase64?: string;
  mimeType?: string;
}

export interface StageSharedStorageArgs {
  namespace: string;
  files: SharedStorageFile[];
  reset?: boolean;
  platform?: Platform;
  deviceId?: string;
  device?: string;
  sessionUuid?: string;
  keepScreenAwake?: boolean;
}

export interface StagedSharedStorageFile {
  destinationPath: string;
  devicePath: string;
  byteCount: number;
  indexing: "notRequested" | "verified" | "dispatched" | "failed";
  indexingReason?: string;
}

export interface StageSharedStorageResult {
  success: true;
  deviceId: string;
  platform: "android";
  namespace: string;
  root: string;
  reset: boolean;
  files: StagedSharedStorageFile[];
}

const sourceCount = (file: SharedStorageFile): number =>
  [file.sourcePath, file.contentText, file.contentBase64].filter((value) => value !== undefined)
    .length;

function isValidBase64(value: string): boolean {
  const decoded = Buffer.from(value, "base64");
  const canonical = decoded.toString("base64");
  return decoded.length > 0 && (value === canonical || value === canonical.replace(/=+$/, ""));
}

export function normalizeSharedStorageNamespace(namespace: string): string {
  const normalized = namespace.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(normalized)) {
    throw new Error("namespace must be 1-64 characters using letters, numbers, '_' or '-'");
  }
  return normalized;
}

export const stageSharedStorageSchema = addDeviceTargetingToSchema(
  z.object({
    platform: z.literal("android").default("android"),
    namespace: z.string().describe("Isolated fixture namespace beneath Download/AutoMobile"),
    reset: z
      .boolean()
      .optional()
      .default(false)
      .describe("Delete only this namespace before writing"),
    files: z
      .array(
        z.object({
          destinationPath: z.string().describe("Relative path within the namespace"),
          sourcePath: z.string().min(1).optional().describe("Host file path"),
          contentText: z.string().optional().describe("UTF-8 content"),
          contentBase64: z.string().optional().describe("Base64 content"),
          mimeType: z.string().min(1).optional().describe("Optional MIME type for media indexing"),
        }),
      )
      .min(1)
      .max(100),
  }),
).superRefine((args, ctx) => {
  try {
    normalizeSharedStorageNamespace(args.namespace);
  } catch (error) {
    ctx.addIssue({
      code: "custom",
      path: ["namespace"],
      message: error instanceof Error ? error.message : "Invalid namespace",
    });
  }
  const destinations = new Set<string>();
  args.files.forEach((file, index) => {
    if (sourceCount(file) !== 1) {
      ctx.addIssue({
        code: "custom",
        path: ["files", index],
        message: "Provide exactly one content source: sourcePath, contentText, or contentBase64.",
      });
    }
    try {
      const normalized = normalizeAppFileRelativePath(file.destinationPath);
      if (destinations.has(normalized)) {
        ctx.addIssue({
          code: "custom",
          path: ["files", index, "destinationPath"],
          message: "Duplicate destinationPath.",
        });
      }
      if (file.contentBase64 !== undefined && !isValidBase64(file.contentBase64)) {
        ctx.addIssue({
          code: "custom",
          path: ["files", index, "contentBase64"],
          message: "contentBase64 must be valid, non-empty base64.",
        });
      }
      destinations.add(normalized);
    } catch (error) {
      ctx.addIssue({
        code: "custom",
        path: ["files", index, "destinationPath"],
        message:
          error instanceof Error ? error.message : "destinationPath must be a safe relative path",
      });
    }
  });
});
