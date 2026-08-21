import { z } from "zod/v4";
import { addDeviceTargetingToSchema, withAppIdAliases } from "./toolSchemaHelpers";
import type { Platform } from "../models";

export const APP_FILE_CONTAINERS = [
  "documents",
  "library",
  "cache",
  "tmp",
  "externalFiles",
] as const;

export type AppFileContainer = typeof APP_FILE_CONTAINERS[number];

export const APP_FILE_RESOURCE_TEMPLATES = {
  CONTAINER: "automobile:devices/{deviceId}/apps/{appId}/files/{container}",
  FILE: "automobile:devices/{deviceId}/apps/{appId}/files/{container}/{path}",
} as const;

export interface AppFileResourceParts {
  deviceId: string;
  appId: string;
  container: AppFileContainer;
  path?: string;
}

export interface PutAppFileArgs {
  appId: string;
  container: AppFileContainer;
  destinationPath: string;
  sourcePath?: string;
  contentText?: string;
  contentBase64?: string;
  platform?: Platform;
  deviceId?: string;
  device?: string;
  sessionUuid?: string;
  keepScreenAwake?: boolean;
}

export interface PutAppFileResult {
  success: true;
  deviceId: string;
  platform: Platform;
  appId: string;
  container: AppFileContainer;
  destinationPath: string;
  byteCount: number;
  resourceUri: string;
}

export interface AppFileListRequest {
  deviceId: string;
  appId: string;
  container: AppFileContainer;
}

export interface AppFileListEntry {
  path: string;
  name?: string;
  byteCount?: number;
  isDirectory?: boolean;
  lastModified?: string;
  resourceUri: string;
}

export interface AppFileListResult {
  deviceId: string;
  platform: Platform;
  appId: string;
  container: AppFileContainer;
  files: AppFileListEntry[];
}

export interface AppFileReadRequest extends AppFileListRequest {
  path: string;
}

export interface AppFileReadResult {
  deviceId: string;
  platform: Platform;
  appId: string;
  container: AppFileContainer;
  path: string;
  byteCount: number;
  mimeType: string;
  text?: string;
  blob?: string;
}

const appFileContainerSchema = z.enum(APP_FILE_CONTAINERS);

function countDefined(values: unknown[]): number {
  return values.filter(value => value !== undefined).length;
}

export function normalizeAppFileRelativePath(path: string): string {
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

const putAppFileBaseSchema = z.object({
  appId: z.string().min(1),
  container: appFileContainerSchema.describe("App container"),
  sourcePath: z.string().min(1).optional().describe("Host file path"),
  contentText: z.string().optional().describe("UTF-8 content"),
  contentBase64: z.string().optional().describe("Base64 content"),
  destinationPath: z.string().describe("Container-relative destination path"),
});

export const putAppFileSchema = withAppIdAliases(
  addDeviceTargetingToSchema(putAppFileBaseSchema).superRefine((args, ctx) => {
  if (countDefined([args.sourcePath, args.contentText, args.contentBase64]) !== 1) {
    ctx.addIssue({
      code: "custom",
      message: "Provide exactly one content source: sourcePath, contentText, or contentBase64.",
      path: ["sourcePath"],
    });
  }

  try {
    normalizeAppFileRelativePath(args.destinationPath);
  } catch (error) {
    ctx.addIssue({
      code: "custom",
      message: error instanceof Error ? error.message : "destinationPath must be a safe relative path",
      path: ["destinationPath"],
    });
  }

  if (args.contentBase64 !== undefined) {
    try {
      const decoded = Buffer.from(args.contentBase64, "base64");
      const canonical = decoded.toString("base64");
      const unpadded = canonical.replace(/=+$/, "");
      if (args.contentBase64 !== canonical && args.contentBase64 !== unpadded) {
        throw new Error("round-trip mismatch");
      }
      // An empty ("") or all-padding ("====") payload round-trips cleanly but
      // decodes to zero bytes, silently writing an empty file to the device.
      // Reject it so the caller must send real content (#4183 A4).
      if (decoded.length === 0) {
        throw new Error("empty payload");
      }
    } catch {
      ctx.addIssue({
        code: "custom",
        message: "contentBase64 must be valid, non-empty base64.",
        path: ["contentBase64"],
      });
    }
  }
  })
);

function encodePathSegments(path: string): string {
  return normalizeAppFileRelativePath(path)
    .split("/")
    .map(segment => encodeURIComponent(segment))
    .join("/");
}

export function buildAppFileResourceUri(parts: AppFileResourceParts): string {
  const base = `automobile:devices/${encodeURIComponent(parts.deviceId)}` +
    `/apps/${encodeURIComponent(parts.appId)}` +
    `/files/${encodeURIComponent(parts.container)}`;
  return parts.path === undefined ? base : `${base}/${encodePathSegments(parts.path)}`;
}

export function parseAppFileResourceParams(params: Record<string, string>): AppFileResourceParts {
  const container = decodeURIComponent(params.container);
  if (!APP_FILE_CONTAINERS.includes(container as AppFileContainer)) {
    throw new Error(`Unsupported app file container: ${container}`);
  }

  return {
    deviceId: decodeURIComponent(params.deviceId),
    appId: decodeURIComponent(params.appId),
    container: container as AppFileContainer,
    ...(params.path !== undefined ? { path: normalizeAppFileRelativePath(decodeURIComponent(params.path)) } : {}),
  };
}
