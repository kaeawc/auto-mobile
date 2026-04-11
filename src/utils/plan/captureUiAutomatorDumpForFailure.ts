import type { BootedDevice } from "../../models";
import { defaultAdbClientFactory } from "../android-cmdline-tools/AdbClientFactory";
import { logger } from "../logger";
import { throwIfAborted } from "../toolUtils";

const UI_AUTOMATOR_DUMP_MAX_CHARS = 400_000;

/**
 * Raw window hierarchy XML from `uiautomator dump` (Android), for comparing with CtrlProxy
 * snapshots when an observe waitFor times out.
 */
export async function captureUiAutomatorDumpForFailure(
  deviceId: string,
  signal?: AbortSignal
): Promise<string | undefined> {
  throwIfAborted(signal);
  try {
    const device: BootedDevice = {
      name: deviceId,
      platform: "android",
      deviceId
    };
    const adb = defaultAdbClientFactory.create(device);
    const { stdout } = await adb.executeCommand(
      "shell uiautomator dump /dev/tty",
      undefined,
      undefined,
      undefined,
      signal
    );
    const xml = stdout?.trim();
    if (!xml || !xml.includes("<")) {
      return undefined;
    }
    if (xml.length > UI_AUTOMATOR_DUMP_MAX_CHARS) {
      return `${xml.slice(0, UI_AUTOMATOR_DUMP_MAX_CHARS)}\n<!-- truncated -->`;
    }
    return xml;
  } catch (error) {
    logger.warn(
      `[captureUiAutomatorDumpForFailure] device=${deviceId}: ${error instanceof Error ? error.message : String(error)}`
    );
    return undefined;
  }
}
