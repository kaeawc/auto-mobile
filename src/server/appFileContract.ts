import { extname } from "node:path";
import { z } from "zod/v4";
import {
  addDeviceTargetingToSchema,
  appIdFieldAliases,
  withAppIdAliases,
  withJsonSchemaOverride,
} from "./toolSchemaHelpers";
import type { Platform } from "../models";

export const APP_FILE_CONTAINERS = [
  "documents",
  "library",
  "cache",
  "tmp",
  "externalFiles",
] as const;

export type AppFileContainer = (typeof APP_FILE_CONTAINERS)[number];

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

export type StorageDomain = "app_containers" | "user_files" | "media_library";

const MEDIA_LIBRARY_EXTENSION_NAMES = [
  "aac",
  "aiff",
  "avif",
  "bmp",
  "flac",
  "gif",
  "heic",
  "jpeg",
  "jpg",
  "m4a",
  "mkv",
  "mov",
  "mp4",
  "m4v",
  "mp3",
  "ogg",
  "png",
  "tif",
  "tiff",
  "wav",
  "webm",
  "webp",
] as const;

const MEDIA_LIBRARY_EXTENSIONS = new Set<string>(MEDIA_LIBRARY_EXTENSION_NAMES);
const MEDIA_LIBRARY_EXTENSION_PATTERN = `\\.(?:${MEDIA_LIBRARY_EXTENSION_NAMES.map((extension) =>
  extension
    .split("")
    .map((character) =>
      character >= "a" && character <= "z" ? `[${character}${character.toUpperCase()}]` : character,
    )
    .join(""),
).join("|")})$`;

const SIMULATOR_MEDIA_EXTENSIONS = new Set([
  "avif",
  "bmp",
  "gif",
  "heic",
  "jpeg",
  "jpg",
  "mov",
  "mp4",
  "m4v",
  "png",
  "tif",
  "tiff",
  "webp",
]);

function extensionFor(path: string): string | undefined {
  const extension = extname(path);
  return extension.length > 1 ? extension.slice(1).toLowerCase() : undefined;
}

export function hasSupportedMediaLibraryExtension(path: string): boolean {
  const extension = extensionFor(path);
  return extension !== undefined && MEDIA_LIBRARY_EXTENSIONS.has(extension);
}

export function hasSupportedSimulatorMediaExtension(path: string): boolean {
  const extension = extensionFor(path);
  return extension !== undefined && SIMULATOR_MEDIA_EXTENSIONS.has(extension);
}

export interface AppContainersTarget {
  domain: "app_containers";
  appId: string;
  container: AppFileContainer;
}

export interface UserFilesTarget {
  domain: "user_files";
  namespace: string;
  reset?: boolean;
}

export interface MediaLibraryTarget {
  domain: "media_library";
}

export type PutAppFileTarget = AppContainersTarget | UserFilesTarget | MediaLibraryTarget;

export interface PutAppFileInput {
  destinationPath: string;
  sourcePath?: string;
  contentText?: string;
  contentBase64?: string;
}

export interface PutAppFileArgs {
  target: PutAppFileTarget;
  files: PutAppFileInput[];
  /** Internal compatibility marker populated by the legacy-shape preprocessor. */
  legacySingleFile?: boolean;
  platform?: Platform;
  deviceId?: string;
  device?: string;
  sessionUuid?: string;
  keepScreenAwake?: boolean;
}

