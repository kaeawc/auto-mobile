import { ActionableError, type BootedDevice } from "../../models";
import { logger } from "../../utils/logger";
import { errorMessage } from "../../utils/describeUnknownError";
import { getFileSize, waitForExit, type ProcessTracker } from "../../utils/ChildProcessTracker";
import {
  DefaultHostCommandExecutor,
  type HostCommandExecutor,
} from "../../utils/HostCommandExecutor";
import {
  DefaultFfmpegClient,
  type FfmpegClient,
  type FfmpegProcess,
} from "../../utils/media/FfmpegClient";
import type { DecodedFrame } from "../screen-stream/frameProtocol";
import {
  IOSScreenCaptureHelper,
  type IosScreenCaptureHelperOptions,
} from "../screen-stream/IOSScreenCaptureHelper";
import { ScreenCaptureHelperProvider } from "../screen-stream/ScreenCaptureHelperProvider";
import type {
  RecordingHandle,
  RecordingResult,
  VideoCaptureBackend,
  VideoCaptureConfig,
} from "./VideoRecorderService";

/** Hardware H.264 encoder used whenever the host ffmpeg exposes it. */
export const VIDEOTOOLBOX_H264_ENCODER = "h264_videotoolbox";
/** Software fallback for an ffmpeg built without VideoToolbox. */
export const SOFTWARE_H264_ENCODER = "libx264";

/** Bytes per BGRA pixel — the helper's only raw pixel format. */
const BGRA_BYTES_PER_PIXEL = 4;

/** How long ffmpeg gets to finalize the MP4 (moov atom) after stdin closes. */
export const IOS_PHYSICAL_ENCODER_FINALIZE_TIMEOUT_MS = 30000;

/** Stderr lines retained from the helper for failure diagnostics. */
const HELPER_STDERR_TAIL = 20;

/**
 * One entry of the helper's `--list-devices` JSON. Mirrors the Swift
 * `DeviceInfo` (`ios/screen-capture/Sources/ScreenCaptureCore/DeviceInfo.swift`).
 */
export interface CaptureDeviceInfo {
  uniqueID: string;
  localizedName: string;
  modelID: string;
  manufacturer: string;
}

/**
 * Enumerates the AVFoundation muxed capture devices the helper can see. The
 * `uniqueID` AVFoundation reports is *not* guaranteed to be spelled like the
 * AutoMobile UDID, and `--device-id` matches it exactly (see
 * `ScreenCaptureHelper/main.swift`), so the mapping has to be resolved here.
 */
export interface CaptureDeviceLister {
  list(binaryPath: string): Promise<CaptureDeviceInfo[]>;
}

/** Resolution seam for the signed `screen-capture-helper` binary. */
export interface ScreenCaptureHelperEnsurer {
  ensure(): Promise<string | null>;
}

/**
 * The slice of {@link IOSScreenCaptureHelper} this backend drives. Narrow on
 * purpose: a fake only has to emit frames and exit.
 */
export interface PhysicalIosCaptureHelper {
  start(): void | Promise<void>;
  stop(): Promise<unknown>;
  on(event: "frame", listener: (frame: DecodedFrame) => void): unknown;
  on(event: "stderr", listener: (line: string) => void): unknown;
  on(
    event: "exit",
    listener: (info: { code: number | null; signal: NodeJS.Signals | null }) => void,
  ): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
}

export type PhysicalIosCaptureHelperFactory = (
  options: IosScreenCaptureHelperOptions,
) => PhysicalIosCaptureHelper;

export interface IosPhysicalVideoCaptureBackendOptions {
  ffmpegClient?: FfmpegClient;
  helperProvider?: ScreenCaptureHelperEnsurer;
  deviceLister?: CaptureDeviceLister;
  createHelper?: PhysicalIosCaptureHelperFactory;
  /** Injectable so the non-macOS rejection is testable on any CI host. */
  platformProvider?: () => NodeJS.Platform;
  /** Injectable so file-size reporting stays device- and disk-free in tests. */
  fileSize?: (filePath: string) => Promise<number | undefined>;
  encoderFinalizeTimeoutMs?: number;
}

