import type { BootedDevice, CrashAppEvidence, CrashAppResult, ExecResult } from "../../models";
import {
  defaultAdbClientFactory,
  type AdbClientFactory,
} from "../../utils/android-cmdline-tools/AdbClientFactory";
import { AndroidUserTargetResolver } from "../../utils/android-cmdline-tools/AndroidUserTargetResolver";
import { findAndroidPackageProcessId } from "../../utils/android-cmdline-tools/androidProcessState";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { ANDROID_PACKAGE_NAME_PATTERN } from "../../utils/androidPackageName";
import { errorMessage } from "../../utils/describeUnknownError";
import { isIosSimulatorUdid } from "../../utils/ios-cmdline-tools/iosDeviceType";
import { SimCtlClient } from "../../utils/ios-cmdline-tools/SimCtlClient";
import { logger } from "../../utils/logger";
import { shellQuote } from "../../utils/shellQuote";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import {
  DefaultDeviceWindowCacheInvalidator,
  type DeviceWindowCacheInvalidator,
} from "./TerminateApp";

const PROCESS_STATE_COMMAND = "shell dumpsys activity processes";
const CONFIRMATION_ATTEMPTS = 12;
const CONFIRMATION_POLL_MS = 250;

function androidCrashLogCommand(processId: number): string {
  return `shell logcat -b crash -d -v threadtime --pid=${processId} -t 200`;
}

export interface SimulatorCrashCommandRunner {
  executeCommandArgs(args: string[], timeoutMs?: number, signal?: AbortSignal): Promise<ExecResult>;
}

export interface CrashAppDependencies {
  adb?: AdbExecutor;
  adbFactory?: AdbClientFactory;
  simctl?: SimulatorCrashCommandRunner;
  timer?: Timer;
  resolveAndroidUserId?: (appId: string) => Promise<number>;
  cacheInvalidator?: DeviceWindowCacheInvalidator;
}

export class CrashApp {
  private readonly adb: AdbExecutor;
  private readonly simctl: SimulatorCrashCommandRunner;
  private readonly timer: Timer;
  private readonly resolveAndroidUserId: (appId: string) => Promise<number>;
  private readonly cacheInvalidator: DeviceWindowCacheInvalidator;

  constructor(
    private readonly device: BootedDevice,
    dependencies: CrashAppDependencies = {},
  ) {
    const adbFactory = dependencies.adbFactory ?? defaultAdbClientFactory;
    this.adb = dependencies.adb ?? adbFactory.create(device);
    this.simctl = dependencies.simctl ?? new SimCtlClient(device);
    this.timer = dependencies.timer ?? defaultTimer;
    this.resolveAndroidUserId =
      dependencies.resolveAndroidUserId ??
      (async (appId) => {
        return (await new AndroidUserTargetResolver(this.adb).resolve({ packageName: appId }))
          .userId;
      });
    this.cacheInvalidator =
      dependencies.cacheInvalidator ?? new DefaultDeviceWindowCacheInvalidator();
  }

  async execute(appId: string, signal?: AbortSignal): Promise<CrashAppResult> {
    const timestamp = this.timer.now();
    try {
      signal?.throwIfAborted();
      return this.device.platform === "android"
        ? await this.executeAndroid(appId, timestamp, signal)
        : await this.executeIos(appId, timestamp, signal);
    } catch (error) {
      signal?.throwIfAborted();
      const message = errorMessage(error);
      logger.warn(
        `[CrashApp] Failed to crash ${appId} on ${this.device.platform}: ${message}`,
        error,
      );
      return {
        success: false,
        supported: !this.isUnsupportedMechanismError(message),
        platform: this.device.platform,
        appId,
        mechanism:
          this.device.platform === "android"
            ? "android_am_crash"
            : isIosSimulatorUdid(this.device.deviceId)
              ? "ios_simulator_sigabrt"
              : "unsupported",
        timestamp,
        confirmed: false,
        error: message,
      };
    }
  }

