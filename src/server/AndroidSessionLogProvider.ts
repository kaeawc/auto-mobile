import { ActionableError, type BootedDevice, type ExecResult } from "../models";
import type { AdbClientFactory } from "../utils/android-cmdline-tools/AdbClientFactory";
import type { AdbExecutor } from "../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { errorMessage } from "../utils/describeUnknownError";
import { shellQuote } from "../utils/shellQuote";
import type { AppFileContainer } from "./appFileContract";
import {
  executeAndroidAppFileCommand,
  resolveAndroidTarget,
  type AndroidTarget,
} from "./appFileSupport";
import {
  boundedContent,
  failedPath,
  type SessionLogProvider,
  type ResetAppLogsRequest,
  type SessionLogReadBounds,
} from "./DefaultSessionLogService";
import {
  type SessionLogFileOutcome,
  type SessionLogFilesRequest,
  type SessionLogFilesResult,
  type AndroidLogcatWindowResult,
  type ResetAppLogsPathOutcome,
  type UnifiedLogWindowRequest,
  ANDROID_LOGCAT_DEFAULT_MAX_LINES,
  ANDROID_LOGCAT_MAX_LINES_LIMIT,
  SESSION_LOG_MAX_BYTES_LIMIT,
  UNIFIED_LOG_MAX_WINDOW_SECONDS,
} from "./sessionLogContract";

const ANDROID_LOG_READ_MAX_BUFFER = 16 * 1024 * 1024;

const ANDROID_MISSING_MARKER = "__AUTOMOBILE_MISSING__";

// --- Android ----------------------------------------------------------------

function androidResetScript(target: AndroidTarget & { kind: "runAs" | "external" }): string {
  const quoted = shellQuote(target.kind === "runAs" ? target.relativePath : target.absolutePath);
  return (
    `found=0; for f in ${quoted} ${quoted}.[0-9]*; do ` +
    `if [ -e "$f" ]; then rm -f -- "$f" && found=1; fi; done; ` +
    `if [ "$found" = 1 ]; then echo reset; else echo missing; fi`
  );
}

function androidReadScript(
  target: AndroidTarget & { kind: "runAs" | "external" },
  maxBytes: number,
): string {
  const quoted = shellQuote(target.kind === "runAs" ? target.relativePath : target.absolutePath);
  return (
    `if [ -f ${quoted} ]; then wc -c < ${quoted}; head -c ${maxBytes} ${quoted} | base64; ` +
    `else echo ${ANDROID_MISSING_MARKER}; fi`
  );
}

function parseAndroidRead(path: string, stdout: string, maxBytes: number): SessionLogFileOutcome {
  const trimmed = stdout.trim();
  if (trimmed === ANDROID_MISSING_MARKER) {
    return { path, status: "missing" };
  }
  const newline = trimmed.indexOf("\n");
  const sizeText = (newline < 0 ? trimmed : trimmed.slice(0, newline)).trim();
  const byteCount = Number(sizeText);
  if (!Number.isFinite(byteCount)) {
    return { path, status: "failed", reason: `Unexpected device response: ${sizeText}` };
  }
  const blob = newline < 0 ? "" : trimmed.slice(newline + 1).replace(/\s+/g, "");
  const buffer = Buffer.from(blob, "base64");
  return { path, status: "read", ...boundedContent(buffer, byteCount, maxBytes) };
}

interface AndroidSessionLogCommandOptions {
  adb: AdbExecutor;
  device: BootedDevice;
  appId: string;
  container: AppFileContainer;
  target: AndroidTarget & { kind: "runAs" | "external" };
  script: string;
  operation: "read" | "reset";
  signal?: AbortSignal;
}

export class AndroidSessionLogProvider implements SessionLogProvider {
  readonly platform = "android" as const;

  constructor(private readonly adbFactory: AdbClientFactory) {}

