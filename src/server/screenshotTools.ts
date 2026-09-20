import { z } from "zod/v4";
import { TakeScreenshot, type ScreenshotOptions } from "../features/observe/TakeScreenshot";
import type { BootedDevice } from "../models";
import { ActionableError, toActionableError } from "../models/ActionableError";
import type { ScreenshotJobHandle, ScreenshotJobOptions } from "../utils/ScreenshotJobTracker";
import { pathExists } from "../utils/filesystem/DefaultFileSystem";
import { createStructuredToolResponse } from "../utils/toolUtils";
import { addDeviceTargetingToSchema } from "./toolSchemaHelpers";
import { captureScreenshotResultSchema } from "./toolOutputSchemas";
import { ToolRegistry, type ProgressCallback } from "./toolRegistry";

export const captureScreenshotSchema = addDeviceTargetingToSchema(z.object({}));

export type CaptureScreenshotArgs = z.infer<typeof captureScreenshotSchema>;

export interface TrackedScreenshotService {
  startTrackedCapture(
    options?: ScreenshotOptions,
    trackerOptions?: ScreenshotJobOptions,
  ): ScreenshotJobHandle;
}

export interface ScreenshotToolsDependencies {
  createScreenshotService(device: BootedDevice): TrackedScreenshotService;
  pathExists(filePath: string): Promise<boolean>;
}

const defaultScreenshotToolsDependencies: ScreenshotToolsDependencies = {
  createScreenshotService: (device) => new TakeScreenshot(device),
  pathExists,
};

export function createCaptureScreenshotHandler(
  dependencies: ScreenshotToolsDependencies = defaultScreenshotToolsDependencies,
) {
  return async (
    device: BootedDevice,
    _args: CaptureScreenshotArgs,
    _progress?: ProgressCallback,
    signal?: AbortSignal,
  ) => {
    try {
      const screenshotService = dependencies.createScreenshotService(device);
      const { promise } = screenshotService.startTrackedCapture(
        { format: "png" },
        { parentSignal: signal, queueAfterPending: true },
      );
      const result = await promise;

      if (!result.success) {
        throw new ActionableError(
          `Screenshot capture failed for device ${device.deviceId}: ${result.error ?? "no error details"}`,
        );
      }
      if (!result.path) {
        throw new ActionableError(
          `Screenshot capture succeeded for device ${device.deviceId} but returned no file path.`,
        );
      }
      if (!(await dependencies.pathExists(result.path))) {
        throw new ActionableError(
          `Screenshot capture succeeded for device ${device.deviceId} but the file is missing: ${result.path}`,
        );
      }

      return createStructuredToolResponse({
        success: true,
        deviceId: device.deviceId,
        platform: device.platform,
        path: result.path,
        screenshotFormat: "png" as const,
        screenshotMimeType: "image/png" as const,
      });
    } catch (error) {
      throw toActionableError(error, `Failed to capture screenshot for device ${device.deviceId}`);
    }
  };
}

export function registerScreenshotTools(
  dependencies: ScreenshotToolsDependencies = defaultScreenshotToolsDependencies,
): void {
  ToolRegistry.registerDeviceAware(
    "captureScreenshot",
    "Capture the entire selected device screen as a PNG file.",
    captureScreenshotSchema,
    createCaptureScreenshotHandler(dependencies),
    { defaultEnabled: true, outputSchema: captureScreenshotResultSchema },
  );
}
