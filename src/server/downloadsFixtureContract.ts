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
  },
);