  private async executeAndroid(
    appId: string,
    timestamp: number,
    signal?: AbortSignal,
  ): Promise<CrashAppResult> {
    const base = {
      platform: "android" as const,
      appId,
      mechanism: "android_am_crash" as const,
      timestamp,
      confirmed: false,
    };

    if (!ANDROID_PACKAGE_NAME_PATTERN.test(appId)) {
      return {
        ...base,
        success: false,
        supported: true,
        wasRunning: false,
        error: `${appId} is not a valid Android package name`,
      };
    }

    const userId = await this.resolveAndroidUserId(appId);
    const initialProcesses = await this.adb.executeCommand(
      PROCESS_STATE_COMMAND,
      undefined,
      undefined,
      true,
      signal,
    );
    const processId = findAndroidPackageProcessId(initialProcesses.stdout, appId, userId);
    if (processId === null) {
      return {
        ...base,
        success: false,
        supported: true,
        wasRunning: false,
        userId,
        error: `${appId} is not running for Android user ${userId}`,
      };
    }

    try {
      await this.adb.executeCommand(
        `shell am crash --user ${userId} ${shellQuote(appId)}`,
        undefined,
        undefined,
        true,
        signal,
      );
    } catch (error) {
      signal?.throwIfAborted();
      const message = errorMessage(error);
      logger.warn(`[CrashApp] Android crash command failed for ${appId}: ${message}`, error);
      return {
        ...base,
        success: false,
        supported: !this.isUnsupportedMechanismError(message),
        wasRunning: true,
        processId,
        userId,
        error: message,
      };
    }

    this.cacheInvalidator.invalidate(this.device);
    const evidence = await this.confirmAndroidCrash(appId, processId, userId, signal);
    return {
      ...base,
      success: true,
      supported: true,
      wasRunning: true,
      processId,
      userId,
      confirmed: evidence !== undefined,
      ...(evidence ? { evidence } : {}),
    };
  }

  private async executeIos(
    appId: string,
    timestamp: number,
    signal?: AbortSignal,
  ): Promise<CrashAppResult> {
    const simulator = isIosSimulatorUdid(this.device.deviceId);
    const base = {
      platform: "ios" as const,
      appId,
      timestamp,
      confirmed: false,
    };

    if (!simulator) {
      return {
        ...base,
        success: false,
        supported: false,
        mechanism: "unsupported",
        wasRunning: false,
        error:
          "crashApp is not supported on physical iOS devices; " +
          "AutoMobile will not fall back to normal termination",
      };
    }

    const initialProcesses = await this.listIosSimulatorProcesses(signal);
    const processId = findIosSimulatorAppProcessId(initialProcesses, appId);
    if (processId === null) {
      return {
        ...base,
        success: false,
        supported: true,
        mechanism: "ios_simulator_sigabrt",
        wasRunning: false,
        error: `${appId} is not running on iOS Simulator ${this.device.deviceId}`,
      };
    }

    try {
      await this.simctl.executeCommandArgs(
        ["spawn", this.device.deviceId, "/bin/kill", "-ABRT", String(processId)],
        undefined,
        signal,
      );
    } catch (error) {
      signal?.throwIfAborted();
      const message = errorMessage(error);
      logger.warn(`[CrashApp] iOS Simulator SIGABRT failed for ${appId}: ${message}`, error);
      return {
        ...base,
        success: false,
        supported: !this.isUnsupportedMechanismError(message),
        mechanism: "ios_simulator_sigabrt",
        wasRunning: true,
        processId,
        error: message,
      };
    }
    this.cacheInvalidator.invalidate(this.device);

    const evidence = await this.confirmIosSimulatorCrash(appId, processId, signal);
    return {
      ...base,
      success: true,
      supported: true,
      mechanism: "ios_simulator_sigabrt",
      wasRunning: true,
      processId,
      confirmed: evidence !== undefined,
      ...(evidence ? { evidence } : {}),
    };
  }

  private async confirmAndroidCrash(
    appId: string,
    processId: number,
    userId: number,
    signal?: AbortSignal,
  ): Promise<CrashAppEvidence | undefined> {
    for (let attempt = 0; attempt < CONFIRMATION_ATTEMPTS; attempt += 1) {
      signal?.throwIfAborted();
      const [processOutput, logOutput] = await Promise.all([
        this.tryAndroidCommand(PROCESS_STATE_COMMAND, signal),
        this.tryAndroidCommand(androidCrashLogCommand(processId), signal),
      ]);
      const currentPid =
        processOutput === undefined
          ? processId
          : findAndroidPackageProcessId(processOutput, appId, userId);
      const evidence = logOutput
        ? findAndroidCrashEvidence(logOutput, appId, processId)
        : undefined;

      if (currentPid !== processId && evidence) {
        return evidence;
      }
      if (attempt + 1 < CONFIRMATION_ATTEMPTS) {
        await this.timer.sleep(CONFIRMATION_POLL_MS);
      }
    }
    return undefined;
  }