interface IosPhysicalBackendHandle {
  kind: "ios-physical";
  helper: PhysicalIosCaptureHelper;
  state: CaptureState;
  config: VideoCaptureConfig;
}

/** Mutable capture bookkeeping shared between `start` and `stop`. */
interface CaptureState {
  encoder?: FfmpegProcess;
  encoderTracker?: ProcessTracker;
  /** Frame geometry locked from the first frame; later mismatches are dropped. */
  geometry?: { width: number; height: number };
  /** Encoder chosen up front so the first frame can spawn ffmpeg synchronously. */
  encoderName: string;
  framesWritten: number;
  framesDropped: number;
  helperStderr: string[];
  helperExit?: { code: number | null; signal: NodeJS.Signals | null };
}

/**
 * `xcrun devicectl` has no screen-recording verb and `simctl io recordVideo` is
 * Simulator-only, so physical-iOS capture goes through the Swift
 * `screen-capture-helper`: CoreMediaIO exposes the USB-connected device as a
 * muxed `AVCaptureDevice`, the helper streams its BGRA frames to stdout, and
 * this backend pipes them into `ffmpeg -f rawvideo` for H.264 encoding.
 *
 * Structurally this mirrors {@link FfmpegVideoProcessingBackend}'s Android path
 * (`adb exec-out screenrecord -` → ffmpeg stdin); the difference is the input
 * format, and that raw frames carry no geometry, so ffmpeg cannot be spawned
 * until the first frame pins `-video_size` (issue #2504).
 */
export class IosPhysicalVideoCaptureBackend implements VideoCaptureBackend {
  private readonly ffmpegClient: FfmpegClient;
  private readonly helperProvider: ScreenCaptureHelperEnsurer;
  private readonly deviceLister: CaptureDeviceLister;
  private readonly createHelper: PhysicalIosCaptureHelperFactory;
  private readonly platformProvider: () => NodeJS.Platform;
  private readonly fileSize: (filePath: string) => Promise<number | undefined>;
  private readonly encoderFinalizeTimeoutMs: number;

  constructor(options: IosPhysicalVideoCaptureBackendOptions = {}) {
    this.ffmpegClient = options.ffmpegClient ?? new DefaultFfmpegClient();
    this.helperProvider = options.helperProvider ?? ScreenCaptureHelperProvider.getInstance();
    this.deviceLister = options.deviceLister ?? new HelperCaptureDeviceLister();
    this.createHelper =
      options.createHelper ?? ((helperOptions) => new IOSScreenCaptureHelper(helperOptions));
    this.platformProvider = options.platformProvider ?? (() => process.platform);
    this.fileSize = options.fileSize ?? getFileSize;
    this.encoderFinalizeTimeoutMs =
      options.encoderFinalizeTimeoutMs ?? IOS_PHYSICAL_ENCODER_FINALIZE_TIMEOUT_MS;
  }

  async start(config: VideoCaptureConfig): Promise<RecordingHandle> {
    const device = config.device;
    if (!device) {
      throw new ActionableError("Device is required to start video recording.");
    }
    if (this.platformProvider() !== "darwin") {
      throw new ActionableError(
        "Physical iOS video recording requires macOS: the capture path uses CoreMediaIO/AVFoundation " +
          "through the screen-capture-helper, which only exists on macOS.",
      );
    }

    const encoderName = await this.resolveEncoder();
    const binaryPath = await this.resolveHelperBinary();
    const uniqueId = await this.resolveCaptureUniqueId(binaryPath, device);

    const state: CaptureState = {
      encoderName,
      framesWritten: 0,
      framesDropped: 0,
      helperStderr: [],
    };
    const helper = this.createHelper({
      binaryPath,
      target: { kind: "device", deviceId: uniqueId },
    });

    helper.on("stderr", (line) => {
      state.helperStderr.push(line);
      if (state.helperStderr.length > HELPER_STDERR_TAIL) {
        state.helperStderr.shift();
      }
    });
    helper.on("exit", (info) => {
      state.helperExit = info;
    });
    helper.on("error", (error) => {
      // The helper process failing is surfaced from stop() with the stderr tail;
      // an unhandled 'error' listener would otherwise crash the daemon.
      logger.warn(`[IosPhysicalVideo] capture helper error: ${errorMessage(error)}`);
    });
    helper.on("frame", (frame) => this.onFrame(frame, state, config));

    await helper.start();

    return {
      recordingId: config.recordingId,
      outputPath: config.outputPath,
      startedAt: config.startedAt,
      backendHandle: {
        kind: "ios-physical",
        helper,
        state,
        config,
      } satisfies IosPhysicalBackendHandle,
    };
  }