/** The single-file app-container request accepted while callers migrate to {@link PutAppFileArgs}. */
export interface LegacyPutAppFileArgs {
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

export interface PutAppFileWriteEffect {
  type: string;
  status: "completed" | "notRequested" | "unavailable";
  reason?: string;
}

export interface PutAppFileWriteResult {
  destinationPath: string;
  byteCount: number;
  resourceUri?: string;
  effects: PutAppFileWriteEffect[];
}

export interface PutAppFileBatchResult {
  success: true;
  deviceId: string;
  platform: Platform;
  target: PutAppFileTarget;
  files: PutAppFileWriteResult[];
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
  return values.filter((value) => value !== undefined).length;
}

export function normalizeAppFileRelativePath(path: string): string {
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

/** A namespace is exactly one caller-named child directory, keeping reset scope bounded. */
export function normalizeUserFilesNamespace(namespace: string): string {
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

export function normalizePutAppFileTarget(target: PutAppFileTarget): PutAppFileTarget {
  switch (target.domain) {
    case "app_containers":
      return {
        domain: target.domain,
        appId: target.appId.trim(),
        container: target.container,
      };
    case "user_files":
      return {
        domain: target.domain,
        namespace: normalizeUserFilesNamespace(target.namespace),
        ...(target.reset === undefined ? {} : { reset: target.reset }),
      };
    case "media_library":
      return { domain: target.domain };
  }
}

const appContainersTargetSchema = z
  .object({
    domain: z.literal("app_containers"),
    appId: z.string().min(1),
    container: appFileContainerSchema.describe("App container"),
  })
  .strict();

const userFilesTargetSchema = z
  .object({
    domain: z.literal("user_files"),
    namespace: z.string().describe("One caller-named fixture namespace"),
    reset: z.boolean().optional().describe("Remove only this fixture namespace before writing"),
  })
  .strict()
  .superRefine((target, ctx) => {
    try {
      normalizeUserFilesNamespace(target.namespace);
    } catch (error) {
      ctx.addIssue({
        code: "custom",
        message: error instanceof Error ? error.message : "namespace must be safe",
        path: ["namespace"],
      });
    }
  });

const mediaLibraryTargetSchema = z.object({ domain: z.literal("media_library") }).strict();

const putAppFileInputSchema = z
  .object({
    sourcePath: z.string().min(1).optional().describe("Host file path"),
    contentText: z.string().optional().describe("UTF-8 content"),
    contentBase64: z.string().optional().describe("Base64 content"),
    destinationPath: z.string().describe("Safe path relative to the declared storage target"),
  })
  .strict()
  .superRefine((file, ctx) => {
    if (countDefined([file.sourcePath, file.contentText, file.contentBase64]) !== 1) {
      ctx.addIssue({
        code: "custom",
        message: "Provide exactly one content source: sourcePath, contentText, or contentBase64.",
        path: ["sourcePath"],
      });
    }

    try {
      normalizeAppFileRelativePath(file.destinationPath);
    } catch (error) {
      ctx.addIssue({
        code: "custom",
        message:
          error instanceof Error ? error.message : "destinationPath must be a safe relative path",
        path: ["destinationPath"],
      });
    }

    if (file.contentBase64 !== undefined) {
      try {
        const decoded = Buffer.from(file.contentBase64, "base64");
        const canonical = decoded.toString("base64");
        const unpadded = canonical.replace(/=+$/, "");
        if (file.contentBase64 !== canonical && file.contentBase64 !== unpadded) {
          throw new Error("round-trip mismatch");
        }
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
  });

const canonicalPutAppFileSchema = addDeviceTargetingToSchema(
  z
    .object({
      target: z.discriminatedUnion("domain", [
        appContainersTargetSchema,
        userFilesTargetSchema,
        mediaLibraryTargetSchema,
      ]),
      files: z.array(putAppFileInputSchema).min(1).describe("Files to write"),
      // This marker is populated only by the compatibility preprocessor and is
      // removed from the advertised schema below.
      legacySingleFile: z.literal(true).optional(),
    })
    .strict(),
).superRefine((args, ctx) => {
  if (args.target.domain !== "media_library") {
    return;
  }
  for (const [index, file] of args.files.entries()) {
    if (!hasSupportedMediaLibraryExtension(file.destinationPath)) {
      ctx.addIssue({
        code: "custom",
        message: "media_library destinationPath must end in a supported image or video extension.",
        path: ["files", index, "destinationPath"],
      });
    }
  }
});

function preprocessLegacyPutAppFileArgs(input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return input;
  }
  const args = input as Record<string, unknown>;
  if (args.target !== undefined) {
    // The marker is reserved for a legacy object that this preprocessor itself
    // converts. A canonical caller cannot select legacy response semantics.
    return args.legacySingleFile === undefined ? input : { ...args, legacySingleFile: false };
  }
  const appId =
    args.appId ??
    appIdFieldAliases.map((alias) => args[alias]).find((value) => value !== undefined);
  if (appId === undefined || args.container === undefined) {
    return input;
  }
  const { container, destinationPath, sourcePath, contentText, contentBase64, ...deviceArgs } =
    args;
  delete deviceArgs.appId;
  for (const alias of appIdFieldAliases) {
    delete deviceArgs[alias];
  }
  return {
    ...deviceArgs,
    target: { domain: "app_containers", appId, container },
    files: [{ destinationPath, sourcePath, contentText, contentBase64 }],
    legacySingleFile: true,
  };
}

export const putAppFileSchema = withJsonSchemaOverride(
  withAppIdAliases(z.preprocess(preprocessLegacyPutAppFileArgs, canonicalPutAppFileSchema)),
  (jsonSchema) => {
    const properties = jsonSchema.properties as Record<string, unknown> | undefined;
    if (properties) {
      delete properties.legacySingleFile;
      const target = properties.target as Record<string, unknown> | undefined;
      if (target && Array.isArray(target.anyOf)) {
        target.oneOf = target.anyOf;
        delete target.anyOf;
      }
      const files = properties.files as Record<string, unknown> | undefined;
      const file = files?.items as Record<string, unknown> | undefined;
      if (file) {
        file.oneOf = [
          { required: ["sourcePath"] },
          { required: ["contentText"] },
          { required: ["contentBase64"] },
        ];
      }

      jsonSchema.if = {
        properties: {
          target: {
            properties: { domain: { const: "media_library" } },
            required: ["domain"],
          },
        },
        required: ["target"],
      };
      jsonSchema.then = {
        properties: {
          files: {
            items: {
              properties: {
                destinationPath: { pattern: MEDIA_LIBRARY_EXTENSION_PATTERN },
              },
            },
          },
        },
      };
    }
    if (Array.isArray(jsonSchema.required)) {
      jsonSchema.required = jsonSchema.required.filter((field) => field !== "legacySingleFile");
    }
  },
);

function encodePathSegments(path: string): string {
  return normalizeAppFileRelativePath(path)
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

export function buildAppFileResourceUri(parts: AppFileResourceParts): string {
  const base =
    `automobile:devices/${encodeURIComponent(parts.deviceId)}` +
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
    ...(params.path !== undefined
      ? { path: normalizeAppFileRelativePath(decodeURIComponent(params.path)) }
      : {}),
  };
}
