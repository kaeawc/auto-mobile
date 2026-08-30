import type { BootedDevice, CrashAppEvidence, CrashAppResult, ExecResult } from "../../models";
import {
  defaultAdbClientFactory,
  type AdbClientFactory,
} from "../../utils/android-cmdline-tools/AdbClientFactory";
import {
  findAndroidPackageProcesses,
  type AndroidPackageProcess,
} from "../../utils/android-cmdline-tools/androidProcessState";
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

const ANDROID_CRASH_LOG_COMMAND = "shell logcat -b crash -d -v epoch -t 200";

export interface IosSimulatorAppProcess {
  pid: number;
  serviceLabel: string;
}

interface AndroidCrashMatch {
  evidence: CrashAppEvidence;
  processId: number;
}

export interface SimulatorCrashCommandRunner {
  executeCommandArgs(args: string[], timeoutMs?: number, signal?: AbortSignal): Promise<ExecResult>;
}

export interface CrashAppDependencies {
  adb?: AdbExecutor;
  adbFactory?: AdbClientFactory;
  simctl?: SimulatorCrashCommandRunner;
  timer?: Timer;
  cacheInvalidator?: DeviceWindowCacheInvalidator;
}

export class CrashApp {
  private readonly adb: AdbExecutor;
  private readonly simctl: SimulatorCrashCommandRunner;
  private readonly timer: Timer;
  private readonly cacheInvalidator: DeviceWindowCacheInvalidator;

  constructor(
    private readonly device: BootedDevice,
    dependencies: CrashAppDependencies = {},
  ) {
    const adbFactory = dependencies.adbFactory ?? defaultAdbClientFactory;
    this.adb = dependencies.adb ?? adbFactory.create(device);
    this.simctl = dependencies.simctl ?? new SimCtlClient(device);
    this.timer = dependencies.timer ?? defaultTimer;
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

    const initialProcesses = await this.adb.executeCommand(
      PROCESS_STATE_COMMAND,
      undefined,
      undefined,
      true,
      signal,
    );
    const packageProcesses = findAndroidPackageProcesses(initialProcesses.stdout, appId);
    if (packageProcesses.length === 0) {
      return {
        ...base,
        success: false,
        supported: true,
        wasRunning: false,
        error: `${appId} is not running`,
      };
    }

    const userId = await this.selectAndroidUserId(appId, packageProcesses, signal);
    if (userId === null) {
      return {
        ...base,
        success: false,
        supported: true,
        wasRunning: true,
        error: `${appId} is running under multiple Android users; foreground identity is ambiguous`,
      };
    }
    const targetedProcesses = packageProcesses.filter((process) => process.userId === userId);
    const preferredProcess =
      targetedProcesses.find((process) => process.processName === appId) ?? targetedProcesses[0];
    const inductionTime = await this.adb.getDeviceTimestampMsWithSource();
    let commandResult: ExecResult;
    try {
      commandResult = await this.adb.executeCommand(
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
        processId: preferredProcess.pid,
        userId,
        error: message,
      };
    } finally {
      this.cacheInvalidator.invalidate(this.device);
    }

    const rejection = findAndroidCrashCommandRejection(commandResult);
    if (rejection) {
      return {
        ...base,
        success: false,
        supported: !this.isUnsupportedMechanismError(rejection),
        wasRunning: true,
        processId: preferredProcess.pid,
        userId,
        error: rejection,
      };
    }

    const crashMatch = await this.confirmAndroidCrash(
      appId,
      targetedProcesses,
      inductionTime.timestampMs,
      signal,
    );
    if (!crashMatch) {
      return {
        ...base,
        success: false,
        supported: true,
        wasRunning: true,
        processId: preferredProcess.pid,
        userId,
        error: "Crash command was dispatched, but no fresh OS crash evidence was found",
      };
    }
    return {
      ...base,
      success: true,
      supported: true,
      wasRunning: true,
      processId: crashMatch.processId,
      userId,
      confirmed: true,
      evidence: crashMatch.evidence,
    };
  }

