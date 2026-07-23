import { existsSync } from "node:fs";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import { ActionableError, type BootedDevice } from "../../models";
import {
  IOSScreenCaptureHelper,
  SIMULATOR_FPS_DEFAULT,
} from "../screen-stream/IOSScreenCaptureHelper";
import type {
  CaptureTarget,
  DecodedAudio,
  DecodedFrame,
  IosScreenCaptureHelperOptions,
  MalformedFrameError,
} from "../screen-stream";
import { isIosSimulatorUdid } from "../../utils/ios-cmdline-tools/iosDeviceType";
import { logger } from "../../utils/logger";
import {
  DefaultFfmpegClient,
  resolveFfmpegBinary,
  type FfmpegClient,
  type FfmpegProcess,
} from "../../utils/media/FfmpegClient";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import type { H264CaptureSource, H264CaptureSourceOptions } from "./H264CaptureSource";

export const IOS_SCREEN_CAPTURE_HELPER_ENV = "AUTOMOBILE_IOS_SCREEN_CAPTURE_HELPER";
export const IOS_SCREEN_CAPTURE_HELPER_ENV_ALIAS = "AUTO_MOBILE_IOS_SCREEN_CAPTURE_HELPER";
export const IOS_WEBRTC_FFMPEG_ENV = "AUTOMOBILE_IOS_WEBRTC_FFMPEG";
export const IOS_WEBRTC_FFMPEG_ENV_ALIAS = "AUTO_MOBILE_IOS_WEBRTC_FFMPEG";
const DEFAULT_IOS_WEBRTC_FPS = SIMULATOR_FPS_DEFAULT;
const DEFAULT_FIRST_FRAME_TIMEOUT_MS = 5_000;
const NO_FRAMES_PERMISSION_WARNING = "warn: no frames received";
/** Target seconds between IDRs in the ffmpeg GOP (see buildFfmpegArgs). */
const IOS_KEYFRAME_INTERVAL_SECONDS = 2;

export interface IosFrameCaptureHelper {
  start(): void;
  stop(): Promise<unknown>;
  on(event: "frame", listener: (frame: DecodedFrame) => void): this;
  on(event: "audio", listener: (audio: DecodedAudio) => void): this;
  on(event: "malformed", listener: (error: MalformedFrameError) => void): this;
  on(event: "stderr", listener: (line: string) => void): this;
  on(event: "exit", listener: (info: { code: number | null; signal: NodeJS.Signals | null }) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
}

export interface IosH264EncoderProcess {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  once(event: "error", listener: (error: Error) => void): void;
}

export type IosH264EncoderSpawner = (command: string, args: string[]) => IosH264EncoderProcess;
export type IosFrameCaptureHelperFactory = (
  options: IosScreenCaptureHelperOptions
) => IosFrameCaptureHelper;
export type IosSimulatorWindowResolver = (
  helperPath: string,
  device: BootedDevice,
  audioEnabled: boolean
) => Promise<number>;

interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

type CommandRunner = (command: string, args: string[]) => Promise<CommandResult>;

const defaultCommandRunner: CommandRunner = (command, args) =>
  new Promise((resolve, reject) => {
    const child = nodeSpawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => {
      stdout += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    });
    child.stderr.on("data", chunk => {
      stderr += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    });
    child.once("error", error => reject(error));
    child.once("exit", (exitCode, signal) => resolve({ stdout, stderr, exitCode, signal }));
  });

export interface IosH264SourceOptions extends H264CaptureSourceOptions {
  helperPath?: string;
  ffmpegPath?: string;
  fps?: number;
  createHelper?: IosFrameCaptureHelperFactory;
  spawner?: IosH264EncoderSpawner;
  simulatorWindowResolver?: IosSimulatorWindowResolver;
  commandRunner?: CommandRunner;
  ffmpegClient?: FfmpegClient;
  helperPathExists?: (candidate: string) => boolean;
  timer?: Timer;
  firstFrameTimeoutMs?: number;
}

interface SimulatorWindowInfo {
  windowID: number;
  title?: string | null;
  applicationName?: string;
  bundleIdentifier?: string;
}

interface EncoderSize {
  width: number;
  height: number;
}

