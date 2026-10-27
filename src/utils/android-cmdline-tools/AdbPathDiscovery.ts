import { logger } from "../logger";

import { ExecResult } from "../../models";
import {
  AndroidToolsDetectionAbortError,
  AndroidToolsDetectionTimeoutError,
  detectAndroidCommandLineTools,
  getBestAndroidToolsLocation,
} from "./detection";
import { resolveAndroidSdkRoot } from "./androidSdkRoot";

import { type AdbExecuteOptions } from "./interfaces/AdbExecutor";

import { Timer } from "../SystemTimer";

import type { SystemDetection } from "../system/SystemDetection";

import { AdbCommandTimeoutError } from "./AdbCommandTimeoutError";

export interface AdbPathDiscoveryContext {
  timer: Timer;
  execWithSignal(
    file: string,
    args: string[],
    maxBuffer?: number,
    timeoutMs?: number,
    signal?: AbortSignal,
    options?: Pick<AdbExecuteOptions, "waitForProcessSettlementAfterAbort" | "onStdout">,
  ): Promise<ExecResult>;
  systemDetectionFactory: () => SystemDetection;
  getAbortError(signal?: AbortSignal): Error;
}
export class AdbPathDiscovery {
  constructor(private readonly context: AdbPathDiscoveryContext) {}

  /**
   * Get fallback ADB path using environment variables and PATH
   */
  getFallbackAdbPath(): string {
    // Try environment variables
    const androidHome = resolveAndroidSdkRoot(process.env);
    if (androidHome) {
      return `${androidHome}/platform-tools/adb`;
    }

    // Final fallback to PATH
    return "adb";
  }

  /**
   * Get the ADB path asynchronously via detection
   */
  async getAdbPath(timeoutMs?: number, signal?: AbortSignal): Promise<string> {
    const deadlineMs = timeoutMs === undefined ? undefined : this.context.timer.now() + timeoutMs;
    // 1. Try environment variables first (fastest path)
    const envPath = this.getFallbackAdbPath();
    if (envPath !== "adb") {
      // We got a path from environment variables, verify it exists
      try {
        await this.executeAdbPathProbe(envPath, ["version"], deadlineMs, signal);
        logger.debug(`Using ADB from environment: ${envPath}`);
        return envPath;
      } catch (error) {
        this.throwIfAdbPathTimeout(error, signal);
        logger.debug(`ADB path from environment not working: ${envPath}`);
      }
    }

    // 2. Try to find via `which adb` (works in CI environments where adb is in PATH)
    try {
      const whichResult = await this.executeAdbPathProbe("which", ["adb"], deadlineMs, signal);
      const adbFromPath = whichResult.stdout.trim();
      if (adbFromPath) {
        logger.debug(`Found ADB via which: ${adbFromPath}`);
        return adbFromPath;
      }
    } catch (error) {
      this.throwIfAdbPathTimeout(error, signal);
      logger.debug("ADB not found via 'which adb'");
    }

    // 3. Try Android command line tools detection (slower, more comprehensive)
    try {
      const locations = await detectAndroidCommandLineTools(
        this.createDeadlineBoundSystemDetection(deadlineMs, signal),
      );
      const bestLocation = getBestAndroidToolsLocation(locations);

      if (bestLocation) {
        // For Homebrew installations, the platform-tools are in the SDK root directory
        if (bestLocation.source === "homebrew") {
          // /opt/homebrew/share/android-commandlinetools/cmdline-tools/latest -> /opt/homebrew/share/android-commandlinetools
          const sdkRoot = bestLocation.path.replace("/cmdline-tools/latest", "");
          return `${sdkRoot}/platform-tools/adb`;
        }

        // For standard installations, look in the parent SDK directory
        const sdkRoot = bestLocation.path.replace("/cmdline-tools/latest", "");
        return `${sdkRoot}/platform-tools/adb`;
      }
    } catch (error) {
      if (error instanceof AndroidToolsDetectionTimeoutError) {
        throw new AdbCommandTimeoutError(error.message);
      }
      if (error instanceof AndroidToolsDetectionAbortError) {
        throw error.abortError;
      }
      logger.debug(`Failed to detect ADB path via Android tools detection: ${error}`);
    }

    // 4. Final fallback - just use "adb" and hope it's in PATH
    logger.debug("Using fallback ADB path: adb");
    return "adb";
  }

