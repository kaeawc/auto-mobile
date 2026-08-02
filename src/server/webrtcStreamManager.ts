import { ActionableError, type BootedDevice } from "../models";
import { logger } from "../utils/logger";
import { defaultIdGenerator, type IdGenerator } from "../utils/IdGenerator";
import { defaultTimer, type Timer } from "../utils/SystemTimer";
import {
  createH264CaptureSource,
  resolveVideoServerJar,
  WebRtcPublisher,
  resolveWebRtcStreamingConfig,
  type H264CaptureSource,
  type H264CaptureSourceMetrics,
  type H264CaptureSourceOptions,
  type H264CaptureSourceTelemetry,
  type WebRtcCaptureSourceState,
  type WebRtcPublisherConfig,
  type WebRtcPublisherDeps,
  type WebRtcPublisherLifecycleEvent,
  type WebRtcStreamDescriptor,
  type WebRtcStreamingOverrides,
  H264AnnexBParser,
  nalUnitType,
  NAL_TYPE_IDR,
  NAL_TYPE_PPS,
  NAL_TYPE_SPS,
} from "../features/webrtc";

export type VideoStreamLifecycleState =
  | "idle"
  | "preparing"
  | "capture_ready"
  | "publishing"
  | "degraded"
  | "stopping"
  | "failed";

export type VideoStreamFailureCode =
  | "capture_start_failed"
  | "capture_runtime_failed"
  | "whip_publish_failed"
  | "capture_ready_timeout"
  | "publishing_timeout"
  | "stopped";

export interface VideoStreamFailure {
  code: VideoStreamFailureCode;
  message: string;
  at: string;
}

export interface VideoStreamTelemetry {
  requestReceived: string;
  captureSourcePrepared?: string;
  firstMediaFrame?: string;
  firstIdr?: string;
  sdpOffer?: string;
  sdpAnswer?: string;
  iceConnected?: string;
  firstRtpSent?: string;
  nonTrickleIceGatheringDelayMs?: number;
}

export interface StartWebRtcStreamRequest {
  device: BootedDevice;
  streamId?: string;
  /** Existing lease identity to renew instead of minting another consumer. */
  leaseId?: string;
  overrides?: WebRtcStreamingOverrides;
}

interface WebRtcStreamRecord {
  streamId: string;
  device: BootedDevice;
  publisher: WebRtcPublisher;
  source: H264CaptureSource | null;
  /** Persistent-encoder jar resolved once at stream start; null → screenrecord. */
  jarPath: string | null;
  bitrateBps?: number;
  size?: { width: number; height: number };
  /**
   * Capture rate handed to the source. For Android it is `config.androidFps`
   * (forwarded to the video-server as `--fps`); for iOS it is
   * `config.iosSimulatorFps`. Physical-iOS captures at its own device rate.
   */
  fps: number;
  audioEnabled: boolean;
  startedAt: string;
  /**
   * True once this session's capture source started. Surfaced on the descriptor
   * so an out-of-process observer can separate "WHIP publish accepted" from
   * "capture running" — a video-only start returns before capture begins.
   */
  sourceStarted: boolean;
  sourceState: WebRtcCaptureSourceState;
  lastSourceError: string | null;
  sourceTelemetry: H264CaptureSourceTelemetry | null;
  frameMetrics?: H264CaptureSourceMetrics;
  lifecycleState: VideoStreamLifecycleState;
  failure: VideoStreamFailure | null;
  telemetry: VideoStreamTelemetry;
  sourceFailed: boolean;
  mediaParser: H264AnnexBParser;
  cachedSps: Buffer | null;
  cachedPps: Buffer | null;
  stateWaiters: Set<() => void>;
  leases: Map<string, number>;
  leaseExpiryHandle: NodeJS.Timeout | null;
}

export interface WebRtcStreamManagerDependencies {
  idGenerator: IdGenerator;
  createPublisher: (config: WebRtcPublisherConfig, deps: WebRtcPublisherDeps) => WebRtcPublisher;
  createSource: (options: H264CaptureSourceOptions, jarPath: string | null) => H264CaptureSource;
  /**
   * Resolve the Android persistent-encoder jar once, off the frame path. Returns
   * the verified path, or null to degrade to screenrecord; throws on a fatal
   * fail-mode (checksum mismatch, or REQUIRE with nothing available). Non-Android
   * devices resolve to null.
   */
  resolveVideoJar: (device: BootedDevice) => Promise<string | null>;
  now: () => Date;
  timer: Timer;
}

