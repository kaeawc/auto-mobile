import { type ProcessTracker } from "../../utils/ChildProcessTracker";
import { type Timer } from "../../utils/SystemTimer";
import { type FfmpegClient, type FfmpegProcess } from "../../utils/media/FfmpegClient";
import { type IosScreenCaptureHelperOptions } from "../screen-stream/IosScreenCaptureHelper";
import type { DecodedEncodedVideo, MalformedFrameError } from "../screen-stream/frameProtocol";
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
 * purpose: a fake only has to emit encoded records and exit.
 */
export interface PhysicalIosCaptureHelper {
  start(): void | Promise<void>;
  stop(): Promise<unknown>;
  on(event: "encodedVideo", listener: (video: DecodedEncodedVideo) => void): unknown;
  on(event: "malformed", listener: (error: MalformedFrameError) => void): unknown;
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
  /** Clock seam for the reported end time of a recording. */
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
  framesWritten: number;
  /** Records discarded before the first keyframe or while the muxer stalled. */
  framesDropped: number;
  /** True while shedding records from a stalled muxer until the next keyframe. */
  awaitingKeyframe?: boolean;
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
