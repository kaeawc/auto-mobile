import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { errorMessage } from "../describeUnknownError";
import { logger } from "../logger";
import { raceWithDeadline } from "../raceWithDeadline";
import { getAbortSignal, runWithAbortSignal } from "../AbortContext";
import type { Timer } from "../SystemTimer";
import { ActionableError, type DeviceInfo, type ExecResult } from "../../models";
import { AndroidEmulatorUnavailableError } from "./AndroidEmulatorUnavailableError";
import {
  ANDROID_INVENTORY_AVD_LIST_CAP_MS,
  inventoryEnrichmentState,
} from "./AndroidDeviceInventoryScanner";
import type { AvdConfigReader } from "./AvdConfigReader";
import { enrichDeviceInfoList } from "./avdDeviceInfoEnrichment";
import {
  describeEmulatorResolution,
  isLikelyDaemonWorkingDirectoryFailure,
} from "./emulatorBinaryLocator";

// Keep the runtime API typed locally; this project does not include Bun's ambient types.
declare const Bun: { which(name: string): string | null };

export interface ListAvdsOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  coalesceInventoryEnrichment?: boolean;
}

/** Classify spawn failures without mistaking a running/stopped process for missing tooling. */
export function isMissingExecutableError(
  error: unknown,
  resolvedPath: string,
  executableExists: boolean,
): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const failure = error as Error & {
    code?: string | number;
    path?: string;
    killed?: boolean;
    signal?: string | null;
  };
  return (
    failure.code === "ENOENT" &&
    !failure.killed &&
    !failure.signal &&
    !["AbortError", "TimeoutError"].includes(failure.name) &&
    (failure.path === undefined || failure.path === resolvedPath) &&
    !executableExists
  );
}

/** Members resolved through the client at call time (the other extracted units' convention). */
export interface EmulatorAvdCatalogHost {
  timer(): Timer;
  emulatorPath(): string;
  avdConfigReader(): AvdConfigReader;
  executeCommand(args: string[], timeoutMs?: number, signal?: AbortSignal): Promise<ExecResult>;
  /** Resolved per call so a patched client enumeration still takes effect. */
  listAvdsUncached(options?: ListAvdsOptions): Promise<DeviceInfo[]>;
}

/** Enumeration of configured AVDs via `emulator -list-avds`. */
export interface EmulatorAvdCatalog {
  listAvds(options?: ListAvdsOptions): Promise<DeviceInfo[]>;
  listAvdsUncached(options?: ListAvdsOptions): Promise<DeviceInfo[]>;
}

export class DefaultEmulatorAvdCatalog implements EmulatorAvdCatalog {
  constructor(private readonly host: EmulatorAvdCatalogHost) {}

  async listAvds(options?: ListAvdsOptions): Promise<DeviceInfo[]> {
    if (!options?.coalesceInventoryEnrichment) {
      return this.host.listAvdsUncached(options);
    }
    const timer = this.host.timer();
    const state = inventoryEnrichmentState(timer);
    const signal = options.signal ?? getAbortSignal();
    signal?.throwIfAborted();
    const cached = state.avds.get("avds");
    if (cached) {
      return cached;
    }
    const generation = state.generation;
    const shared = state.avdFlight.run(
      "avds",
      () =>
        runWithAbortSignal(undefined, async () => {
          const result = await this.host.listAvdsUncached({
            timeoutMs: ANDROID_INVENTORY_AVD_LIST_CAP_MS,
          });
          if (generation === state.generation) {
            state.avds.set("avds", result);
          }
          return result;
        }),
      signal,
    );
    return raceWithDeadline(shared, {
      timer,
      timeoutMs: options.timeoutMs,
      signal,
      label: "Android AVD-list caller wait",
    });
  }

  async listAvdsUncached(options?: {
    signal?: AbortSignal;
    timeoutMs?: number;
  }): Promise<DeviceInfo[]> {
    try {
      const result = await this.host.executeCommand(
        ["-list-avds"],
        options?.timeoutMs,
        options?.signal,
      );
      const devices = result.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map(
          (name) =>
            ({ name, platform: "android", isRunning: false, source: "local" }) as DeviceInfo,
        );
      return enrichDeviceInfoList(this.host.avdConfigReader(), devices);
    } catch (error) {
      options?.signal?.throwIfAborted();
      logger.error("Failed to list AVDs:", error);
      throw this.listFailure(error);
    }
  }

  private listFailure(error: unknown): ActionableError {
    const emulatorPath = this.host.emulatorPath();
    const errorMsg = errorMessage(error);
    const daemonWorkingDirectoryFailure = isLikelyDaemonWorkingDirectoryFailure(
      emulatorPath,
      errorMsg,
    );
    const executableExists = (path: string): boolean =>
      isAbsolute(path) ? existsSync(path) : Bun.which(path) !== null;
    const missingExecutable =
      !daemonWorkingDirectoryFailure &&
      isMissingExecutableError(error, emulatorPath, executableExists(emulatorPath));
    const missingEmulator =
      missingExecutable || /No such file or directory|command not found|ENOENT/.test(errorMsg);
    if (missingEmulator && daemonWorkingDirectoryFailure) {
      return new ActionableError(
        `Android emulator command failed because the daemon working directory is unavailable. ` +
          `Restart the AutoMobile daemon so it can use a stable working directory. Underlying error: ${errorMsg}`,
      );
    }
    if (missingEmulator) {
      const MissingError = missingExecutable ? AndroidEmulatorUnavailableError : ActionableError;
      return new MissingError(
        `Android emulator not found.\n${describeEmulatorResolution(emulatorPath)}\n\n` +
          `Install the emulator package with: sdkmanager --install "emulator"\n` +
          `(Android Studio installs it too: https://developer.android.com/studio)\n` +
          `Or point ANDROID_HOME at an SDK that already has emulator/emulator.`,
      );
    }
    return new ActionableError(`Failed to list AVDs: ${errorMsg}`);
  }
}