const defaultDependencies: WebRtcStreamManagerDependencies = {
  idGenerator: defaultIdGenerator,
  createPublisher: (config, deps) => new WebRtcPublisher(config, deps),
  createSource: (options, jarPath) => createH264CaptureSource(options, jarPath),
  resolveVideoJar: device =>
    device.platform === "android" ? resolveVideoServerJar() : Promise.resolve(null),
  now: () => new Date(),
  timer: defaultTimer,
};

let dependencies: WebRtcStreamManagerDependencies = { ...defaultDependencies };
const streams = new Map<string, WebRtcStreamRecord>();
/**
 * Reconnect if a connected stream produces no frames for this long. Covers an
 * encoder/capture that wedges without dropping the peer connection (which would
 * otherwise leave the viewer on a frozen frame with no recovery).
 */
const FRAME_STALL_TIMEOUT_MS = 10_000;
export const DEFAULT_STREAM_READY_TIMEOUT_MS = 30_000;
export const WEBRTC_STREAM_LEASE_TTL_MS = 60_000;

/** Override manager dependencies (tests). */
export function setWebRtcStreamManagerDependencies(
  overrides: Partial<WebRtcStreamManagerDependencies>
): void {
  dependencies = { ...dependencies, ...overrides };
}

/** Reset manager state and dependencies (tests). */
export function resetWebRtcStreamManager(): void {
  for (const record of streams.values()) {
    if (record.leaseExpiryHandle) {
      dependencies.timer.clearTimeout(record.leaseExpiryHandle);
    }
  }
  streams.clear();
  dependencies = { ...defaultDependencies };
}

function activeStreamForDevice(deviceId: string): WebRtcStreamRecord | undefined {
  for (const record of streams.values()) {
    if (record.device.deviceId === deviceId) {
      return record;
    }
  }
  return undefined;
}

/** Run an action against the current record for a stream id, if it still exists. */
async function withRecord(
  streamId: string,
  action: (record: WebRtcStreamRecord) => Promise<void>
): Promise<void> {
  const record = streams.get(streamId);
  if (record) {
    await action(record);
  }
}

function leaseExpiryAt(record: WebRtcStreamRecord, leaseId: string): string | undefined {
  const expiresAt = record.leases.get(leaseId);
  if (expiresAt === undefined) {
    return undefined;
  }
  return new Date(
    dependencies.now().getTime() + Math.max(0, expiresAt - dependencies.timer.now())
  ).toISOString();
}

/** Descriptor for a record, including the manager-owned capture-source state. */
function describeRecord(record: WebRtcStreamRecord, leaseId?: string): WebRtcStreamDescriptor {
  const descriptor = record.publisher.getDescriptor();
  const sourceTelemetry = record.source?.getTelemetry?.() ?? record.sourceTelemetry;
  const leaseExpiresAt = leaseId ? leaseExpiryAt(record, leaseId) : undefined;
  return {
    ...descriptor,
    sourceStarted: record.sourceStarted,
    readiness: {
      ...descriptor.readiness,
      ...sourceTelemetry,
      captureSourceState: record.sourceState,
      lastSourceError: record.lastSourceError,
    },
    frameMetrics: record.frameMetrics,
    lifecycleState: record.lifecycleState,
    failure: record.failure,
    telemetry: record.telemetry,
    fallback: record.lifecycleState === "degraded" || record.lifecycleState === "failed"
      ? { mode: "screenshots", reason: record.failure?.code ?? "capture_unavailable" }
      : null,
    lease: leaseId && leaseExpiresAt ? { id: leaseId, expiresAt: leaseExpiresAt } : null,
    consumerCount: record.leases.size,
  };
}

