import { IOS_WEBRTC_DEFAULT_BITS_PER_PIXEL } from "./IosFramePipeline";
import { QUALITY_PRESET_MAX_LONG_SIDE, qualityPresetBitrateBps } from "./qualityPresets";
import { basename } from "node:path";
import { ActionableError, toActionableError, type BootedDevice } from "../../models";
import type { Timer } from "../../utils/SystemTimer";
import { errorMessage } from "../../utils/describeUnknownError";
import { resolveIosDeviceKind } from "../../utils/ios-cmdline-tools/IosDeviceKind";
import { logger } from "../../utils/logger";
import type { FfmpegClient } from "../../utils/media/FfmpegClient";
import type { CaptureTarget, EncodeBitratePolicy, EncodeSettings } from "../screen-stream";
import {
  CAPTURE_PERMISSION_PREFIX,
  CAPTURE_PERMISSION_TARGET_PREFIX,
} from "../screen-stream/IosScreenCaptureHelper";
import {
  IOS_SCREEN_CAPTURE_HELPER_ENV,
  readScreenCaptureHelperEnvOverride,
  resolveIosScreenCaptureHelperPath,
} from "../screen-stream/screenCaptureHelperPath";
import { ScreenRecordingPermissionError } from "./ScreenRecordingPermissionError";
import { defaultProcessSpawner } from "./processSpawner";
import {
  DEFAULT_IOS_WEBRTC_FPS,
  IOS_WEBRTC_FFMPEG_ENV,
  IOS_SIMULATOR_WINDOW_POLL_INTERVAL_MS,
  IOS_SIMULATOR_TARGET_RESOLUTION_TIMEOUT_MS,
  IOS_HELPER_PATH_RESOLUTION_TIMEOUT_MS,
  type IosH264SourceOptions,
  type CommandRunner,
  type CommandResult,
  type IosSimulatorWindowResolver,
  type ScreenCaptureHelperEnsurer,
} from "./IosH264SourceConfig";

interface SimulatorWindowInfo {
  windowID: number;
  title?: string | null;
  applicationName?: string;
  bundleIdentifier?: string;
}

export const defaultCommandRunner: CommandRunner = (command, args, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error(`Command aborted: ${command}`));
      return;
    }
    const child = defaultProcessSpawner(command, args);
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      signal?.removeEventListener("abort", abort);
      callback();
    };
    const abort = (): void => {
      child.kill("SIGTERM");
      finish(() => reject(new Error(`Command aborted: ${command}`)));
    };
    child.stdout.on("data", (chunk) => {
      stdout += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    });
    child.once("error", (error) => finish(() => reject(error)));
    child.once("exit", (exitCode, exitSignal) =>
      finish(() => resolve({ stdout, stderr, exitCode, signal: exitSignal })),
    );
    signal?.addEventListener("abort", abort, { once: true });
  });

interface IosCaptureResolverDependencies {
  options: { device: BootedDevice; audioEnabled?: boolean };
  helperPath?: string;
  helperPathExists?: (candidate: string) => boolean;
  screenCaptureHelperProvider: ScreenCaptureHelperEnsurer;
  fps: number;
  timer: Timer;
  simulatorWindowResolver: IosSimulatorWindowResolver;
  withPreCaptureDeadline: <T>(
    operation: Promise<T>,
    timeoutMs: number,
    context: string,
  ) => Promise<T>;
}

export class IosCaptureResolver {
  constructor(private readonly dependencies: IosCaptureResolverDependencies) {}

  async resolveCaptureTarget(helperPath: string): Promise<CaptureTarget> {
    if (
      resolveIosDeviceKind({ deviceId: this.dependencies.options.device.deviceId }) === "simulator"
    ) {
      const windowID = await this.resolveSimulatorWindowIdWithDeadline(helperPath);
      return {
        kind: "simulator",
        windowID,
        fps: this.dependencies.fps,
        ...(this.dependencies.options.audioEnabled === true ? { audio: true } : {}),
      };
    }
    return { kind: "device", deviceId: this.dependencies.options.device.deviceId };
  }

