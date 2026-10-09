import { writeRetainedScreenshot } from "../features/observe/ScreenshotRetention";
import type { FileSystem } from "../utils/filesystem/DefaultFileSystem";
import {
  screenshotPathProtection,
  type ScreenshotPathProtection,
} from "../features/observe/ScreenshotPathProtection";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod/v4";
import { ActionableError, toActionableError } from "../models/ActionableError";
import type { BootedDevice } from "../models";
import type { ElementBounds } from "../models/ElementBounds";
import { createDeviceHierarchyCapture } from "../features/observe/DeviceHierarchyCapture";
import type { HierarchyCapture } from "../features/observe/HierarchyCapture";
import { TakeScreenshot } from "../features/observe/TakeScreenshot";
import type { ScreenshotService } from "../features/observe/interfaces/ScreenshotService";
import { type ScreenshotFileWriter } from "../features/observe/screenshot/ScreenshotFileWriter";
import { cropSnapshot } from "../features/observe/screenshot/snapshotCrop";
import { ElementResolver } from "../features/utility/ElementResolver";
import { resolveImageBackend } from "../utils/image/backend/resolveImageBackend";
import type { ImageBackend } from "../utils/image/backend/ImageBackend";
import { defaultIdGenerator, type IdGenerator } from "../utils/IdGenerator";
import { ensureSecureTempDirSync, TEMP_SUBDIRS } from "../utils/tempDir";
import { createJSONToolResponse } from "../utils/toolUtils";
import { ToolRegistry } from "./toolRegistry";
import { isSessionlessDeviceRead } from "../features/toolSelection/toolSelectionContext";
import { addDeviceTargetingToSchema, platformSchema } from "./toolSchemaHelpers";

const finite = z.number().finite();
const rectangleSchema = z
  .object({
    left: finite,
    top: finite,
    right: finite,
    bottom: finite,
  })
  .strict();

export const snapshotOfSchema = addDeviceTargetingToSchema(
  z
    .object({
      platform: platformSchema.optional(),
      elementId: z.string().min(1).optional().describe("Unique exposed element ID"),
      rectangle: rectangleSchema
        .optional()
        .describe("Platform-native screen rectangle: Android pixels, iOS points"),
    })
    .strict(),
).superRefine((value, ctx) => {
  if ((value.elementId === undefined) === (value.rectangle === undefined)) {
    ctx.addIssue({ code: "custom", message: "Provide exactly one of elementId or rectangle" });
  }
});

export type SnapshotOfArgs = z.infer<typeof snapshotOfSchema>;

export interface SnapshotOfDependencies {
  hierarchyCaptureFactory?: (device: BootedDevice) => HierarchyCapture;
  screenshotFactory?: (device: BootedDevice) => Pick<ScreenshotService, "execute">;
  readFile?: (filePath: string) => Promise<Buffer>;
  writer?: ScreenshotFileWriter;
  pathProtection?: ScreenshotPathProtection;
  imageBackend?: ImageBackend;
  outputDirectory?: () => string;
  ids?: IdGenerator;
  fileSystem?: FileSystem;
}

function resolveRequestedBounds(
  args: SnapshotOfArgs,
  snapshot: Awaited<ReturnType<HierarchyCapture["capture"]>>,
): ElementBounds {
  if (args.rectangle) {
    return args.rectangle;
  }
  const resolution = new ElementResolver().resolve(
    { id: snapshot.captureId, nodes: snapshot.nodes },
    { elementId: args.elementId },
    { action: "inspect", requireBounds: true },
  );
  if (resolution.error) {
    throw new ActionableError(resolution.error);
  }
  if (resolution.candidates.length !== 1 || !resolution.chosen?.bounds) {
    throw new ActionableError(
      resolution.candidates.length === 0
        ? `snapshotOf element '${args.elementId}' was not found with bounds`
        : `snapshotOf element '${args.elementId}' is ambiguous (${resolution.candidates.length} matches)`,
    );
  }
  return resolution.chosen.bounds;
}

export function registerSnapshotOfTools(dependencies: SnapshotOfDependencies = {}): void {
  ToolRegistry.registerDeviceAware(
    "snapshotOf",
    "Save a PNG crop of one exposed element or a platform-native screen rectangle; return path and geometry metadata only.",
    snapshotOfSchema,
    // oxlint-disable-next-line complexity -- acquisition, injected seams, and metadata publication share one operation boundary.
    async (device: BootedDevice, args: SnapshotOfArgs) => {
      try {
        const capture =
          dependencies.hierarchyCaptureFactory?.(device) ?? createDeviceHierarchyCapture(device);
        // A watcher's read (#10830) uses the isolated observer capture: on a held device it only
        // connects to the running hierarchy service and leaves the holder's client untouched.
        const snapshot = await capture.capture({
          freshness: "fresh",
          ...(isSessionlessDeviceRead() ? { observerMode: true } : {}),
        });
        const screenSize = {
          width: snapshot.hierarchy.screenWidth,
          height: snapshot.hierarchy.screenHeight,
        };
        if (!screenSize.width || !screenSize.height) {
          throw new ActionableError("snapshotOf requires screen dimensions from a fresh hierarchy");
        }
        const requestedBounds = resolveRequestedBounds(args, snapshot);
        const screenshot = await (
          dependencies.screenshotFactory?.(device) ?? new TakeScreenshot(device)
        ).execute({ format: "png" });
        if (screenshot.actionableError) {
          throw screenshot.actionableError;
        }
        if (!screenshot.success || !screenshot.path) {
          throw new ActionableError(
            `snapshotOf screenshot capture failed: ${screenshot.error ?? "no path"}`,
          );
        }
        const source = await (dependencies.readFile ?? fs.readFile)(screenshot.path);
        const cropped = await cropSnapshot(
          source,
          requestedBounds,
          {
            platform: device.platform,
            screenSize: { width: screenSize.width, height: screenSize.height },
            rotation: snapshot.hierarchy.rotation,
            nativeScale: snapshot.hierarchy.nativeScale,
          },
          dependencies.imageBackend ?? resolveImageBackend(),
        );
        const outputDirectory =
          dependencies.outputDirectory?.() ?? ensureSecureTempDirSync(TEMP_SUBDIRS.SCREENSHOTS);
        const outputPath = path.join(
          outputDirectory,
          `snapshot-of-${(dependencies.ids ?? defaultIdGenerator).next()}.png`,
        );
        const protection = dependencies.pathProtection ?? screenshotPathProtection;
        await writeRetainedScreenshot(outputPath, cropped.png, dependencies);
        const expiresAt = await protection.protect(outputPath);
        return createJSONToolResponse({
          path: outputPath,
          expiresAt,
          unit: device.platform === "ios" ? "points" : "pixels",
          requestedBounds: cropped.requestedBounds,
          clippedBounds: cropped.clippedBounds,
          screenSize: cropped.screenSize,
          imageSize: cropped.imageSize,
          pixelsPerNativeUnit: cropped.pixelsPerNativeUnit,
          scaleProvenance: cropped.scaleProvenance,
          clipped: cropped.clipped,
          rasterBounds: cropped.rasterBounds,
          screenshotOrientation: cropped.screenshotOrientation,
        });
      } catch (error) {
        throw toActionableError(error, "Failed to create snapshotOf crop");
      }
    },
    {
      defaultEnabled: false,
      // A crop of a fresh capture; a non-holder watches a held device read-only (#10830).
      deviceReadOnly: true,
    },
  );
}