  private async tryAndroidCommand(
    command: string,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    try {
      return (await this.adb.executeCommand(command, undefined, undefined, true, signal)).stdout;
    } catch (error) {
      signal?.throwIfAborted();
      logger.warn(`[CrashApp] Android confirmation command failed: ${command}`, error);
      return undefined;
    }
  }

  private async confirmIosSimulatorCrash(
    appId: string,
    processId: number,
    signal?: AbortSignal,
  ): Promise<CrashAppEvidence | undefined> {
    for (let attempt = 0; attempt < CONFIRMATION_ATTEMPTS; attempt += 1) {
      signal?.throwIfAborted();
      const [processOutput, logOutput] = await Promise.all([
        this.tryListIosSimulatorProcesses(signal),
        this.tryReadIosSimulatorCrashLog(signal),
      ]);
      const currentPid =
        processOutput === undefined
          ? processId
          : findIosSimulatorAppProcessId(processOutput, appId);
      const evidence = logOutput
        ? findIosSimulatorCrashEvidence(logOutput, appId, processId)
        : undefined;

      if (currentPid !== processId && evidence) {
        return evidence;
      }
      if (attempt + 1 < CONFIRMATION_ATTEMPTS) {
        await this.timer.sleep(CONFIRMATION_POLL_MS);
      }
    }
    return undefined;
  }

  private async listIosSimulatorProcesses(signal?: AbortSignal): Promise<string> {
    return (
      await this.simctl.executeCommandArgs(
        ["spawn", this.device.deviceId, "launchctl", "list"],
        undefined,
        signal,
      )
    ).stdout;
  }

  private async tryListIosSimulatorProcesses(signal?: AbortSignal): Promise<string | undefined> {
    try {
      return await this.listIosSimulatorProcesses(signal);
    } catch (error) {
      signal?.throwIfAborted();
      logger.warn("[CrashApp] iOS Simulator process confirmation failed", error);
      return undefined;
    }
  }

  private async tryReadIosSimulatorCrashLog(signal?: AbortSignal): Promise<string | undefined> {
    try {
      return (
        await this.simctl.executeCommandArgs(
          [
            "spawn",
            this.device.deviceId,
            "log",
            "show",
            "--last",
            "1m",
            "--style",
            "compact",
            "--predicate",
            'eventMessage CONTAINS[c] "SIGABRT"',
          ],
          undefined,
          signal,
        )
      ).stdout;
    } catch (error) {
      signal?.throwIfAborted();
      logger.warn("[CrashApp] iOS Simulator crash-log confirmation failed", error);
      return undefined;
    }
  }

  private isUnsupportedMechanismError(message: string): boolean {
    return (
      /unknown command(?::)?\s*crash/i.test(message) || /no such file or directory/i.test(message)
    );
  }
}

export function findIosSimulatorAppProcessId(processList: string, appId: string): number | null {
  for (const line of processList.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+\S+\s+UIKitApplication:(.+?)\[[^\]]+\]\[[^\]]+\]$/);
    if (match?.[2] === appId) {
      return Number(match[1]);
    }
  }
  return null;
}

export function findAndroidCrashEvidence(
  logOutput: string,
  appId: string,
  processId: number,
): CrashAppEvidence | undefined {
  const lines = logOutput.split("\n");
  const identityIndex = lines.findIndex(
    (line) =>
      line.includes(`Process: ${appId}, PID: ${processId}`) ||
      line.includes(`${appId}, PID: ${processId}`),
  );
  if (identityIndex < 0) {
    return undefined;
  }

  const targetCrashBlock = lines.slice(Math.max(0, identityIndex - 1), identityIndex + 7);
  const marker = targetCrashBlock.find(
    (line) => line.includes("shell-induced crash") || line.includes("CrashedByAdbException"),
  );
  return marker ? { source: "android_logcat", summary: marker.trim() } : undefined;
}

export function findIosSimulatorCrashEvidence(
  logOutput: string,
  appId: string,
  processId: number,
): CrashAppEvidence | undefined {
  const line = logOutput.split("\n").find((candidate) => {
    if (!candidate.includes("SIGABRT")) {
      return false;
    }
    const launchdIdentity =
      candidate.includes(`UIKitApplication:${appId}[`) &&
      candidate.includes(`[${processId}]`) &&
      candidate.includes("exited due to SIGABRT");
    const runningBoardIdentity =
      candidate.includes(`app<${appId}`) &&
      candidate.includes(`:${processId}]`) &&
      candidate.includes("code:SIGABRT(6)");
    return launchdIdentity || runningBoardIdentity;
  });
  return line ? { source: "ios_unified_log", summary: line.trim() } : undefined;
}