type IosH264SourcePhase = "idle" | "starting" | "running" | "stopping";

export class IosH264Source implements H264CaptureSource {
  private readonly helperPath?: string;
  private readonly ffmpegPath: string;
  private readonly fps: number;
  private readonly createHelper: IosFrameCaptureHelperFactory;
  private readonly ffmpegClient: FfmpegClient;
  private readonly simulatorWindowResolver: IosSimulatorWindowResolver;
  private readonly commandRunner: CommandRunner;
  private readonly helperPathExists?: (candidate: string) => boolean;
  private readonly timer: Timer;
  private readonly firstFrameTimeoutMs: number;

  private helper: IosFrameCaptureHelper | null = null;
  private encoder: IosH264EncoderProcess | null = null;
  private encoderSize: EncoderSize | null = null;
  private encoderBackpressured = false;
  private teardownPromise: Promise<void> | null = null;
  private cancelFirstFrameWait: (() => void) | null = null;
  private cancelFirstAudioWait: (() => void) | null = null;
  private rejectFirstAudioWait: ((error: Error) => void) | null = null;
  private phase: IosH264SourcePhase = "idle";

  constructor(private readonly options: IosH264SourceOptions) {
    this.helperPath = options.helperPath;
    this.ffmpegPath =
      resolveFfmpegBinary({
        explicitPath: options.ffmpegPath,
        environmentKeys: [IOS_WEBRTC_FFMPEG_ENV, IOS_WEBRTC_FFMPEG_ENV_ALIAS],
      });
    this.fps = options.fps ?? DEFAULT_IOS_WEBRTC_FPS;
    this.createHelper = options.createHelper ?? (helperOptions => new IOSScreenCaptureHelper(helperOptions));
    this.ffmpegClient = options.ffmpegClient ?? new DefaultFfmpegClient({
      binaryPath: this.ffmpegPath,
      spawn: options.spawner
        ? (binaryPath, args) => {
          // eslint-disable-next-line auto-mobile/no-unknown-cast -- The injected test spawner implements the process members FfmpegClient consumes.
          return options.spawner!(binaryPath, args) as unknown as FfmpegProcess;
        }
        : undefined,
    });
    this.commandRunner = options.commandRunner ?? defaultCommandRunner;
    this.helperPathExists = options.helperPathExists;
    this.timer = options.timer ?? defaultTimer;
    this.firstFrameTimeoutMs = options.firstFrameTimeoutMs ?? DEFAULT_FIRST_FRAME_TIMEOUT_MS;
    this.simulatorWindowResolver =
      options.simulatorWindowResolver ??
      ((helperPath, device, audioEnabled) =>
        defaultResolveSimulatorWindowId(helperPath, device, this.commandRunner, audioEnabled));
  }

  async start(): Promise<void> {
    if (this.isActive()) {
      throw new ActionableError("iOS H.264 source already started.");
    }
    await this.teardownPromise;
    this.phase = "starting";

    try {
      const helperPath = resolveIosScreenCaptureHelperPath(this.helperPath, {
        exists: this.helperPathExists,
      });
      await validateFfmpegAvailability(this.ffmpegClient, this.ffmpegPath, this.options.commandRunner);
      const target = await this.resolveCaptureTarget(helperPath);
      if (!this.isActive()) {
        return;
      }

      const helper = this.createHelper({ binaryPath: helperPath, target });
      this.helper = helper;
      this.wireHelperFrames(helper);
      const firstAudio = this.options.audioEnabled ? this.waitForFirstAudio(helper) : null;
      const firstFrame = this.waitForFirstFrame(helper, target);
      helper.start();
      await Promise.all([firstFrame, firstAudio]);
    } catch (error) {
      this.phase = "stopping";
      await this.beginTeardown();
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.isActive()) {
      await this.teardownPromise;
      return;
    }
    this.phase = "stopping";
    this.cancelFirstFrameWait?.();
    this.cancelFirstAudioWait?.();
    await this.beginTeardown();
  }