  async resolveHelperPath(): Promise<string> {
    const configuredPath =
      this.dependencies.helperPath ?? readScreenCaptureHelperEnvOverride(process.env);
    if (configuredPath) {
      return resolveIosScreenCaptureHelperPath(configuredPath, {
        exists: this.dependencies.helperPathExists,
        env: {},
      });
    }

    const releasedPath = await this.dependencies.withPreCaptureDeadline(
      this.dependencies.screenCaptureHelperProvider.ensure(),
      IOS_HELPER_PATH_RESOLUTION_TIMEOUT_MS,
      "Resolving iOS screen-capture-helper",
    );
    if (releasedPath) {
      return releasedPath;
    }
    throw new ActionableError(
      "iOS WebRTC streaming requires a verified screen-capture-helper from the matching GitHub Release. " +
        `For local development, run swift build in ios/screen-capture and set ${IOS_SCREEN_CAPTURE_HELPER_ENV} to the resulting absolute path.`,
    );
  }

  async resolveSimulatorWindowIdWithDeadline(helperPath: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const controller = new AbortController();
      let settled = false;
      const finish = (callback: () => void): void => {
        if (settled) {
          return;
        }
        settled = true;
        this.dependencies.timer.clearTimeout(timeout);
        callback();
      };
      const timeout = this.dependencies.timer.setTimeout(() => {
        controller.abort();
        finish(() =>
          reject(
            new ActionableError(
              `Timed out resolving iOS Simulator window for ${this.dependencies.options.device.name} after ${IOS_SIMULATOR_TARGET_RESOLUTION_TIMEOUT_MS}ms. Open the Simulator window and verify Screen Recording permission.`,
            ),
          ),
        );
      }, IOS_SIMULATOR_TARGET_RESOLUTION_TIMEOUT_MS);
      void this.dependencies
        .simulatorWindowResolver(
          helperPath,
          this.dependencies.options.device,
          this.dependencies.options.audioEnabled === true,
          controller.signal,
        )
        .then(
          (windowID) => finish(() => resolve(windowID)),
          (error) => finish(() => reject(error)),
        );
    });
  }

  async reresolveSimulatorTarget(
    helperPath: string,
    target: CaptureTarget,
  ): Promise<CaptureTarget> {
    if (target.kind !== "simulator") {
      return target;
    }
    let windowID: number;
    try {
      windowID = await this.resolveSimulatorWindowIdWithDeadline(helperPath);
    } catch (error) {
      throw toActionableError(error, "Failed to re-resolve iOS Simulator window for capture retry");
    }
    if (windowID === target.windowID) {
      return target;
    }
    logger.debug(
      `[IosH264Source] Simulator windowID changed from ${target.windowID} to ${windowID} before retry; ` +
        "targeting the freshly-resolved window",
    );
    return { ...target, windowID };
  }
}

export function describeCaptureTarget(target: CaptureTarget): string {
  return target.kind === "simulator"
    ? `iOS Simulator window ${target.windowID} at ${target.fps ?? DEFAULT_IOS_WEBRTC_FPS} fps`
    : `iOS device ${target.deviceId ?? "default"}`;
}

export async function validateFfmpegAvailability(
  ffmpegClient: FfmpegClient,
  ffmpegPath: string,
  timeoutMs: number,
  testCommandRunner?: CommandRunner,
): Promise<void> {
  // `commandRunner` is a long-standing test seam. Production probes must stay
  // behind FfmpegClient, while injected fakes can retain their narrow runner.
  if (testCommandRunner) {
    return validateFfmpegAvailabilityWithRunner(ffmpegPath, testCommandRunner);
  }
  try {
    await ffmpegClient.probe({ requiredEncoders: ["h264_videotoolbox"], timeoutMs });
  } catch (error) {
    const message = errorMessage(error);
    if (message.includes("missing required encoder")) {
      throw new ActionableError(
        "iOS WebRTC streaming requires an ffmpeg build with the h264_videotoolbox encoder.",
      );
    }
    throw new ActionableError(
      `iOS WebRTC streaming requires ffmpeg. Set ${IOS_WEBRTC_FFMPEG_ENV} to a working ffmpeg binary. ${message}`,
    );
  }
}

