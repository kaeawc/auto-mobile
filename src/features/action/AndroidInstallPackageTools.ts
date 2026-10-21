import type { AndroidBuildToolsLocator } from "../../utils/android-cmdline-tools/AndroidBuildToolsLocator";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { OPERATION_CANCELLED_MESSAGE } from "../../utils/constants";
import { errorMessage } from "../../utils/describeUnknownError";
import type { HostCommandExecutor } from "../../utils/HostCommandExecutor";
import { logger } from "../../utils/logger";
import { shellQuote } from "../../utils/shellQuote";
import { ANDROID_PACKAGE_TRANSFER_TIMEOUT_MS } from "./installAppTimeout";
/** Android package metadata and per-user inventory commands used during install recovery. */
export class AndroidInstallPackageTools {
  constructor(
    private readonly adb: AdbExecutor,
    private readonly buildToolsLocator: AndroidBuildToolsLocator,
    private readonly hostExecutor: HostCommandExecutor,
  ) {}
  /**
   * Fully uninstall an Android package so a lower-versioned artifact can be
   * installed over a newer one. The uninstall is package-wide (not per-user)
   * because the installed APK version is shared across users.
   */
  async uninstallAndroidForDowngrade(
    packageName: string,
    userId: number,
    signal?: AbortSignal,
  ): Promise<void> {
    try {
      await this.adb.executeCommand(
        `shell am force-stop --user ${userId} ${shellQuote(packageName)}`,
        { noRetry: true, signal },
      );
    } catch (error) {
      // Force-stop is best-effort; uninstall can still remove a package that is not running.
      logger.debug(
        `[InstallApp] Could not stop package before downgrade: ${errorMessage(error)}`,
        error,
      );
    }
    await this.adb.executeCommand(`uninstall ${packageName}`, {
      timeoutMs: ANDROID_PACKAGE_TRANSFER_TIMEOUT_MS,
      signal,
    });
  }

  async extractPackageName(
    apkPath: string,
    signal?: AbortSignal,
  ): Promise<{ packageName?: string; warning?: string }> {
    if (signal?.aborted) {
      throw new Error(OPERATION_CANCELLED_MESSAGE);
    }

    const tool = await this.buildToolsLocator.findAaptTool();
    if (!tool) {
      return {
        warning:
          "aapt2 was not found. Install Android SDK build-tools (aapt2) for reliable package detection.",
      };
    }

    const result = await this.hostExecutor.executeCommand(tool.path, ["dump", "badging", apkPath], {
      signal,
    });
    const output = `${result.stdout}\n${result.stderr}`;
    const match = output.match(/^package:\s+name='([^']+)'(?:\s|$)/m);
    if (!match) {
      throw new Error(`Failed to extract package name from ${tool.tool} output.`);
    }

    return { packageName: match[1] };
  }

  async listPackagesForUser(userId: number, signal?: AbortSignal): Promise<Set<string>> {
    if (signal?.aborted) {
      throw new Error(OPERATION_CANCELLED_MESSAGE);
    }

    const result = await this.adb.executeCommand(`shell pm list packages --user ${userId}`, {
      noRetry: true,
      signal,
    });
    const packages = new Set<string>();
    for (const line of result.stdout.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("package:")) {
        continue;
      }
      const packageName = trimmed.slice("package:".length).trim();
      if (packageName) {
        packages.add(packageName);
      }
    }

    return packages;
  }
}