  private async resolveCaptureTarget(helperPath: string): Promise<CaptureTarget> {
    if (isIosSimulatorUdid(this.options.device.deviceId)) {
      return {
        kind: "simulator",
        windowID: await this.simulatorWindowResolver(
          helperPath,
          this.options.device,
          this.options.audioEnabled === true
        ),
        fps: this.fps,
        ...(this.options.audioEnabled === true ? { audio: true } : {}),
      };
    }
    return { kind: "device", deviceId: this.options.device.deviceId };
  }

  private waitForFirstFrame(helper: IosFrameCaptureHelper, target: CaptureTarget): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let firstFrameSeen = false;
      const finish = (callback: () => void): void => {
        if (settled) {
          return;
        }
        settled = true;
        this.timer.clearTimeout(timeout);
        if (this.cancelFirstFrameWait === cancel) {
          this.cancelFirstFrameWait = null;
        }
        callback();
      };
      const cancel = (): void => {
        finish(resolve);
      };
      const timeout = this.timer.setTimeout(() => {
        finish(() => reject(makeNoFramesError(target)));
      }, this.firstFrameTimeoutMs);
      this.cancelFirstFrameWait = cancel;

      helper.on("frame", () => {
        if (this.helper !== helper || !this.isActive()) {
          return;
        }
        firstFrameSeen = true;
        this.phase = "running";
        finish(resolve);
      });
      helper.on("stderr", line => {
        if (this.helper !== helper || !this.isActive()) {
          return;
        }
        if (isNoFramesPermissionWarning(line)) {
          finish(() => reject(makeNoFramesError(target)));
        } else if (isHelperError(line)) {
          finish(() => reject(new Error(`screen-capture-helper reported an error: ${line}`)));
        }
      });
      helper.on("error", error => {
        if (this.helper !== helper || !this.isActive()) {
          return;
        }
        if (firstFrameSeen) {
          this.failIfCurrentHelper(helper, error);
          return;
        }
        finish(() => reject(error));
      });
      helper.on("exit", info => {
        if (this.helper !== helper || !this.isActive()) {
          return;
        }
        const error = new Error(`screen-capture-helper exited (code=${info.code}, signal=${info.signal})`);
        if (firstFrameSeen) {
          this.failIfCurrentHelper(helper, error);
          return;
        }
        finish(() => reject(error));
      });
    });
  }

  private waitForFirstAudio(helper: IosFrameCaptureHelper): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void): void => {
        if (settled) {
          return;
        }
        settled = true;
        this.timer.clearTimeout(timeout);
        if (this.cancelFirstAudioWait === cancel) {
          this.cancelFirstAudioWait = null;
        }
        if (this.rejectFirstAudioWait === rejectWait) {
          this.rejectFirstAudioWait = null;
        }
        callback();
      };
      const cancel = (): void => finish(resolve);
      const rejectWait = (error: Error): void => finish(() => reject(error));
      const timeout = this.timer.setTimeout(() => {
        finish(() => reject(new ActionableError("iOS Simulator audio capture did not produce PCM audio before startup timed out.")));
      }, this.firstFrameTimeoutMs);
      this.cancelFirstAudioWait = cancel;
      this.rejectFirstAudioWait = rejectWait;
      helper.on("audio", () => {
        if (this.helper === helper && this.isActive()) {
          finish(resolve);
        }
      });
      helper.on("error", error => {
        if (this.helper === helper && this.isActive()) {
          finish(() => reject(error));
        }
      });
      helper.on("exit", info => {
        if (this.helper === helper && this.isActive()) {
          finish(() => reject(new Error(`screen-capture-helper exited before audio (code=${info.code}, signal=${info.signal})`)));
        }
      });
    });
  }

  private wireHelperFrames(helper: IosFrameCaptureHelper): void {
    helper.on("frame", frame => this.handleFrame(frame));
    helper.on("audio", audio => {
      if (this.isActive() && this.options.audioEnabled) {
        this.options.onAudioData?.(audio.pcm16le);
      }
    });
    helper.on("malformed", error => {
      logger.warn(`[IosH264Source] malformed frame from helper: ${error.reason}`);
    });
    helper.on("stderr", line => {
      if (line.length > 0) {
        logger.debug(`[IosH264Source] screen-capture-helper stderr: ${line}`);
      }
      if (isHelperError(line)) {
        this.failIfCurrentHelper(
          helper,
          new Error(`screen-capture-helper reported an error: ${line}`)
        );
      }
    });
  }

  private handleFrame(frame: DecodedFrame): void {
    if (!this.isActive()) {
      return;
    }
    const size = { width: frame.header.width, height: frame.header.height };
    if (!this.encoder) {
      this.startEncoder(size);
    } else if (this.encoderBackpressured) {
      return;
    } else if (
      this.encoderSize &&
      (this.encoderSize.width !== size.width || this.encoderSize.height !== size.height)
    ) {
      this.failIfRunning(
        new Error(
          `iOS capture frame changed size from ${this.encoderSize.width}x${this.encoderSize.height} to ${size.width}x${size.height}`
        )
      );
      return;
    }

    const accepted = this.encoder?.stdin.write(tightlyPackBgraFrame(frame));
    if (accepted === false) {
      this.encoderBackpressured = true;
    }
  }

  private startEncoder(size: EncoderSize): void {
    const args = this.buildFfmpegArgs(size);
    logger.info(`[IosH264Source] starting ffmpeg encoder: ${this.ffmpegPath} ${args.join(" ")}`);
    const { process } = this.ffmpegClient.start({
      args,
      context: "iOS WebRTC H.264 encoder",
      stdio: ["pipe", "pipe", "pipe"],
    });
    // The argv above requests piped stdin/stdout/stderr; narrow the generic
    // client process surface to the encoder contract used by this source.
    // eslint-disable-next-line auto-mobile/no-unknown-cast -- The piped-stdio contract supplies every encoder process member used below.
    const encoder = process as unknown as IosH264EncoderProcess;
    this.encoder = encoder;
    this.encoderSize = size;
    this.encoderBackpressured = false;

    encoder.stdout.on("data", chunk => {
      if (this.isActive() && this.encoder === encoder) {
        this.options.onData(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
    });
    encoder.stderr.on("data", chunk => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8").trim() : String(chunk).trim();
      if (text.length > 0) {
        logger.debug(`[IosH264Source] ffmpeg stderr: ${text}`);
      }
    });
    encoder.stdin.on("drain", () => {
      if (this.encoder === encoder) {
        this.encoderBackpressured = false;
      }
    });
    encoder.stdin.on("error", error => {
      if (this.encoder === encoder) {
        this.failIfRunning(error instanceof Error ? error : new Error(String(error)));
      }
    });
    encoder.once("error", error => {
      if (this.encoder === encoder) {
        this.failIfRunning(error);
      }
    });
    encoder.once("exit", (code, signal) => {
      if (this.encoder === encoder) {
        this.failIfRunning(new Error(`ffmpeg exited (code=${code}, signal=${signal})`));
      }
    });
  }

  private buildFfmpegArgs(size: EncoderSize): string[] {
    const args = [
      "-hide_banner",
      "-loglevel",
      "warning",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "bgra",
      "-s",
      `${size.width}x${size.height}`,
      "-r",
      String(this.fps),
      "-i",
      "pipe:0",
    ];
    if (this.options.size) {
      args.push("-vf", `scale=${this.options.size.width}:${this.options.size.height}`);
    } else {
      // Keep an unconstrained macOS capture inside the Level 4.2 capability
      // advertised in the WHIP SDP. Explicit sizes are validated before source
      // creation by webrtcStreamingConfig.
      args.push("-vf", "scale=1920:1080:force_original_aspect_ratio=decrease:force_divisible_by=2");
    }
    args.push(
      "-an",
      "-c:v",
      "h264_videotoolbox",
      "-profile:v",
      "baseline",
      "-level:v",
      "4.2",
      "-bf",
      "0",
      // Cap the keyframe interval at ~2s. ffmpeg cannot be signalled to emit an
      // IDR mid-stream over a pipe (so there is no requestKeyFrame() for this
      // source), so a bounded GOP is what lets a late or recovering WHEP viewer
      // decode promptly instead of waiting for a long default GOP. The h264
      // muxer prepends SPS/PPS to each keyframe, so every IDR is self-decodable.
      "-g",
      String(Math.max(1, Math.round(this.fps * IOS_KEYFRAME_INTERVAL_SECONDS))),
      "-forced-idr",
      "1"
    );
    if (this.options.bitrateBps && this.options.bitrateBps > 0) {
      args.push("-b:v", String(Math.round(this.options.bitrateBps)));
    }
    args.push("-f", "h264", "pipe:1");
    return args;
  }

  private failIfRunning(error: Error): void {
    if (this.phase !== "running") {
      return;
    }
    this.rejectFirstAudioWait?.(error);
    this.phase = "stopping";
    void this.beginTeardown();
    this.options.onError?.(error);
  }

  private failIfCurrentHelper(helper: IosFrameCaptureHelper, error: Error): void {
    if (this.helper !== helper) {
      return;
    }
    this.failIfRunning(error);
  }

  private isActive(): boolean {
    return this.phase === "starting" || this.phase === "running";
  }

  private beginTeardown(): Promise<void> {
    this.teardownPromise ??= this.teardown().finally(() => {
      this.teardownPromise = null;
      if (this.phase === "stopping") {
        this.phase = "idle";
      }
    });
    return this.teardownPromise;
  }

  private async teardown(): Promise<void> {
    this.cancelFirstAudioWait?.();
    this.cancelFirstAudioWait = null;
    const encoder = this.encoder;
    this.encoder = null;
    this.encoderSize = null;
    this.encoderBackpressured = false;
    encoder?.stdin.end();
    encoder?.kill("SIGTERM");

    const helper = this.helper;
    this.helper = null;
    await helper?.stop().catch(error => {
      logger.debug(`[IosH264Source] helper stop failed: ${error}`);
    });
  }
}