  async stop(handle: RecordingHandle): Promise<RecordingResult> {
    const backendHandle = handle.backendHandle as IosPhysicalBackendHandle | undefined;
    if (!backendHandle || backendHandle.kind !== "ios-physical") {
      throw new Error("Missing backend handle for physical iOS video recording.");
    }
    const { helper, state } = backendHandle;

    await helper.stop();

    const encoder = state.encoder;
    if (!encoder) {
      throw new ActionableError(this.buildNoFramesMessage(state));
    }

    // Closing stdin is what makes ffmpeg write the moov atom; a SIGKILL here
    // would leave an unplayable file, so wait for a clean exit instead.
    encoder.stdin?.end();
    if (state.encoderTracker) {
      // `signal: null`: closing stdin is the finalize mechanism, so a SIGINT here
      // would race the moov write. The timeout still escalates to SIGKILL if the
      // encoder wedges, matching the iOS simulator stop discipline.
      await waitForExit(encoder, state.encoderTracker.exitPromise, {
        timeoutMs: this.encoderFinalizeTimeoutMs,
        signal: null,
      });
    }

    const sizeBytes = await this.fileSize(handle.outputPath);
    if (state.framesDropped > 0) {
      logger.warn(
        `[IosPhysicalVideo] dropped ${state.framesDropped} frame(s) whose geometry differed from the locked ` +
          `${state.geometry?.width}x${state.geometry?.height} capture size (device rotation is not re-negotiated mid-recording).`,
      );
    }

    return {
      recordingId: handle.recordingId,
      outputPath: handle.outputPath,
      startedAt: handle.startedAt,
      endedAt: state.encoderTracker?.exitState.endedAt ?? new Date().toISOString(),
      sizeBytes,
      codec: "h264",
    };
  }

  async forceStop(handle: RecordingHandle): Promise<void> {
    const backendHandle = handle.backendHandle as IosPhysicalBackendHandle | undefined;
    if (!backendHandle || backendHandle.kind !== "ios-physical") {
      throw new Error("Missing backend handle for physical iOS video recording.");
    }
    await backendHandle.helper.stop();
    const encoder = backendHandle.state.encoder;
    if (encoder && encoder.exitCode === null && !encoder.killed) {
      encoder.kill("SIGKILL");
    }
  }

  private onFrame(frame: DecodedFrame, state: CaptureState, config: VideoCaptureConfig): void {
    const { width, height } = frame.header;
    if (!state.geometry) {
      state.geometry = { width, height };
      this.startEncoder(state, config, width, height);
    } else if (state.geometry.width !== width || state.geometry.height !== height) {
      // rawvideo has no per-frame geometry: a differently sized frame would be
      // read as a shifted picture for the rest of the file, so drop it.
      state.framesDropped += 1;
      return;
    }

    const encoder = state.encoder;
    if (!encoder?.stdin || encoder.stdin.writableEnded) {
      state.framesDropped += 1;
      return;
    }
    encoder.stdin.write(packFrame(frame));
    state.framesWritten += 1;
  }

