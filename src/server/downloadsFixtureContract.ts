import { z } from "zod/v4";
import { withJsonSchemaOverride } from "./toolSchemaHelpers";
import {
  normalizeSharedStorageNamespace,
  sharedStorageFileSchema,
  type SharedStorageFileInput,
  type SharedStorageIndexingResult,
  type StagedSharedStorageFile,
} from "./sharedStorageContract";

/**
 * A session-scoped Downloads-fixture staging request. Unlike the
 * device-targeted `stageSharedStorage` tool, every operation is bound to the
 * caller's live device session (`sessionUuid`) and refuses before any device
 * access when that session is missing or no longer owns a device, exactly like
 * the session-log family (#7006).
 */
export interface StageSessionDownloadsArgs {
  sessionUuid: string;
  directory: string;
  reset?: boolean;
  indexMedia?: boolean;
  files: SharedStorageFileInput[];
}

/** A refusal the client sees before any device is touched. */
export type StageSessionDownloadsRefusalCode = "SESSION_NOT_BOUND" | "SESSION_NOT_ACTIVE";

export interface StageSessionDownloadsSuccess {
  success: true;
  sessionUuid: string;
  deviceId: string;
  platform: "android";
  directory: string;
  userId: number;
  userSource: "explicit" | "currentUser" | "foregroundPackage" | "managedProfile" | "primary";
  destinationDirectory: string;
  reset: boolean;
  files: StagedSharedStorageFile[];
}

export interface StageSessionDownloadsUnavailable {
  success: false;
  sessionUuid: string;
  deviceId: string;
  platform: "ios";
  status: "unavailable";
  reason: string;
}

export type StageSessionDownloadsResult =
  | StageSessionDownloadsSuccess
  | StageSessionDownloadsUnavailable;

export type { SharedStorageIndexingResult, StagedSharedStorageFile };

// JSON-Schema patterns that advertise the runtime path/source refinements to
// clients generating calls from `tools/list`. Without them the served schema
// only drops the defaulted keys from `required` and still accepts traversal
// directories, absolute/`..` destination paths, files with zero or multiple
// content sources, and malformed base64 — all of which the zod superRefine
// rejects at runtime. Mirroring the constraints here turns those avoidable
// runtime failures into up-front schema rejections.
//
// A single directory segment: non-empty, not `.`/`..`, no `/`, `\\` or NUL.
const DIRECTORY_JSON_SCHEMA_PATTERN = "^(?!\\.\\.?$)[^/\\\\\\u0000]+$";
// A relative destination path: not absolute and with no `.`/`..` segment
// (either separator). Slightly stricter than the runtime, which also tolerates
// a leading `./`; advertising it as invalid only avoids a call, never a failure.
const RELATIVE_PATH_JSON_SCHEMA_PATTERN = "^(?![/\\\\])(?!.*(?:^|[/\\\\])\\.{1,2}(?:[/\\\\]|$)).+$";
// Non-empty base64 in the standard alphabet with optional `=` padding.
const BASE64_JSON_SCHEMA_PATTERN = "^[A-Za-z0-9+/]+={0,2}$";

export const stageSessionDownloadsSchema = withJsonSchemaOverride(
  z
    .object({
      sessionUuid: z
        .string()
        .min(1)
        .describe("Live device session that owns the target Android device"),
      directory: z
        .string()
        .describe("One caller-named child directory beneath the device's shared Downloads tree"),
      reset: z
        .boolean()
        .optional()
        .default(false)
        .describe("Remove only this declared directory before writing"),
      indexMedia: z
        .boolean()
        .optional()
        .default(true)
        .describe("Request Android media indexing for media files"),
      files: z
        .array(sharedStorageFileSchema)
        .min(1)
        .describe("Files to stage into the declared Downloads directory"),
    })
    .superRefine((args, ctx) => {
      try {
        normalizeSharedStorageNamespace(args.directory);
      } catch (error) {
        ctx.addIssue({
          code: "custom",
          message: error instanceof Error ? error.message : "directory must be safe",
          path: ["directory"],
        });
      }
    }),
  (jsonSchema) => {
    if (Array.isArray(jsonSchema.required)) {
      jsonSchema.required = jsonSchema.required.filter(
        (field) => field !== "reset" && field !== "indexMedia",
      );
    }
    const properties = jsonSchema.properties as Record<string, unknown> | undefined;
    if (!properties) {
      return;
    }
    const directory = properties.directory as Record<string, unknown> | undefined;
    if (directory) {
      directory.pattern = DIRECTORY_JSON_SCHEMA_PATTERN;
    }
    const files = properties.files as Record<string, unknown> | undefined;
    const item = files?.items as Record<string, unknown> | undefined;
    if (item) {
      // Mirror putAppFileSchema's exact-one-source oneOf so the served schema
      // rejects both zero and multiple content sources, not only the runtime
      // superRefine.
      item.oneOf = [
        { required: ["sourcePath"] },
        { required: ["contentText"] },
        { required: ["contentBase64"] },
      ];
      const itemProperties = item.properties as Record<string, unknown> | undefined;
      const destinationPath = itemProperties?.destinationPath as
        | Record<string, unknown>
        | undefined;
      if (destinationPath) {
        destinationPath.pattern = RELATIVE_PATH_JSON_SCHEMA_PATTERN;
      }
      const contentBase64 = itemProperties?.contentBase64 as Record<string, unknown> | undefined;
      if (contentBase64) {
        contentBase64.pattern = BASE64_JSON_SCHEMA_PATTERN;
        contentBase64.minLength = 1;
      }
    }
  },
);