function scheduleLeaseExpiry(record: WebRtcStreamRecord): void {
  if (record.leaseExpiryHandle) {
    dependencies.timer.clearTimeout(record.leaseExpiryHandle);
    record.leaseExpiryHandle = null;
  }
  const earliestExpiry = Math.min(...record.leases.values());
  if (!Number.isFinite(earliestExpiry)) {
    return;
  }
  record.leaseExpiryHandle = dependencies.timer.setTimeout(() => {
    if (streams.get(record.streamId) !== record) {
      return;
    }
    const now = dependencies.timer.now();
    for (const [leaseId, expiresAt] of record.leases) {
      if (expiresAt <= now) {
        record.leases.delete(leaseId);
      }
    }
    if (record.leases.size > 0) {
      scheduleLeaseExpiry(record);
      return;
    }
    streams.delete(record.streamId);
    void stopActiveRecord(record).catch(error => {
      logger.debug(`[WebRtcStream] lease expiry cleanup failed: ${error}`);
    });
  }, Math.max(0, earliestExpiry - dependencies.timer.now()));
}

function acquireLease(record: WebRtcStreamRecord, requestedLeaseId?: string): string {
  const leaseId = requestedLeaseId && record.leases.has(requestedLeaseId)
    ? requestedLeaseId
    : `lease_${dependencies.idGenerator.next()}`;
  record.leases.set(leaseId, dependencies.timer.now() + WEBRTC_STREAM_LEASE_TTL_MS);
  scheduleLeaseExpiry(record);
  return leaseId;
}

function releaseLease(record: WebRtcStreamRecord, leaseId: string): boolean {
  const removed = record.leases.delete(leaseId);
  if (!removed) {
    return false;
  }
  scheduleLeaseExpiry(record);
  return record.leases.size === 0;
}

function wakeStateWaiters(record: WebRtcStreamRecord): void {
  for (const wake of record.stateWaiters) {
    wake();
  }
  record.stateWaiters.clear();
}

function setLifecycleState(record: WebRtcStreamRecord, state: VideoStreamLifecycleState): void {
  record.lifecycleState = state;
  wakeStateWaiters(record);
}

function markFailure(
  record: WebRtcStreamRecord,
  code: VideoStreamFailureCode,
  error: unknown,
  state: "degraded" | "failed" = "failed"
): void {
  record.failure = {
    code,
    message: error instanceof Error ? error.message : String(error),
    at: dependencies.now().toISOString(),
  };
  setLifecycleState(record, state);
}

function recordPublisherEvent(record: WebRtcStreamRecord, event: WebRtcPublisherLifecycleEvent): void {
  const at = dependencies.now().toISOString();
  const timestampField = publisherTimestampField(event);
  if (timestampField) {
    record.telemetry[timestampField] ??= at;
  }
  if (event === "ice_gathering_complete" || event === "ice_gathering_timeout") {
    const offerTime = Date.parse(record.telemetry.sdpOffer ?? at);
    record.telemetry.nonTrickleIceGatheringDelayMs ??= Math.max(0, dependencies.now().getTime() - offerTime);
  }
  if (event === "ice_connected" && !record.sourceFailed) {
    setLifecycleState(record, "publishing");
  }
}

function publisherTimestampField(
  event: WebRtcPublisherLifecycleEvent
): "sdpOffer" | "sdpAnswer" | "iceConnected" | "firstRtpSent" | undefined {
  const fields: Partial<Record<WebRtcPublisherLifecycleEvent, "sdpOffer" | "sdpAnswer" | "iceConnected" | "firstRtpSent">> = {
    sdp_offer_created: "sdpOffer",
    ice_gathering_started: "sdpOffer",
    whip_answer_received: "sdpAnswer",
    ice_connected: "iceConnected",
    first_rtp_sent: "firstRtpSent",
  };
  return fields[event];
}