async function validateFfmpegAvailabilityWithRunner(
  ffmpegPath: string,
  commandRunner: CommandRunner,
): Promise<void> {
  let version: CommandResult;
  try {
    version = await commandRunner(ffmpegPath, ["-version"]);
  } catch (error) {
    throw new ActionableError(
      `iOS WebRTC streaming requires ffmpeg. Set ${IOS_WEBRTC_FFMPEG_ENV} to a working ffmpeg binary. ${errorMessage(error)}`,
    );
  }
  if (version.exitCode !== 0) {
    throw new ActionableError(
      `iOS WebRTC ffmpeg probe failed: ${version.stderr.trim() || `exited with code ${version.exitCode}`}`,
    );
  }

  const encoders = await commandRunner(ffmpegPath, ["-hide_banner", "-encoders"]);
  const encoderOutput = `${encoders.stdout}\n${encoders.stderr}`;
  if (encoders.exitCode !== 0 || !encoderOutput.includes("h264_videotoolbox")) {
    throw new ActionableError(
      "iOS WebRTC streaming requires an ffmpeg build with the h264_videotoolbox encoder.",
    );
  }
}

export async function defaultResolveSimulatorWindowId(
  helperPath: string,
  device: BootedDevice,
  commandRunner: CommandRunner,
  audioEnabled: boolean,
  signal: AbortSignal,
  poll: { timer: Timer; pollBudgetMs: number },
): Promise<number> {
  const startedAt = poll.timer.now();
  let lookups = 0;
  for (;;) {
    lookups += 1;
    const outcome = await lookupSimulatorWindowId(
      helperPath,
      device,
      commandRunner,
      audioEnabled,
      signal,
    );
    if (outcome.kind === "found") {
      return outcome.windowID;
    }
    const exhausted =
      signal.aborted ||
      poll.timer.now() - startedAt + IOS_SIMULATOR_WINDOW_POLL_INTERVAL_MS >= poll.pollBudgetMs;
    if (exhausted) {
      throw new ActionableError(
        `No visible iOS Simulator window matched ${device.name} after ${lookups} lookup(s) over ` +
          `${poll.timer.now() - startedAt}ms; windows seen: ${outcome.seen}. ` +
          "Open the simulator window and grant Screen Recording permission if prompted.",
      );
    }
    await poll.timer.sleep(IOS_SIMULATOR_WINDOW_POLL_INTERVAL_MS);
  }
}

type SimulatorWindowLookup =
  | { kind: "found"; windowID: number }
  | { kind: "missing"; seen: string };

async function lookupSimulatorWindowId(
  helperPath: string,
  device: BootedDevice,
  commandRunner: CommandRunner,
  audioEnabled: boolean,
  signal: AbortSignal,
): Promise<SimulatorWindowLookup> {
  const result = await commandRunner(helperPath, ["--list-simulators"], signal);
  if (result.exitCode !== 0) {
    if (hasScreenRecordingPermissionDenial(result.stderr)) {
      throw new ScreenRecordingPermissionError(
        screenRecordingApprovalTarget(result.stderr) ??
          defaultScreenRecordingApprovalTarget(helperPath),
      );
    }
    throw new ActionableError(
      `Unable to list iOS Simulator windows: ${result.stderr.trim() || `exited with code ${result.exitCode}`}`,
    );
  }

  let windows: SimulatorWindowInfo[];
  try {
    windows = (JSON.parse(result.stdout) as { windows?: SimulatorWindowInfo[] }).windows ?? [];
  } catch (error) {
    throw toActionableError(error, `Unable to parse iOS Simulator window list`);
  }

  if (audioEnabled && windows.length > 1) {
    throw new ActionableError(
      "iOS Simulator audio capture requires exactly one visible Simulator window because ScreenCaptureKit cannot isolate audio to a selected Simulator window. Close other Simulator windows and try again.",
    );
  }

  // Prefer a window whose title *names* this device exactly, falling back to a
  // substring match only when nothing matches exactly. A bare substring match
  // is ambiguous for overlapping device names ("iPhone 15" also occurs in an
  // "iPhone 15 Pro" title), which would otherwise trip the many-match guard and
  // fail to capture even though the right window is present. The window list
  // exposes no UDID, so the title is the only identifier available.
  const deviceName = device.name.trim().toLowerCase();
  const titledWindows = windows.filter(
    (window): window is SimulatorWindowInfo & { title: string } =>
      typeof window.title === "string" && window.title.trim().length > 0,
  );
  const exactMatches = titledWindows.filter((window) =>
    simulatorTitleNamesDeviceExactly(window.title, deviceName),
  );
  const matches =
    exactMatches.length > 0
      ? exactMatches
      : titledWindows.filter((window) => window.title.toLowerCase().includes(deviceName));
  if (matches.length === 1) {
    return { kind: "found", windowID: matches[0].windowID };
  }
  if (matches.length === 0) {
    const seen = windows.map((window) => JSON.stringify(window.title ?? null)).join(", ");
    return { kind: "missing", seen: `[${seen}]` };
  }
  throw new ActionableError(
    `Multiple iOS Simulator windows matched ${device.name}; close extras or use a more specific device.`,
  );
}

