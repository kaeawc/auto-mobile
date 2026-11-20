import * as fs from "fs/promises";
import { preflightCtrlProxyApkOverride } from "../ctrlProxy/ctrlProxyApkOverride";
import type { DeviceToolsDependencies } from "../features/deviceLifecycle/core/dependencies";
import type { Platform } from "../models";

/** Android acquisitions refuse an unusable AUTOMOBILE_CTRL_PROXY_APK_PATH before booting (#18823). */
export async function preflightAndroidCtrlProxyApkOverride(
  platform: Platform,
  deps: Pick<DeviceToolsDependencies, "env" | "ctrlProxyApkOverrideStat">,
): Promise<void> {
  if (platform === "android") {
    await preflightCtrlProxyApkOverride(
      deps.env ?? process.env,
      deps.ctrlProxyApkOverrideStat ?? fs.stat,
    );
  }
}