function createStreamRecord(
  streamId: string,
  device: BootedDevice,
  config: ReturnType<typeof resolveWebRtcStreamingConfig>,
  jarPath: string | null,
  bitrateBps: number | undefined,
  requestReceived: string
): WebRtcStreamRecord {
  const publisherRef: { current?: WebRtcPublisher } = {};
  let publisherStarted = false;
  const publisher = dependencies.createPublisher(
    {
      streamId,
      whipEndpoint: config.whipEndpoint,
      bearerToken: config.bearerToken,
      iceServers: config.iceServers,
      bitrateBps,
      trickleIce: config.trickleIce,
      audioEnabled: config.audioEnabled,
      // The Android video-server MediaCodec encoder emits Main (issue #4756);
      // iOS ffmpeg and every other source stay Constrained Baseline. WebRTC
      // negotiates one profile-level-id per session, so it must track the source.
      h264Profile: device.platform === "android" ? "main" : "constrained-baseline",
      frameStallTimeoutMs: FRAME_STALL_TIMEOUT_MS,
    },
    {
      onBeforeEstablish: async () => {
        const record = streams.get(streamId);
        if ((publisherStarted && record?.sourceFailed) || !record?.sourceStarted) {
          await withRecord(streamId, async currentRecord => {
            await startSource(currentRecord);
          });
        }
      },
      onKeyFrameRequest: () => streams.get(streamId)?.source?.requestKeyFrame?.() ?? false,
      onConnected: () => {
        const record = streams.get(streamId);
        if (record && record.publisher === publisherRef.current && !record.sourceFailed) {
          setLifecycleState(record, "publishing");
          record.publisher.primeH264ParameterSets(record.cachedSps, record.cachedPps);
          record.source?.requestKeyFrame?.();
        }
      },
      onSourceFailure: error => {
        const record = streams.get(streamId);
        if (record && record.publisher === publisherRef.current && !record.sourceFailed) {
          record.sourceFailed = true;
          markFailure(record, "capture_runtime_failed", error, "degraded");
        }
      },
      onLifecycleEvent: event => {
        const record = streams.get(streamId);
        if (record && record.publisher === publisherRef.current) {
          recordPublisherEvent(record, event);
        }
      },
    }
  );
  publisherRef.current = publisher;
  const record: WebRtcStreamRecord = {
    streamId,
    device,
    publisher,
    source: null,
    jarPath,
    bitrateBps,
    size: config.size,
    fps: device.platform === "android" ? config.androidFps : config.iosSimulatorFps,
    audioEnabled: config.audioEnabled,
    startedAt: requestReceived,
    sourceStarted: false,
    lifecycleState: "preparing",
    failure: null,
    telemetry: { requestReceived },
    sourceFailed: false,
    mediaParser: new H264AnnexBParser(),
    cachedSps: null,
    cachedPps: null,
    stateWaiters: new Set(),
    leases: new Map(),
    leaseExpiryHandle: null,
    sourceState: "not_initialized",
    lastSourceError: null,
    sourceTelemetry: null,
  };
  const start = publisher.start.bind(publisher);
  publisher.start = async () => {
    await start();
    publisherStarted = true;
  };
  return record;
}

/** Stop and clear the capture source for a stream (before each (re)establish). */
async function stopSource(record: WebRtcStreamRecord): Promise<void> {
  record.sourceStarted = false;
  record.frameMetrics = undefined;
  if (record.source) {
    record.sourceTelemetry = record.source.getTelemetry?.() ?? record.sourceTelemetry;
    await record.source.stop().catch(error => {
      logger.debug(`[WebRtcStream] source stop failed: ${error}`);
    });
    record.source = null;
    record.sourceState = "stopped";
  }
}

/**
 * Prepare a local capture before the WHIP session. Source output is retained by
 * the manager and delivered to the publisher once its RTP writer exists; this
 * keeps ADB forwarding / the iOS helper warm across publish reconnects.
 */
