import { type ProcessTracker } from "../../utils/ChildProcessTracker";
import { type Timer } from "../../utils/SystemTimer";
import { type FfmpegClient, type FfmpegProcess } from "../../utils/media/FfmpegClient";
import { type IosScreenCaptureHelperOptions } from "../screen-stream/IosScreenCaptureHelper";
import type { DecodedFrame } from "../screen-stream/frameProtocol";
import { type VideoCaptureConfig } from "./VideoRecorderService";

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
  list(binaryPath: string, signal?: AbortSignal): Promise<CaptureDeviceInfo[]>;
}

/** Resolution seam for the signed `screen-capture-helper` binary. */
export interface ScreenCaptureHelperEnsurer {
  ensure(signal?: AbortSignal): Promise<string | null>;
}

/**
 * The slice of {@link IosScreenCaptureHelper} this backend drives. Narrow on
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
  /** Clock seam for trailing-stall padding; capture timestamps use another timebase. */
  now?: () => number;
  /** Timer seam for the bounded drain wait at stop. */
  timer?: Timer;
  /** Env seam so the developer override can be exercised without touching process.env. */
  env?: NodeJS.ProcessEnv;
  /** Existence seam for the overridden helper path. */
  helperPathExists?: (candidate: string) => boolean;
}

export interface IosPhysicalBackendHandle {
  kind: "ios-physical";
  helper: PhysicalIosCaptureHelper;
  state: CaptureState;
  config: VideoCaptureConfig;
}

/** Mutable capture bookkeeping shared between `start` and `stop`. */
export interface CaptureState {
  encoder?: FfmpegProcess;
  encoderTracker?: ProcessTracker;
  /** Frame geometry locked from the first frame; later mismatches are dropped. */
  geometry?: { width: number; height: number };
  /** Encoder chosen up front so the first frame can spawn ffmpeg synchronously. */
  encoderName: string;
  /** Capture timestamp the next admitted frame must reach, for fps pacing. */
  nextFrameDueMs?: number;
  /** Frames discarded purely to hold the declared cadence (not a fault). */
  framesPacedOut: number;
  /** Repeated frames written to keep a capture gap at its real duration. */
  framesGapFilled: number;
  /** Last payload written, repeated across gap slots that precede a new frame. */
  lastPayload?: Buffer;
  /** Wall-clock time of the last write, for trailing-stall padding. */
  lastWriteAtMs?: number;
  /** Bytes in one packed frame; the unit for the encoder-buffer budget. */
  frameBytes?: number;
  /**
   * Writes still owed to the encoder, in order. Repeats share one payload
   * reference and carry a count, so a long gap costs a counter rather than N
   * copies of a multi-megabyte buffer.
   */
  pendingWrites: { payload: Buffer; count: number }[];
  /** Gap slots left unpadded, so the output is shorter than wall clock. */
  framesGapTruncated: number;
  framesWritten: number;
  framesDropped: number;
  helperStderr: string[];
  helperExit?: { code: number | null; signal: NodeJS.Signals | null };
  /** First error emitted by the helper process (spawn ENOENT/EACCES, etc.). */
  helperError?: Error;
  /** Structured spawn failure proves the helper never became a process. */
  helperSpawnError?: Error;
  /** True once we asked the helper to stop, so its exit is expected. */
  stopRequested: boolean;
  /** Whether the observed exit happened after we asked the helper to stop. */
  helperExitWasRequested: boolean;
}
