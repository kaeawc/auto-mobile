import { ActionableError } from "../../models";
import { errorMessage } from "../../utils/describeUnknownError";
import {
  DefaultHostCommandExecutor,
  type HostCommandExecutor,
} from "../../utils/HostCommandExecutor";
import type { CaptureDeviceInfo, CaptureDeviceLister } from "./IosPhysicalVideoCaptureBackend";

/**
 * Production {@link CaptureDeviceLister}: runs the helper's `--list-devices`
 * mode, which prints the JSON device list to stdout and exits.
 */
export class HelperCaptureDeviceLister implements CaptureDeviceLister {
  constructor(
    private readonly executor: HostCommandExecutor = new DefaultHostCommandExecutor(),
    private readonly timeoutMs: number = 15000,
  ) {}

  async list(binaryPath: string, signal?: AbortSignal): Promise<CaptureDeviceInfo[]> {
    const result = await this.executor.executeCommand(binaryPath, ["--list-devices"], {
      timeoutMs: this.timeoutMs,
      signal,
    });
    return parseCaptureDeviceList(result.stdout);
  }
}

/** Parse the `--list-devices` envelope, tolerating a helper that lists nothing. */
export function parseCaptureDeviceList(stdout: string): CaptureDeviceInfo[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    throw new ActionableError(
      `screen-capture-helper --list-devices returned unparseable output: ${errorMessage(error)}`,
    );
  }
  const devices = (parsed as { devices?: unknown } | null)?.devices;
  if (!Array.isArray(devices)) {
    throw new ActionableError(
      "screen-capture-helper --list-devices returned no `devices` array; the helper may be out of date.",
    );
  }
  return devices
    .map((entry) => entry as Partial<CaptureDeviceInfo> | null)
    .filter(
      (entry): entry is Partial<CaptureDeviceInfo> & { uniqueID: string } =>
        typeof entry?.uniqueID === "string" && entry.uniqueID.length > 0,
    )
    .map((entry) => ({
      uniqueID: entry.uniqueID,
      localizedName: entry.localizedName ?? entry.uniqueID,
      modelID: entry.modelID ?? "",
      manufacturer: entry.manufacturer ?? "",
    }));
}
