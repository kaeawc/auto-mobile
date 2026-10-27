import type { Socket } from "node:net";
import type { BootedDevice } from "../../models";
import type { H264CaptureSource } from "../../features/webrtc/H264CaptureSource";
import type { H264AccessUnitAssembler, H264AnnexBParser } from "../../features/webrtc/h264";
import type { StreamSubscriptionKind } from "../wire/streamSubscriptionPolicy";
import type { VideoStreamSocketRequest } from "../wire/videoStreamSocketTypes";

/** Creates the capture source for a device. Injected so tests never touch adb. */
export type CaptureSourceFactory = (options: {
  device: BootedDevice;
  onData: (chunk: Buffer) => void;
  /** Fresh producer frame; used by iOS where encoder output can replay a cached frame. */
  onSourceFrame?: () => void;
  /** Genuine native Simulator idle callback, scoped to this capture generation. */
  onSourceIdle?: () => void;
  onEncodedAccessUnit?: () => void;
  onIdleAttestationSupport?: (supported: boolean) => void;
  onError: (error: Error) => void;
  /** Receives the attested display rotation (0..3) when the source can prove it (issue #4786). */
  onRotation?: (rotation: number) => void;
  /** Receives cumulative source-side encoder drops for client quality control. */
  onDroppedFrames?: (droppedFrames: number) => void;
  bitrateBps?: number;
  size?: { width: number; height: number };
  /** Aspect-preserving resolution/bitrate preset; see `VideoStreamSocketRequest.quality`. */
  quality?: "low" | "medium" | "high";
  /** Capture rate for iOS Simulator sources; see the call site for why it is pinned. */
  fps?: number;
}) => Promise<H264CaptureSource>;

/** One capture shared by every subscriber watching the same device. */
export interface DeviceCapture {
  device: BootedDevice;
  /** Latest explicit hint for each field wins; omitted fields retain their current value. */
  desiredHints: CaptureHints;
  appliedHints: CaptureHints;
  hintKind: StreamSubscriptionKind;
  /** Also identifies the SPS/PPS and GOP cache; both are cleared when this advances at swap. */
  generation: number;
  reconfigureTimer: NodeJS.Timeout | null;
  reconfiguring: Promise<void> | null;
  source: H264CaptureSource | null;
  /** Resolves only after the shared source has started, so late subscribers share startup failures. */
  startup: Promise<void>;
  /** Sockets waiting for startup, kept off the binary broadcast path until their acknowledgement. */
  pendingSubscribers: Set<Socket>;
  subscribers: Set<Socket>;
  backpressuredSubscribers: Set<Socket>;
  waitingForKeyFrame: Set<Socket>;
  /** Joiners held off the old encoder until the requested configuration is applied. */
  waitingForReplacement: Set<Socket>;
  /**
   * Most recent parameter sets (SPS/PPS). A client that joins mid-stream cannot decode until it
   * sees these, and the encoder only re-emits them on key frames.
   */
  sps: Buffer | null;
  pps: Buffer | null;
  parser: H264AnnexBParser;
  /** Bounded, complete IDR access unit for a late viewer of an unchanged screen. */
  keyFrameAssembler: H264AccessUnitAssembler;
  keyFrameAuBytes: number;
  latestKeyFrameAu: Buffer | null;
  latestInterFrameAus: Buffer[];
  cachedGopBytes: number;
  sourceFrameSequence: number;
  lastEncodedBoundarySequence: number | null;
  /**
   * Latest attested display rotation (0..3) from the source, or null when the source cannot attest
   * it (screenrecord/iOS) or none has arrived yet (issue #4786). Re-emitted on every config packet
   * the relay writes so a late joiner or a post-rotation client sees the current orientation.
   */
  rotation: number | null;
  idleTimer: NodeJS.Timeout | null;
  /**
   * Fires every `HEARTBEAT_INTERVAL_MS` once either pipeline stage reports data (issue #7549),
   * null before then and after teardown. A single stage arms retirement without sending packets.
   */
  heartbeatTimer: NodeJS.Timeout | null;
  /** First producer or encoder evidence; bounds startup when the other stage never reports. */
  firstEvidenceMs: number | null;
  /** Time of the latest fresh producer frame, never refreshed by replay or the relay. */
  lastSourceDataMs: number | null;
  /** Native producer-idle evidence; cleared by the next complete source frame. */
  lastIdleMs: number | null;
  /** An encoded chunk followed the most recent complete source frame. */
  encodedSinceSourceFrame: boolean;
  /** Temporary compatibility for a released helper without native idle markers. */
  legacySimulatorHelper: boolean;
  /** Time of the latest encoded output; both producer and encoder must keep making progress. */
  lastEncodedDataMs: number | null;
  /** Limits active key-frame probes while a source is quiet. A request is not proof of life. */
  lastLivenessProbeMs: number | null;
}

export type CaptureHints = Pick<
  VideoStreamSocketRequest,
  "quality" | "fps" | "bitrateKbps" | "size"
>;
