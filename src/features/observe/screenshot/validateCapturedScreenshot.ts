import type { ScreenshotResult } from "../../../models/ScreenshotResult";
import { ActionableError } from "../../../models/ActionableError";
import { pathExists } from "../../../utils/filesystem/DefaultFileSystem";

/** Validate a captured screenshot path before exposing it as observation evidence. */
export async function validateCapturedScreenshot(
  result: ScreenshotResult,
  deviceId: string,
  exists: (path: string) => Promise<boolean> = pathExists,
): Promise<string> {
  if (!result.success) {
    throw new ActionableError(
      `Screenshot capture failed for device ${deviceId}: ${result.error ?? "no error details"}`,
    );
  }
  if (!result.path) {
    throw new ActionableError(
      `Screenshot capture succeeded for device ${deviceId} but returned no file path.`,
    );
  }
  if (!(await exists(result.path))) {
    throw new ActionableError(
      `Screenshot capture succeeded for device ${deviceId} but the file is missing: ${result.path}`,
    );
  }
  return result.path;
}