function makeNoFramesError(target: CaptureTarget): ActionableError {
  const hint = target.kind === "simulator"
    ? " Grant Screen Recording permission to your terminal/IDE in System Settings > Privacy & Security > Screen Recording."
    : "";
  return new ActionableError(`iOS screen capture did not produce a first frame.${hint}`);
}

function isNoFramesPermissionWarning(line: string): boolean {
  return line.toLowerCase().includes(NO_FRAMES_PERMISSION_WARNING);
}

function isHelperError(line: string): boolean {
  return line.trimStart().toLowerCase().startsWith("error:");
}

function tightlyPackBgraFrame(frame: DecodedFrame): Buffer {
  const tightBytesPerRow = frame.header.width * 4;
  if (frame.header.bytesPerRow === tightBytesPerRow) {
    return frame.pixels;
  }

  const packed = Buffer.alloc(frame.header.height * tightBytesPerRow);
  for (let row = 0; row < frame.header.height; row++) {
    const sourceStart = row * frame.header.bytesPerRow;
    frame.pixels.copy(
      packed,
      row * tightBytesPerRow,
      sourceStart,
      sourceStart + tightBytesPerRow
    );
  }
  return packed;
}

export interface IosScreenCaptureHelperPathResolverOptions {
  env?: NodeJS.ProcessEnv;
  moduleDir?: string;
  entryFile?: string;
  exists?: (candidate: string) => boolean;
}