  private startEncoder(
    state: CaptureState,
    config: VideoCaptureConfig,
    width: number,
    height: number,
  ): void {
    const args = buildRawVideoFfmpegArgs(config, width, height, state.encoderName);
    logger.info(
      `[IosPhysicalVideo] starting encoder: ${this.ffmpegClient.binaryPath} ${args.join(" ")}`,
    );
    const started = this.ffmpegClient.start({
      args,
      context: "physical iOS screen recording encoder",
      stdio: ["pipe", "pipe", "pipe"],
    });
    state.encoder = started.process;
    state.encoderTracker = started.tracker;
    started.process.stdin?.on("error", (error: Error) => {
      // ffmpeg exiting first closes stdin; the helper keeps writing until it is
      // stopped, so EPIPE here is expected rather than a fault to surface.
      logger.debug(`[IosPhysicalVideo] encoder stdin error (expected on encoder exit): ${error}`);
    });
  }

  /**
   * Doubles as the ffmpeg availability check. VideoToolbox is present on every
   * supported macOS host, but a self-built ffmpeg can lack it, so fall back to
   * software encoding rather than failing the recording.
   */
  private async resolveEncoder(): Promise<string> {
    let encoders: string[];
    try {
      encoders = (await this.ffmpegClient.probe()).encoders;
    } catch (error) {
      throw new ActionableError(
        "FFmpeg is not available. Please install FFmpeg to use video recording.\n" +
          "  macOS: brew install ffmpeg\n" +
          `Error: ${errorMessage(error)}`,
      );
    }
    if (encoders.includes(VIDEOTOOLBOX_H264_ENCODER)) {
      return VIDEOTOOLBOX_H264_ENCODER;
    }
    logger.warn(
      `[IosPhysicalVideo] ${VIDEOTOOLBOX_H264_ENCODER} unavailable; falling back to software ${SOFTWARE_H264_ENCODER}.`,
    );
    return SOFTWARE_H264_ENCODER;
  }

  private buildNoFramesMessage(state: CaptureState): string {
    const stderr = state.helperStderr.join("").trim();
    const exit = state.helperExit
      ? ` (helper exited code=${state.helperExit.code ?? "null"} signal=${state.helperExit.signal ?? "null"})`
      : "";
    return (
      `No frames were captured from the physical iOS device${exit}, so no recording was produced. ` +
      "Connect the device over USB and accept the Trust This Computer prompt, then retry." +
      (stderr ? `\nscreen-capture-helper: ${stderr}` : "")
    );
  }

  private async resolveHelperBinary(): Promise<string> {
    const binaryPath = await this.helperProvider.ensure();
    if (!binaryPath) {
      throw new ActionableError(
        "Physical iOS video recording requires the signed screen-capture-helper from the matching GitHub Release, " +
          "which could not be resolved. For local development, build it with `bash scripts/ios/swift-build.sh` and " +
          "set AUTOMOBILE_IOS_SCREEN_CAPTURE_HELPER to the resulting absolute path.",
      );
    }
    return binaryPath;
  }

  /**
   * Map the AutoMobile UDID onto the AVFoundation `uniqueID` the helper matches
   * on. The two agree on most hardware, but the reported id has been observed
   * without the UDID's hyphen, so fall back to a normalized comparison and then
   * — only when exactly one device is attached — to that device.
   */
  private async resolveCaptureUniqueId(binaryPath: string, device: BootedDevice): Promise<string> {
    const devices = await this.deviceLister.list(binaryPath);
    if (devices.length === 0) {
      throw new ActionableError(
        `No muxed external capture devices found for ${device.deviceId}. Connect the iPhone/iPad over USB, ` +
          "accept the Trust This Computer prompt, and make sure it is not already being captured by QuickTime.",
      );
    }

    const exact = devices.find((candidate) => candidate.uniqueID === device.deviceId);
    if (exact) {
      return exact.uniqueID;
    }

    const wanted = normalizeUdid(device.deviceId);
    const normalized = devices.find((candidate) => normalizeUdid(candidate.uniqueID) === wanted);
    if (normalized) {
      return normalized.uniqueID;
    }

    if (devices.length === 1) {
      logger.warn(
        `[IosPhysicalVideo] capture device uniqueID ${devices[0].uniqueID} does not match ${device.deviceId}; ` +
          "using the only attached device.",
      );
      return devices[0].uniqueID;
    }

    const candidates = devices
      .map((candidate) => `${candidate.uniqueID} (${candidate.localizedName})`)
      .join(", ");
    throw new ActionableError(
      `Could not match device ${device.deviceId} to an AVFoundation capture device. Attached: ${candidates}. ` +
        "Disconnect the other devices, or record the matching UDID.",
    );
  }
}