  private async selectAndroidUserId(
    appId: string,
    processes: AndroidPackageProcess[],
    signal?: AbortSignal,
  ): Promise<number | null> {
    const userIds = new Set(processes.map((process) => process.userId));
    if (userIds.size === 1) {
      return userIds.values().next().value ?? null;
    }

    const foreground = await this.adb.getForegroundApp(signal);
    return foreground?.packageName === appId && userIds.has(foreground.userId)
      ? foreground.userId
      : null;
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
        error:
          "crashApp is not supported on physical iOS devices; " +
          "AutoMobile will not fall back to normal termination",
      };
    }

    const initialProcesses = await this.listIosSimulatorProcesses(signal);
    const appProcess = findIosSimulatorAppProcess(initialProcesses, appId);
    if (!appProcess) {
      return {
        ...base,
        success: false,
        supported: true,
        mechanism: "ios_simulator_sigabrt",
        wasRunning: false,
        error: `${appId} is not running on iOS Simulator ${this.device.deviceId}`,
      };
    }

    const inductionTimestampMs = this.timer.now();
    try {
      await this.simctl.executeCommandArgs(
        [
          "spawn",
          this.device.deviceId,
          "launchctl",
          "kill",
          "SIGABRT",
          `user/501/${appProcess.serviceLabel}`,
        ],
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
        processId: appProcess.pid,
        error: message,
      };
    } finally {
      this.cacheInvalidator.invalidate(this.device);
    }

    const evidence = await this.confirmIosSimulatorCrash(
      appId,
      appProcess.pid,
      inductionTimestampMs,
      signal,
    );
    if (!evidence) {
      return {
        ...base,
        success: false,
        supported: true,
        mechanism: "ios_simulator_sigabrt",
        wasRunning: true,
        processId: appProcess.pid,
        error: "Crash signal was dispatched, but no fresh OS crash evidence was found",
      };
    }
    return {
      ...base,
      success: true,
      supported: true,
      mechanism: "ios_simulator_sigabrt",
      wasRunning: true,
      processId: appProcess.pid,
      confirmed: true,
      evidence,
    };
  }

  private async confirmAndroidCrash(
    appId: string,
    initialProcesses: AndroidPackageProcess[],
    notBeforeTimestampMs: number,
    signal?: AbortSignal,
  ): Promise<AndroidCrashMatch | undefined> {
    const initialProcessIds = initialProcesses.map((process) => process.pid);
    for (let attempt = 0; attempt < CONFIRMATION_ATTEMPTS; attempt += 1) {
      signal?.throwIfAborted();
      const [processOutput, logOutput] = await Promise.all([
        this.tryAndroidCommand(PROCESS_STATE_COMMAND, signal),
        this.tryAndroidCommand(ANDROID_CRASH_LOG_COMMAND, signal),
      ]);
      const crashMatch = logOutput
        ? findAndroidCrashMatch(logOutput, appId, initialProcessIds, notBeforeTimestampMs)
        : undefined;
      const currentProcessIds =
        processOutput === undefined
          ? new Set(initialProcessIds)
          : new Set(
              findAndroidPackageProcesses(processOutput, appId).map((process) => process.pid),
            );

      if (crashMatch && !currentProcessIds.has(crashMatch.processId)) {
        return crashMatch;
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
    notBeforeTimestampMs: number,
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
        ? findIosSimulatorCrashEvidence(logOutput, appId, processId, notBeforeTimestampMs)
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
            "--timezone",
            "UTC",
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

export function findIosSimulatorAppProcess(
  processList: string,
  appId: string,
): IosSimulatorAppProcess | null {
  for (const line of processList.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+\S+\s+(UIKitApplication:(.+?)\[[^\]]+\]\[[^\]]+\])$/);
    if (match?.[3] === appId) {
      return { pid: Number(match[1]), serviceLabel: match[2] };
    }
  }
  return null;
}