  async executeAdbPathProbe(
    file: string,
    args: string[],
    deadlineMs: number | undefined,
    signal?: AbortSignal,
  ): Promise<ExecResult> {
    const timeoutMs = deadlineMs === undefined ? undefined : deadlineMs - this.context.timer.now();
    if (timeoutMs !== undefined && timeoutMs <= 0) {
      throw new AdbCommandTimeoutError(
        `Command timed out before ADB path discovery: ${file} ${args.join(" ")}`,
      );
    }
    return this.context.execWithSignal(file, args, undefined, timeoutMs, signal);
  }

  createDeadlineBoundSystemDetection(
    deadlineMs: number | undefined,
    signal?: AbortSignal,
  ): SystemDetection {
    const defaults = this.context.systemDetectionFactory();
    return {
      getCurrentPlatform: () => defaults.getCurrentPlatform(),
      getHomeDir: () => defaults.getHomeDir(),
      getEnvVar: (name) => defaults.getEnvVar(name),
      fileExistsSync: (path) => defaults.fileExistsSync(path),
      fileExists: (path) => this.executeDetectionFileProbe(defaults, path, deadlineMs, signal),
      executeCommand: async (file, args = []) => {
        try {
          return await this.executeAdbPathProbe(file, args, deadlineMs, signal);
        } catch (error) {
          if (error instanceof AdbCommandTimeoutError) {
            throw new AndroidToolsDetectionTimeoutError(error.message);
          }
          if (signal?.aborted) {
            throw new AndroidToolsDetectionAbortError(this.context.getAbortError(signal));
          }
          throw error;
        }
      },
    };
  }

  async executeDetectionFileProbe(
    systemDetection: SystemDetection,
    path: string,
    deadlineMs: number | undefined,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (signal?.aborted) {
      throw new AndroidToolsDetectionAbortError(this.context.getAbortError(signal));
    }

    const timeoutMs = deadlineMs === undefined ? undefined : deadlineMs - this.context.timer.now();
    if (timeoutMs !== undefined && timeoutMs <= 0) {
      throw new AndroidToolsDetectionTimeoutError(
        `Command timed out before ADB path discovery: ${path}`,
      );
    }
    if (timeoutMs === undefined && !signal) {
      return systemDetection.fileExists(path);
    }

    return new Promise<boolean>((resolve, reject) => {
      let settled = false;
      let timeoutHandle: NodeJS.Timeout | undefined;
      const cleanup = () => {
        if (timeoutHandle) {
          this.context.timer.clearTimeout(timeoutHandle);
        }
        signal?.removeEventListener("abort", onAbort);
      };
      const settle = (callback: () => void) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        callback();
      };
      const onAbort = () =>
        settle(() =>
          reject(new AndroidToolsDetectionAbortError(this.context.getAbortError(signal!))),
        );

      if (timeoutMs !== undefined) {
        timeoutHandle = this.context.timer.setTimeout(
          () =>
            settle(() =>
              reject(
                new AndroidToolsDetectionTimeoutError(
                  `Command timed out before ADB path discovery: ${path}`,
                ),
              ),
            ),
          timeoutMs,
        );
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      void systemDetection.fileExists(path).then(
        (exists) => settle(() => resolve(exists)),
        (error) => settle(() => reject(error)),
      );
    });
  }

  throwIfAdbPathTimeout(error: unknown, signal?: AbortSignal): void {
    if (error instanceof AdbCommandTimeoutError) {
      throw error;
    }
    if (signal?.aborted) {
      throw this.context.getAbortError(signal);
    }
  }
}