  async collectAndroidLogcat(
    device: BootedDevice,
    appId: string,
    request: UnifiedLogWindowRequest,
    { maxBytes, signal }: SessionLogReadBounds,
  ): Promise<AndroidLogcatWindowResult> {
    const adb = this.adbFactory.create(device);
    try {
      const pidResult = await adb.executeCommand(`shell pidof ${shellQuote(appId)}`, {
        timeoutMs: 10_000,
        maxBuffer: 4096,
        noRetry: true,
        signal,
      });
      const pid = Number(pidResult.stdout.trim().split(/\s+/)[0]);
      if (!Number.isSafeInteger(pid) || pid <= 0) {
        throw new ActionableError(`No running process was found for ${appId}.`);
      }
      const lastSeconds = Math.min(request.lastSeconds, UNIFIED_LOG_MAX_WINDOW_SECONDS);
      const lineLimit = Math.min(ANDROID_LOGCAT_DEFAULT_MAX_LINES, ANDROID_LOGCAT_MAX_LINES_LIMIT);
      const levelFilter =
        request.level === "default" ? "*:V" : `*:${request.level === "info" ? "I" : "D"}`;
      const command =
        `shell logcat -d -v brief --pid ${pid} -T "$(( $(date +%s) - ${lastSeconds} )).000" ` +
        `-m ${lineLimit} ${shellQuote(levelFilter)}`;
      const output = await adb.executeCommand(command, {
        timeoutMs: 20_000,
        maxBuffer: ANDROID_LOG_READ_MAX_BUFFER,
        noRetry: true,
        signal,
      });
      const source = Buffer.from(output.stdout, "utf8");
      const byteLimit = Math.min(maxBytes, SESSION_LOG_MAX_BYTES_LIMIT);
      const bounded = source.byteLength > byteLimit ? source.subarray(0, byteLimit) : source;
      const lineCount =
        output.stdout.length === 0
          ? 0
          : output.stdout.split("\n").length - (output.stdout.endsWith("\n") ? 1 : 0);
      return {
        lastSeconds,
        level: request.level,
        pid,
        lineLimit,
        byteCount: source.byteLength,
        truncated: bounded.byteLength < source.byteLength || lineCount >= lineLimit,
        text: bounded.toString("utf8"),
      };
    } catch (error) {
      throw new ActionableError(
        `Android logcat is not available for ${appId}: ${errorMessage(error)}`,
      );
    }
  }

  async readAppLogs(
    device: BootedDevice,
    appId: string,
    request: SessionLogFilesRequest,
    { maxBytes, signal }: SessionLogReadBounds,
  ): Promise<SessionLogFilesResult> {
    const adb = this.adbFactory.create(device);
    const entries: SessionLogFileOutcome[] = [];
    for (const path of request.paths) {
      const target = resolveAndroidTarget(appId, request.container, path);
      if (target.kind === "unsupported") {
        entries.push({ path, status: "failed", reason: target.message });
        continue;
      }
      try {
        const result = await this.run({
          adb,
          device,
          appId,
          container: request.container,
          target,
          script: androidReadScript(target, maxBytes),
          operation: "read",
          signal,
        });
        entries.push(parseAndroidRead(path, result.stdout, maxBytes));
      } catch (error) {
        entries.push(failedPath(path, error));
      }
    }
    return { container: request.container, entries };
  }

  async resetAppLogs(request: ResetAppLogsRequest): Promise<ResetAppLogsPathOutcome[]> {
    const adb = this.adbFactory.create(request.device);
    const entries: ResetAppLogsPathOutcome[] = [];
    for (const path of request.paths) {
      const target = resolveAndroidTarget(request.appId, request.container, path);
      if (target.kind === "unsupported") {
        entries.push({ path, status: "failed", reason: target.message });
        continue;
      }
      try {
        const result = await this.run({
          adb,
          device: request.device,
          appId: request.appId,
          container: request.container,
          target,
          script: androidResetScript(target),
          operation: "reset",
          signal: request.signal,
        });
        entries.push({ path, status: result.stdout.trim() === "reset" ? "reset" : "missing" });
      } catch (error) {
        entries.push(failedPath(path, error));
      }
    }
    return entries;
  }

  private run(options: AndroidSessionLogCommandOptions): Promise<ExecResult> {
    const { adb, device, appId, container, target, script, operation, signal } = options;
    const command =
      target.kind === "external"
        ? `shell sh -c ${shellQuote(script)}`
        : `shell run-as ${shellQuote(appId)} sh -c ${shellQuote(script)}`;
    return executeAndroidAppFileCommand(
      adb,
      command,
      {
        device,
        appId,
        container,
        operation,
        access: target.kind === "external" ? "externalFiles" : "run-as",
      },
      { maxBuffer: ANDROID_LOG_READ_MAX_BUFFER, noRetry: true, signal },
    );
  }
}