export function findIosSimulatorAppProcessId(processList: string, appId: string): number | null {
  return findIosSimulatorAppProcess(processList, appId)?.pid ?? null;
}

export function findAndroidCrashCommandRejection(result: ExecResult): string | undefined {
  const line = `${result.stdout}\n${result.stderr}`
    .split("\n")
    .map((candidate) => candidate.trim())
    .find((candidate) =>
      /unknown command(?::)?\s*crash|does not have permission to crash|permission denial|not allowed to crash/i.test(
        candidate,
      ),
    );
  return line || undefined;
}

export function findAndroidCrashEvidence(
  logOutput: string,
  appId: string,
  processId: number,
  notBeforeTimestampMs = 0,
): CrashAppEvidence | undefined {
  return findAndroidCrashMatch(logOutput, appId, [processId], notBeforeTimestampMs)?.evidence;
}

function findAndroidCrashMatch(
  logOutput: string,
  appId: string,
  processIds: number[],
  notBeforeTimestampMs: number,
): AndroidCrashMatch | undefined {
  const lines = logOutput.split("\n");
  const expectedProcessIds = new Set(processIds);
  for (const [identityIndex, identityLine] of lines.entries()) {
    const identity = identityLine.match(
      new RegExp(`Process:\\s*${escapeRegExp(appId)}(?::[A-Za-z0-9_.]+)?,\\s*PID:\\s*(\\d+)`),
    );
    const processId = Number(identity?.[1]);
    if (
      !identity ||
      !expectedProcessIds.has(processId) ||
      !isLogLineFresh(identityLine, notBeforeTimestampMs)
    ) {
      continue;
    }

    const nextBlockOffset = lines
      .slice(identityIndex + 1)
      .findIndex((line) => line.includes("FATAL EXCEPTION") || line.includes("Process:"));
    const blockEnd =
      nextBlockOffset < 0
        ? Math.min(lines.length, identityIndex + 7)
        : identityIndex + 1 + nextBlockOffset;
    const targetCrashBlock = lines.slice(identityIndex, blockEnd);
    const marker = targetCrashBlock.find(
      (line) =>
        (line.includes("shell-induced crash") || line.includes("CrashedByAdbException")) &&
        isLogLineFresh(line, notBeforeTimestampMs),
    );
    if (marker) {
      return {
        processId,
        evidence: { source: "android_logcat", summary: marker.trim() },
      };
    }
  }
  return undefined;
}

export function findIosSimulatorCrashEvidence(
  logOutput: string,
  appId: string,
  processId: number,
  notBeforeTimestampMs = 0,
): CrashAppEvidence | undefined {
  const line = logOutput.split("\n").find((candidate) => {
    if (!candidate.includes("SIGABRT") || !isLogLineFresh(candidate, notBeforeTimestampMs)) {
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

function isLogLineFresh(line: string, notBeforeTimestampMs: number): boolean {
  if (notBeforeTimestampMs <= 0) {
    return true;
  }
  const timestampMs = parseLogTimestampMs(line);
  return timestampMs !== null && timestampMs >= notBeforeTimestampMs;
}

function parseLogTimestampMs(line: string): number | null {
  const epoch = line.match(/^\s*(\d{10})(?:\.(\d{1,9}))?/);
  if (epoch) {
    const fractionMs = Number((epoch[2] ?? "").padEnd(3, "0").slice(0, 3));
    return Number(epoch[1]) * 1000 + fractionMs;
  }

  const formatted = line.match(
    /^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?([+-]\d{4})?/,
  );
  if (!formatted) {
    return null;
  }
  const fractionMs = (formatted[3] ?? "").padEnd(3, "0").slice(0, 3);
  const timezone = formatted[4] ? `${formatted[4].slice(0, 3)}:${formatted[4].slice(3)}` : "Z";
  const timestampMs = Date.parse(`${formatted[1]}T${formatted[2]}.${fractionMs}${timezone}`);
  return Number.isNaN(timestampMs) ? null : timestampMs;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