async function startSource(record: WebRtcStreamRecord): Promise<boolean> {
  await stopSource(record);
  // stopWebRtcStream() may have deleted (or replaced) this record while we were
  // awaiting the source stop above. Starting capture now would spawn a
  // screenrecord process attached to a record no later stop/list can reach,
  // leaking it. Bail if we no longer own the stream.
  if (streams.get(record.streamId) !== record) {
    return false;
  }
  record.sourceState = "starting";
  const sourceRef: { current: H264CaptureSource | null } = { current: null };
  record.sourceFailed = false;
  record.mediaParser = new H264AnnexBParser();
  let source: H264CaptureSource | null = null;
  source = dependencies.createSource(
    {
      device: record.device,
      onData: chunk => {
        if (record.source !== source) {
          return;
        }
        if (!record.telemetry.firstMediaFrame) {
          record.telemetry.firstMediaFrame = dependencies.now().toISOString();
        }
        let nals: Buffer[];
        try {
          nals = record.mediaParser.push(chunk);
        } catch (error) {
          record.sourceFailed = true;
          markFailure(record, "capture_runtime_failed", error, "degraded");
          record.publisher.notifySourceFailed(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        for (const nal of nals) {
          const type = nalUnitType(nal);
          if (type === NAL_TYPE_SPS) {
            record.cachedSps = Buffer.from(nal);
          } else if (type === NAL_TYPE_PPS) {
            record.cachedPps = Buffer.from(nal);
          }
          if (type === NAL_TYPE_IDR && !record.telemetry.firstIdr) {
            record.telemetry.firstIdr = dependencies.now().toISOString();
          }
        }
        record.publisher.writeH264Chunk(chunk);
      },
      onAudioData: chunk => {
        if (record.source === source) {
          record.publisher.writePcmAudioChunk(chunk);
        }
      },
      onError: error => {
        if (record.source !== source) {
          return;
        }
        record.sourceState = "failed";
        record.lastSourceError = error.message;
        record.sourceTelemetry = source?.getTelemetry?.() ?? record.sourceTelemetry;
        record.sourceFailed = true;
        markFailure(record, "capture_runtime_failed", error, "degraded");
        record.publisher.notifySourceFailed(error);
      },
      bitrateBps: record.bitrateBps,
      size: record.size,
      fps: record.fps,
      audioEnabled: record.audioEnabled,
      onFrameMetrics: metrics => {
        if (record.source === sourceRef.current) {
          record.frameMetrics = metrics;
        }
      },
    },
    record.jarPath
  );
  sourceRef.current = source;
  record.source = source;
  try {
    await source.start();
  } catch (error) {
    record.sourceState = "failed";
    record.lastSourceError = error instanceof Error ? error.message : String(error);
    record.sourceTelemetry = source.getTelemetry?.() ?? record.sourceTelemetry;
    record.sourceFailed = true;
    markFailure(record, "capture_start_failed", error, "degraded");
    record.publisher.notifySourceFailed(error instanceof Error ? error : new Error(String(error)));
    throw error;
  }
  // The stream may have been stopped while the source was starting. stop() only
  // reaches record.source, which was still null when it ran, so stop the source
  // we just spawned to avoid an orphaned screenrecord process.
  if (streams.get(record.streamId) !== record) {
    record.source = null;
    await source.stop().catch(() => {});
    return false;
  }
  record.sourceStarted = true;
  record.sourceState = "running";
  record.sourceTelemetry = source.getTelemetry?.() ?? record.sourceTelemetry;
  record.telemetry.captureSourcePrepared ??= dependencies.now().toISOString();
  if (!record.sourceFailed) {
    record.failure = null;
    setLifecycleState(record, "capture_ready");
  }
  return true;
}

function assertNewStreamIdAvailable(streamId: string): void {
  if (streams.has(streamId)) {
    throw new ActionableError(`WebRTC stream ${streamId} already active. Stop it first.`);
  }
}

/** Stop live media components while retaining best-effort cleanup semantics. */
async function stopActiveRecord(record: WebRtcStreamRecord): Promise<void> {
  setLifecycleState(record, "stopping");
  await stopSource(record);
  await record.publisher.stop().catch(error => {
    logger.debug(`[WebRtcStream] publisher stop failed: ${error}`);
  });
}

async function prepareAndPublish(record: WebRtcStreamRecord): Promise<void> {
  try {
    await record.publisher.start();
    if (streams.get(record.streamId) !== record) {
      throw new Error(`WebRTC stream ${record.streamId} was stopped before startup completed.`);
    }
  } catch (error) {
    if (streams.get(record.streamId) !== record) {
      return;
    }
    markFailure(
      record,
      record.failure?.code ?? "whip_publish_failed",
      error,
      record.failure ? "degraded" : "failed"
    );
    await record.publisher.stop().catch(stopError => {
      logger.debug(`[WebRtcStream] publisher cleanup failed: ${stopError}`);
    });
  }
}

/**
 * Start publishing a device's screen to the configured coordination server over
 * WHIP. Android capture prefers the persistent on-device encoder and falls back
 * to segment-rotated `screenrecord`; iOS capture uses the macOS screen-capture
 * helper and a local H.264 encoder. Returns the reconnect descriptor for the new
 * stream.
 */
export async function startWebRtcStream(
  request: StartWebRtcStreamRequest
): Promise<WebRtcStreamDescriptor> {
  const requestReceived = dependencies.now().toISOString();
  const existing = activeStreamForDevice(request.device.deviceId);
  if (existing) {
    return describeRecord(existing, acquireLease(existing, request.leaseId));
  }

  const config = resolveWebRtcStreamingConfig(request.overrides);
  const streamId = request.streamId ?? `webrtc_${dependencies.idGenerator.next()}`;
  assertNewStreamIdAvailable(streamId);
  const bitrateBps = config.bitrateKbps ? config.bitrateKbps * 1000 : undefined;
  const record = createStreamRecord(
    streamId,
    request.device,
    config,
    null,
    bitrateBps,
    requestReceived
  );
  streams.set(streamId, record);
  const leaseId = acquireLease(record, request.leaseId);

  try {
    record.jarPath = await dependencies.resolveVideoJar(request.device);
    if (streams.get(streamId) !== record) {
      return { ...describeRecord(record, leaseId), state: "stopped" };
    }
    const sourceStarted = await startSource(record);
    if (!sourceStarted) {
      return { ...describeRecord(record, leaseId), state: "stopped" };
    }
    // Capture is now ready and its identifier is returned before WHIP/ICE
    // completes, so callers can await publishing separately.
    void prepareAndPublish(record);
    return describeRecord(record, leaseId);
  } catch (error) {
    if (streams.get(streamId) === record) {
      markFailure(
        record,
        record.failure?.code ?? "capture_start_failed",
        error,
        "degraded"
      );
      await record.source?.stop().catch(() => {});
      await record.publisher.stop().catch(() => {});
    }
    return describeRecord(record, leaseId);
  }
}

/** Release one lease, or stop a stream immediately when no lease is supplied. */
export async function stopWebRtcStream(
  streamId?: string,
  leaseId?: string
): Promise<WebRtcStreamDescriptor> {
  const record = resolveStreamRecord(streamId);
  if (leaseId && !releaseLease(record, leaseId)) {
    throw new ActionableError(`No active WebRTC lease ${leaseId} for stream ${record.streamId}.`);
  }
  if (leaseId && record.leases.size > 0) {
    return describeRecord(record);
  }
  streams.delete(record.streamId);
  if (record.leaseExpiryHandle) {
    dependencies.timer.clearTimeout(record.leaseExpiryHandle);
    record.leaseExpiryHandle = null;
  }
  await stopActiveRecord(record);
  return { ...describeRecord(record), state: "stopped" };
}

/** List reconnect descriptors for all active streams. */
export function listWebRtcStreams(): WebRtcStreamDescriptor[] {
  return Array.from(streams.values()).map(record => describeRecord(record));
}

/** Get the reconnect descriptor for one stream (or null). */
export function getWebRtcStreamDescriptor(
  streamId: string,
  leaseId?: string
): WebRtcStreamDescriptor | null {
  const record = streams.get(streamId);
  if (!record) {
    return null;
  }
  const activeLeaseId = leaseId ? acquireLease(record, leaseId) : undefined;
  return describeRecord(record, activeLeaseId);
}

function isReadinessSatisfied(
  record: WebRtcStreamRecord,
  readiness: "capture_ready" | "publishing"
): boolean {
  if (readiness === "publishing") {
    return record.lifecycleState === "publishing";
  }
  return record.sourceStarted &&
    (record.lifecycleState === "capture_ready" || record.lifecycleState === "publishing");
}

function stoppedReadinessDescriptor(
  record: WebRtcStreamRecord,
  streamId: string,
  readiness: "capture_ready" | "publishing",
  leaseId?: string
): WebRtcStreamDescriptor {
  return {
    ...describeRecord(record, leaseId),
    state: "stopped",
    failure: {
      code: "stopped",
      message: `WebRTC stream ${streamId} was stopped while waiting for ${readiness}.`,
      at: dependencies.now().toISOString(),
    },
    fallback: null,
  };
}

function readinessWaitDuration(remainingMs: number, hasLease: boolean): number {
  return hasLease ? Math.min(remainingMs, WEBRTC_STREAM_LEASE_TTL_MS / 2) : remainingMs;
}

function waitForRecordStateChange(record: WebRtcStreamRecord, waitMs: number): Promise<void> {
  return new Promise<void>(resolve => {
    const timeout = dependencies.timer.setTimeout(() => {
      record.stateWaiters.delete(wake);
      resolve();
    }, waitMs);
    const wake = () => {
      dependencies.timer.clearTimeout(timeout);
      resolve();
    };
    record.stateWaiters.add(wake);
  });
}

type ReadinessRecordResolution =
  | { type: "active"; record: WebRtcStreamRecord }
  | { type: "stopped"; descriptor: WebRtcStreamDescriptor };

function resolveReadinessRecord(
  streamId: string,
  readiness: "capture_ready" | "publishing",
  leaseId: string | undefined,
  lastRecord: WebRtcStreamRecord | undefined
): ReadinessRecordResolution {
  const record = streams.get(streamId);
  if (record) {
    return { type: "active", record };
  }
  if (lastRecord?.lifecycleState === "stopping") {
    return {
      type: "stopped",
      descriptor: stoppedReadinessDescriptor(lastRecord, streamId, readiness, leaseId),
    };
  }
  throw new ActionableError(`No active WebRTC stream with id ${streamId}.`);
}

/**
 * Wait for local capture or WHIP publishing without conflating the two phases.
 * A timeout is a request-scoped result, not a capture failure, so one caller
 * cannot degrade a stream that is still healthy for another consumer.
 */
export async function waitForWebRtcStreamReadiness(
  streamId: string,
  readiness: "capture_ready" | "publishing",
  timeoutMs: number = DEFAULT_STREAM_READY_TIMEOUT_MS,
  leaseId?: string
): Promise<WebRtcStreamDescriptor> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new ActionableError("WebRTC stream readiness timeout must be a positive number of milliseconds.");
  }
  const deadline = dependencies.timer.now() + timeoutMs;
  let activeLeaseId = leaseId;
  let lastRecord: WebRtcStreamRecord | undefined;

  for (;;) {
    const resolved = resolveReadinessRecord(streamId, readiness, activeLeaseId, lastRecord);
    if (resolved.type === "stopped") {
      return resolved.descriptor;
    }
    const record = resolved.record;
    lastRecord = record;
    if (activeLeaseId) {
      activeLeaseId = acquireLease(record, activeLeaseId);
    }
    if (isReadinessSatisfied(record, readiness)) {
      return describeRecord(record, activeLeaseId);
    }
    if (record.lifecycleState === "degraded" || record.lifecycleState === "failed") {
      return describeRecord(record, activeLeaseId);
    }
    const remainingMs = deadline - dependencies.timer.now();
    if (remainingMs <= 0) {
      return readinessTimeoutDescriptor(record, readiness, activeLeaseId);
    }
    await waitForRecordStateChange(record, readinessWaitDuration(remainingMs, Boolean(activeLeaseId)));
  }
}

function readinessTimeoutDescriptor(
  record: WebRtcStreamRecord,
  readiness: "capture_ready" | "publishing",
  leaseId?: string
): WebRtcStreamDescriptor {
  const code = readiness === "capture_ready" ? "capture_ready_timeout" : "publishing_timeout";
  return {
    ...describeRecord(record, leaseId),
    failure: {
      code,
      message: `Timed out waiting for WebRTC stream ${record.streamId} to reach ${readiness}.`,
      at: dependencies.now().toISOString(),
    },
    fallback: null,
  };
}

function resolveStreamRecord(streamId?: string): WebRtcStreamRecord {
  if (streamId) {
    const record = streams.get(streamId);
    if (!record) {
      throw new ActionableError(`No active WebRTC stream with id ${streamId}.`);
    }
    return record;
  }

  if (streams.size === 0) {
    throw new ActionableError("No active WebRTC streams. Provide a streamId.");
  }
  if (streams.size > 1) {
    throw new ActionableError("Multiple active WebRTC streams. Provide a streamId.");
  }
  return streams.values().next().value as WebRtcStreamRecord;
}