export function resolveIosScreenCaptureHelperPath(
  explicitPath?: string,
  options: IosScreenCaptureHelperPathResolverOptions = {}
): string {
  const env = options.env ?? process.env;
  const moduleDir = options.moduleDir ?? __dirname;
  const entryFile = options.entryFile ?? process.argv[1];
  const exists = options.exists ?? existsSync;
  const candidateRoots = uniquePaths([
    ...ancestorDirs(moduleDir),
    ...(entryFile ? ancestorDirs(path.dirname(entryFile)) : []),
  ]);
  const candidates = [
    explicitPath,
    readEnvWithLegacy(env, IOS_SCREEN_CAPTURE_HELPER_ENV, IOS_SCREEN_CAPTURE_HELPER_ENV_ALIAS),
    ...candidateRoots.flatMap(root => [
      path.join(root, "ios/screen-capture/.build/debug/screen-capture-helper"),
      path.join(root, "ios/screen-capture/.build/release/screen-capture-helper"),
      path.join(root, "dist/ios/screen-capture/.build/debug/screen-capture-helper"),
      path.join(root, "dist/ios/screen-capture/.build/release/screen-capture-helper"),
    ]),
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    if (exists(candidate)) {
      return candidate;
    }
  }

  throw new ActionableError(
    `iOS WebRTC streaming requires a built screen-capture-helper. Set ${IOS_SCREEN_CAPTURE_HELPER_ENV} to its absolute path or run swift build in ios/screen-capture.`
  );
}