/** Lowercased, separator-free UDID for cross-vocabulary comparison. */
function normalizeUdid(value: string): string {
  return value.replace(/-/g, "").toLowerCase();
}

/**
 * Strip row padding so the buffer is exactly `width * height * 4` bytes. The
 * helper reports `bytesPerRow` from the IOSurface, which AVFoundation aligns up;
 * feeding the padded rows to `-f rawvideo` would skew every row of the picture.
 */
export function packFrame(frame: DecodedFrame): Buffer {
  const { width, height, bytesPerRow } = frame.header;
  const rowBytes = width * BGRA_BYTES_PER_PIXEL;
  if (bytesPerRow === rowBytes) {
    return frame.pixels;
  }
  const packed = Buffer.allocUnsafe(rowBytes * height);
  for (let row = 0; row < height; row++) {
    frame.pixels.copy(packed, row * rowBytes, row * bytesPerRow, row * bytesPerRow + rowBytes);
  }
  return packed;
}

/**
 * ffmpeg argv for the raw-BGRA input. Kept as a free function so the encoder
 * contract can be asserted without spawning anything.
 */
export function buildRawVideoFfmpegArgs(
  config: VideoCaptureConfig,
  width: number,
  height: number,
  encoderName: string,
): string[] {
  const args = [
    "-f",
    "rawvideo",
    "-pixel_format",
    "bgra",
    "-video_size",
    `${width}x${height}`,
    "-framerate",
    String(config.fps),
    "-i",
    "pipe:0",
  ];

  if (config.resolution) {
    args.push("-vf", `scale=${config.resolution.width}:${config.resolution.height}`);
  }

  args.push("-c:v", encoderName);
  if (encoderName === SOFTWARE_H264_ENCODER) {
    args.push("-preset", "ultrafast");
  }
  args.push("-b:v", `${config.targetBitrateKbps}k`);
  args.push("-pix_fmt", "yuv420p");
  args.push("-movflags", "+faststart");

  if (config.maxDurationSeconds && config.maxDurationSeconds > 0) {
    args.push("-t", String(config.maxDurationSeconds));
  }

  args.push("-y", config.outputPath);
  return args;
}

/**
 * Production {@link CaptureDeviceLister}: runs the helper's `--list-devices`
 * mode, which prints the JSON device list to stdout and exits.
 */
export class HelperCaptureDeviceLister implements CaptureDeviceLister {
  constructor(
    private readonly executor: HostCommandExecutor = new DefaultHostCommandExecutor(),
    private readonly timeoutMs: number = 15000,
  ) {}

  async list(binaryPath: string): Promise<CaptureDeviceInfo[]> {
    const result = await this.executor.executeCommand(binaryPath, ["--list-devices"], {
      timeoutMs: this.timeoutMs,
    });
    return parseCaptureDeviceList(result.stdout);
  }
}

/** Parse the `--list-devices` envelope, tolerating a helper that lists nothing. */
export function parseCaptureDeviceList(stdout: string): CaptureDeviceInfo[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    throw new ActionableError(
      `screen-capture-helper --list-devices returned unparseable output: ${errorMessage(error)}`,
    );
  }
  const devices = (parsed as { devices?: unknown } | null)?.devices;
  if (!Array.isArray(devices)) {
    throw new ActionableError(
      "screen-capture-helper --list-devices returned no `devices` array; the helper may be out of date.",
    );
  }
  return devices
    .map((entry) => entry as Partial<CaptureDeviceInfo> | null)
    .filter(
      (entry): entry is Partial<CaptureDeviceInfo> & { uniqueID: string } =>
        typeof entry?.uniqueID === "string" && entry.uniqueID.length > 0,
    )
    .map((entry) => ({
      uniqueID: entry.uniqueID,
      localizedName: entry.localizedName ?? entry.uniqueID,
      modelID: entry.modelID ?? "",
      manufacturer: entry.manufacturer ?? "",
    }));
}