export function hasScreenRecordingPermissionDenial(stderr: string): boolean {
  return stderr.split(/\r?\n/).some((line) => {
    const normalized = line.trim().toLowerCase();
    return (
      normalized === `${CAPTURE_PERMISSION_PREFIX} screen-recording` ||
      normalized.startsWith("error: screen recording permission is required.") ||
      normalized.includes("the user declined tccs for application, window, display capture")
    );
  });
}

function screenRecordingApprovalTarget(stderr: string): string | null {
  for (const line of stderr.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(CAPTURE_PERMISSION_TARGET_PREFIX)) {
      continue;
    }
    const target = trimmed.slice(CAPTURE_PERMISSION_TARGET_PREFIX.length).trim();
    if (target.length > 0) {
      return target;
    }
  }
  return null;
}

export function defaultScreenRecordingApprovalTarget(helperPath: string): string {
  const target = basename(helperPath).trim();
  return target === "screen-capture-helper" || target.length === 0 ? "AutoMobile" : target;
}

/**
 * True when a Simulator window title names exactly this device rather than
 * merely containing its name. Matches the bare device-name title the Simulator
 * uses ("iPhone 15 Pro") and a title that appends a runtime segment after a
 * dash separator ("iPhone 15 Pro — 17.0"), so "iPhone 15" no longer matches an
 * "iPhone 15 Pro" window. `deviceName` is expected already trimmed + lowercased.
 */
function simulatorTitleNamesDeviceExactly(title: string, deviceName: string): boolean {
  const normalized = title.trim().toLowerCase();
  if (normalized === deviceName) {
    return true;
  }
  // Simulator titles may append " — <runtime>" (em/en dash or hyphen) after the
  // device name; compare the leading segment before that separator exactly.
  const [leadingSegment] = normalized.split(/\s+[—–-]\s+/, 1);
  return leadingSegment.trim() === deviceName;
}

/**
 * Map the bitrate policy onto helper encode flags: an operator override becomes
 * `--bitrate-bps`, otherwise the Simulator default `--bits-per-pixel` budget is
 * passed for the helper to apply against the delivered pixels x fps (#4375).
 */
export function resolveEncodeSettings(options: IosH264SourceOptions): EncodeSettings {
  // Explicit bitrate override > quality preset > bits-per-pixel budget.
  const override =
    options.bitrateBps && options.bitrateBps > 0
      ? options.bitrateBps
      : qualityPresetBitrateBps(options.quality);
  const bitrate: EncodeBitratePolicy =
    override !== undefined
      ? { kind: "explicitBps", bps: override }
      : { kind: "bitsPerPixel", bpp: IOS_WEBRTC_DEFAULT_BITS_PER_PIXEL };
  const maxLongSide = options.quality ? QUALITY_PRESET_MAX_LONG_SIDE[options.quality] : undefined;
  return {
    codec: "h264",
    bitrate,
    ...(maxLongSide === undefined ? {} : { maxLongSide }),
  };
}