function readEnvWithLegacy(
  env: NodeJS.ProcessEnv,
  primaryName: string,
  legacyName: string
): string | undefined {
  return env[primaryName] ?? env[legacyName];
}

function ancestorDirs(startDir: string): string[] {
  const dirs: string[] = [];
  let current = path.resolve(startDir);
  while (true) {
    dirs.push(current);
    const parent = path.dirname(current);
    if (parent === current) {
      return dirs;
    }
    current = parent;
  }
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths)];
}

async function validateFfmpegAvailability(
  ffmpegClient: FfmpegClient,
  ffmpegPath: string,
  testCommandRunner?: CommandRunner,
): Promise<void> {
  // `commandRunner` is a long-standing test seam. Production probes must stay
  // behind FfmpegClient, while injected fakes can retain their narrow runner.
  if (testCommandRunner) {
    return validateFfmpegAvailabilityWithRunner(ffmpegPath, testCommandRunner);
  }
  try {
    await ffmpegClient.probe({ requiredEncoders: ["h264_videotoolbox"] });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("missing required encoder")) {
      throw new ActionableError(
        "iOS WebRTC streaming requires an ffmpeg build with the h264_videotoolbox encoder."
      );
    }
    throw new ActionableError(
      `iOS WebRTC streaming requires ffmpeg. Set ${IOS_WEBRTC_FFMPEG_ENV} to a working ffmpeg binary. ${message}`
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
      `iOS WebRTC streaming requires ffmpeg. Set ${IOS_WEBRTC_FFMPEG_ENV} to a working ffmpeg binary. ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (version.exitCode !== 0) {
    throw new ActionableError(
      `iOS WebRTC ffmpeg probe failed: ${version.stderr.trim() || `exited with code ${version.exitCode}`}`
    );
  }

  const encoders = await commandRunner(ffmpegPath, ["-hide_banner", "-encoders"]);
  const encoderOutput = `${encoders.stdout}\n${encoders.stderr}`;
  if (encoders.exitCode !== 0 || !encoderOutput.includes("h264_videotoolbox")) {
    throw new ActionableError(
      "iOS WebRTC streaming requires an ffmpeg build with the h264_videotoolbox encoder."
    );
  }
}

async function defaultResolveSimulatorWindowId(
  helperPath: string,
  device: BootedDevice,
  commandRunner: CommandRunner,
  audioEnabled: boolean
): Promise<number> {
  const result = await commandRunner(helperPath, ["--list-simulators"]);
  if (result.exitCode !== 0) {
    throw new ActionableError(
      `Unable to list iOS Simulator windows: ${result.stderr.trim() || `exited with code ${result.exitCode}`}`
    );
  }

  let windows: SimulatorWindowInfo[];
  try {
    windows = (JSON.parse(result.stdout) as { windows?: SimulatorWindowInfo[] }).windows ?? [];
  } catch (error) {
    throw new ActionableError(`Unable to parse iOS Simulator window list: ${error}`);
  }

  if (audioEnabled && windows.length > 1) {
    throw new ActionableError(
      "iOS Simulator audio capture requires exactly one visible Simulator window because ScreenCaptureKit cannot isolate audio to a selected Simulator window. Close other Simulator windows and try again."
    );
  }

  const deviceName = device.name.toLowerCase();
  const matches = windows.filter(window => window.title?.toLowerCase().includes(deviceName));
  if (matches.length === 1) {
    return matches[0].windowID;
  }
  if (matches.length === 0) {
    throw new ActionableError(
      `No visible iOS Simulator window matched ${device.name}. Open the simulator window and grant Screen Recording permission if prompted.`
    );
  }
  throw new ActionableError(
    `Multiple iOS Simulator windows matched ${device.name}; close extras or use a more specific device.`
  );
}
import { spawn as nodeSpawn } from "node:child_process";
