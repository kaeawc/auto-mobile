import { spawn as nodeSpawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import { ActionableError, type BootedDevice } from "../../models";
import { IOSScreenCaptureHelper } from "../screen-stream/IOSScreenCaptureHelper";
import type {
  CaptureTarget,
  DecodedFrame,
  IosScreenCaptureHelperOptions,
  MalformedFrameError,
} from "../screen-stream";
import { isIosSimulatorUdid } from "../../utils/ios-cmdline-tools/iosDeviceType";
import { logger } from "../../utils/logger";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import type { H264CaptureSource, H264CaptureSourceOptions } from "./H264CaptureSource";

export const IOS_SCREEN_CAPTURE_HELPER_ENV = "AUTOMOBILE_IOS_SCREEN_CAPTURE_HELPER";
export const IOS_WEBRTC_FFMPEG_ENV = "AUTOMOBILE_IOS_WEBRTC_FFMPEG";
const DEFAULT_IOS_WEBRTC_FPS = 30;
const DEFAULT_FIRST_FRAME_TIMEOUT_MS = 5_000;
const NO_FRAMES_PERMISSION_WARNING = "warn: no frames received";

export interface IosFrameCaptureHelper {
  start(): void;
  stop(): Promise<unknown>;
  on(event: "frame", listener: (frame: DecodedFrame) => void): this;
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
  device: BootedDevice
) => Promise<number>;

interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

type CommandRunner = (command: string, args: string[]) => Promise<CommandResult>;

export interface IosH264SourceOptions extends H264CaptureSourceOptions {
  helperPath?: string;
  ffmpegPath?: string;
  fps?: number;
  createHelper?: IosFrameCaptureHelperFactory;
  spawner?: IosH264EncoderSpawner;
  simulatorWindowResolver?: IosSimulatorWindowResolver;
  commandRunner?: CommandRunner;
  timer?: Timer;
  firstFrameTimeoutMs?: number;
}

interface SimulatorWindowInfo {
  windowID: number;
  title?: string | null;
  applicationName?: string;
}

interface EncoderSize {
  width: number;
  height: number;
}

const defaultEncoderSpawner: IosH264EncoderSpawner = (command, args) => {
  const child = nodeSpawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
  // eslint-disable-next-line auto-mobile/no-unknown-cast -- node's ChildProcessByStdio has the stdin/stdout/stderr members this source requires; the stricter local interface keeps tests injectable.
  return child as unknown as IosH264EncoderProcess;
};

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

export class IosH264Source implements H264CaptureSource {
  private readonly helperPath?: string;
  private readonly ffmpegPath: string;
  private readonly fps: number;
  private readonly createHelper: IosFrameCaptureHelperFactory;
  private readonly spawner: IosH264EncoderSpawner;
  private readonly simulatorWindowResolver: IosSimulatorWindowResolver;
  private readonly commandRunner: CommandRunner;
  private readonly timer: Timer;
  private readonly firstFrameTimeoutMs: number;

  private helper: IosFrameCaptureHelper | null = null;
  private encoder: IosH264EncoderProcess | null = null;
  private encoderSize: EncoderSize | null = null;
  private running = false;

  constructor(private readonly options: IosH264SourceOptions) {
    this.helperPath = options.helperPath;
    this.ffmpegPath = options.ffmpegPath ?? process.env[IOS_WEBRTC_FFMPEG_ENV] ?? "ffmpeg";
    this.fps = options.fps ?? DEFAULT_IOS_WEBRTC_FPS;
    this.createHelper = options.createHelper ?? (helperOptions => new IOSScreenCaptureHelper(helperOptions));
    this.spawner = options.spawner ?? defaultEncoderSpawner;
    this.commandRunner = options.commandRunner ?? defaultCommandRunner;
    this.timer = options.timer ?? defaultTimer;
    this.firstFrameTimeoutMs = options.firstFrameTimeoutMs ?? DEFAULT_FIRST_FRAME_TIMEOUT_MS;
    this.simulatorWindowResolver =
      options.simulatorWindowResolver ??
      ((helperPath, device) =>
        defaultResolveSimulatorWindowId(helperPath, device, this.commandRunner));
  }

  async start(): Promise<void> {
    if (this.running) {
      throw new ActionableError("iOS H.264 source already started.");
    }
    this.running = true;

    try {
      const helperPath = resolveIosScreenCaptureHelperPath(this.helperPath);
      await validateFfmpegAvailability(this.ffmpegPath, this.commandRunner);
      const target = await this.resolveCaptureTarget(helperPath);
      if (!this.running) {
        return;
      }

      const helper = this.createHelper({ binaryPath: helperPath, target });
      this.helper = helper;
      this.wireHelper(helper);
      const firstFrame = this.waitForFirstFrame(helper, target);
      helper.start();
      await firstFrame;
    } catch (error) {
      this.running = false;
      await this.teardown();
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }
    this.running = false;
    await this.teardown();
  }

  private async resolveCaptureTarget(helperPath: string): Promise<CaptureTarget> {
    if (isIosSimulatorUdid(this.options.device.deviceId)) {
      return {
        kind: "simulator",
        windowID: await this.simulatorWindowResolver(helperPath, this.options.device),
      };
    }
    return { kind: "device", deviceId: this.options.device.deviceId };
  }

  private waitForFirstFrame(helper: IosFrameCaptureHelper, target: CaptureTarget): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void): void => {
        if (settled) {
          return;
        }
        settled = true;
        this.timer.clearTimeout(timeout);
        callback();
      };
      const timeout = this.timer.setTimeout(() => {
        finish(() => reject(makeNoFramesError(target)));
      }, this.firstFrameTimeoutMs);

      helper.on("frame", () => finish(resolve));
      helper.on("stderr", line => {
        if (isNoFramesPermissionWarning(line)) {
          finish(() => reject(makeNoFramesError(target)));
        }
      });
      helper.on("error", error => finish(() => reject(error)));
      helper.on("exit", info => {
        finish(() =>
          reject(new Error(`screen-capture-helper exited (code=${info.code}, signal=${info.signal})`))
        );
      });
    });
  }

  private wireHelper(helper: IosFrameCaptureHelper): void {
    helper.on("frame", frame => this.handleFrame(frame));
    helper.on("malformed", error => {
      logger.warn(`[IosH264Source] malformed frame from helper: ${error.reason}`);
    });
    helper.on("stderr", line => {
      if (line.length > 0) {
        logger.debug(`[IosH264Source] screen-capture-helper stderr: ${line}`);
      }
    });
    helper.on("error", error => this.failIfRunning(error));
    helper.on("exit", info => {
      this.failIfRunning(
        new Error(`screen-capture-helper exited (code=${info.code}, signal=${info.signal})`)
      );
    });
  }

  private handleFrame(frame: DecodedFrame): void {
    if (!this.running) {
      return;
    }
    const size = { width: frame.header.width, height: frame.header.height };
    if (!this.encoder) {
      this.startEncoder(size);
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

    this.encoder?.stdin.write(tightlyPackBgraFrame(frame));
  }

  private startEncoder(size: EncoderSize): void {
    const args = this.buildFfmpegArgs(size);
    logger.info(`[IosH264Source] starting ffmpeg encoder: ${this.ffmpegPath} ${args.join(" ")}`);
    const encoder = this.spawner(this.ffmpegPath, args);
    this.encoder = encoder;
    this.encoderSize = size;

    encoder.stdout.on("data", chunk => {
      if (this.encoder === encoder) {
        this.options.onData(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
    });
    encoder.stderr.on("data", chunk => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8").trim() : String(chunk).trim();
      if (text.length > 0) {
        logger.debug(`[IosH264Source] ffmpeg stderr: ${text}`);
      }
    });
    encoder.stdin.on("error", error => {
      this.failIfRunning(error instanceof Error ? error : new Error(String(error)));
    });
    encoder.once("error", error => this.failIfRunning(error));
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
    }
    args.push(
      "-an",
      "-c:v",
      "h264_videotoolbox",
      "-profile:v",
      "baseline",
      "-bf",
      "0"
    );
    if (this.options.bitrateBps && this.options.bitrateBps > 0) {
      args.push("-b:v", String(Math.round(this.options.bitrateBps)));
    }
    args.push("-f", "h264", "pipe:1");
    return args;
  }

  private failIfRunning(error: Error): void {
    if (!this.running) {
      return;
    }
    this.running = false;
    void this.teardown();
    this.options.onError?.(error);
  }

  private async teardown(): Promise<void> {
    const helper = this.helper;
    this.helper = null;
    await helper?.stop().catch(error => {
      logger.debug(`[IosH264Source] helper stop failed: ${error}`);
    });

    const encoder = this.encoder;
    this.encoder = null;
    this.encoderSize = null;
    encoder?.stdin.end();
    encoder?.kill("SIGTERM");
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
  exists?: (candidate: string) => boolean;
}

export function resolveIosScreenCaptureHelperPath(
  explicitPath?: string,
  options: IosScreenCaptureHelperPathResolverOptions = {}
): string {
  const env = options.env ?? process.env;
  const moduleDir = options.moduleDir ?? __dirname;
  const exists = options.exists ?? existsSync;
  const candidateRoots = [
    path.resolve(moduleDir, ".."),
    path.resolve(moduleDir, "..", "..", ".."),
  ];
  const candidates = [
    explicitPath,
    env[IOS_SCREEN_CAPTURE_HELPER_ENV],
    ...candidateRoots.flatMap(root => [
      path.join(root, "ios/screen-capture/.build/debug/screen-capture-helper"),
      path.join(root, "ios/screen-capture/.build/release/screen-capture-helper"),
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

async function validateFfmpegAvailability(
  ffmpegPath: string,
  commandRunner: CommandRunner
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
  commandRunner: CommandRunner
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

  const deviceName = device.name.toLowerCase();
  const matches = windows.filter(window => window.title?.toLowerCase().includes(deviceName));
  if (matches.length === 1) {
    return matches[0].windowID;
  }
  if (matches.length === 0 && windows.length === 1) {
    return windows[0].windowID;
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
