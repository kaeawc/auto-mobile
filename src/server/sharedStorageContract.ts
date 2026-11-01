import type { Platform } from "../models";

export interface SharedStorageFileInput {
  destinationPath: string;
  sourcePath?: string;
  contentText?: string;
  contentBase64?: string;
}

export interface StageSharedStorageInput {
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
  userId: number;
  userSource: "explicit" | "currentUser" | "foregroundPackage" | "managedProfile" | "primary";
  destinationDirectory: string;
  reset: boolean;
  files: StagedSharedStorageFile[];
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
    throw new Error(
      "namespace must be a non-empty single directory name without path separators or traversal segments",
    );
  }
  return normalized;
}

export function normalizeSharedStorageRelativePath(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/^\.\/+/, "");
  const segments = normalized.split("/");
  if (
    normalized.length === 0 ||
    normalized.startsWith("/") ||
    normalized.includes("\0") ||
    segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw new Error(
      "destinationPath must be a non-empty relative path without '.' or '..' segments",
    );
  }
  return normalized;
}
