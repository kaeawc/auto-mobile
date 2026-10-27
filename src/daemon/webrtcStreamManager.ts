import { defaultDaemonContext } from "./daemonContext";
import {
  decideLifecycleEvent,
  decideOwnershipChange,
  type StreamSubscriptionEndReason,
  type StreamSubscriptionIdentity,
  type StreamSubscriptionKind,
  type StreamSubscriptionLifecycleEndReason,
} from "./wire/streamSubscriptionPolicy";
import { WebRtcSubscriptionEndedError } from "./WebRtcSubscriptionEndedError";
import {
  H264AnnexBParser,
  NAL_TYPE_IDR,
  NAL_TYPE_PPS,
  NAL_TYPE_SPS,
  WebRtcPublisher,
  createH264CaptureSource,
  nalUnitType,
  resolveVideoServerJar,
  resolveWebRtcStreamingConfig,
  type H264CaptureSource,
  type WebRtcPublisherLifecycleEvent,
  type WebRtcStreamDescriptor,
  type WebRtcStreamPublisher,
} from "../features/webrtc";
import {
  getDefaultDeviceCaptureRegistry,
  type DeviceCaptureRegistry,
} from "../features/webrtc/deviceCaptureRegistry";
import { ActionableError, type BootedDevice } from "../models";
import { errorMessage } from "../utils/describeUnknownError";
import { defaultIdGenerator } from "../utils/IdGenerator";
import { logger } from "../utils/logger";
import { raceWithDeadline } from "../utils/raceWithDeadline";
import { defaultTimer } from "../utils/SystemTimer";
import { registerWebRtcStreamIncarnationCleanup } from "./webrtcStreamIncarnationListener";
import {
  WebRtcStreamQueries,
  type StartWebRtcStreamRequest,
  type VideoStreamFailureCode,
  type VideoStreamLifecycleState,
  type WebRtcStreamManagerDependencies,
  type WebRtcStreamRecord,
} from "./webrtcStreamQueries";
export {
  type StartWebRtcStreamRequest,
  type VideoStreamFailure,
  type VideoStreamFailureCode,
  type VideoStreamLifecycleState,
  type VideoStreamTelemetry,
  type WebRtcStreamManagerDependencies,
} from "./webrtcStreamQueries";

function isDaemonSessionLive(sessionUuid: string): boolean {
  const sessions = defaultDaemonContext.sessionManager();
  return sessions ? Boolean(sessions.getSession(sessionUuid)) : false;
}

const defaultDependencies: WebRtcStreamManagerDependencies = {
  idGenerator: defaultIdGenerator,
  createPublisher: (config, deps) => new WebRtcPublisher(config, deps),
  createSource: (options, jarPath) => createH264CaptureSource(options, jarPath),
  resolveVideoJar: (device) =>
    device.platform === "android" ? resolveVideoServerJar() : Promise.resolve(null),
  now: () => new Date(),
  timer: defaultTimer,
  isSessionLive: isDaemonSessionLive,
};

let dependencies: WebRtcStreamManagerDependencies = { ...defaultDependencies };
const streams = new Map<string, WebRtcStreamRecord>();
interface EndedLease {
  streamId: string;
  reason: StreamSubscriptionEndReason;
  kind: StreamSubscriptionKind;
  expiresAt: number;
}
const endedLeases = new Map<string, EndedLease>();
const ENDED_LEASE_CAP = 256;

function pruneEndedLeases(): void {
  const now = dependencies.timer.now();
  for (const [leaseId, end] of endedLeases) {
    if (end.expiresAt <= now) {
      endedLeases.delete(leaseId);
    }
  }
}

function assertLeaseNotEnded(input: { streamId?: string; leaseId?: string }): void {
  pruneEndedLeases();
  const end = input.leaseId ? endedLeases.get(input.leaseId) : undefined;
  if (end && (input.streamId === undefined || end.streamId === input.streamId)) {
    throw new WebRtcSubscriptionEndedError({ reason: end.reason, subscriptionKind: end.kind });
  }
}

function subscriptionLogContext({
  record,
  leaseId,
  kind,
}: {
  record: WebRtcStreamRecord;
  leaseId: string;
  kind: StreamSubscriptionKind;
}): string {
  return `deviceId=${record.device.deviceId} streamId=${record.streamId} leaseId=${leaseId} kind=${kind}`;
}

function endLease(input: {
  record: WebRtcStreamRecord;
  leaseId: string;
  reason: StreamSubscriptionEndReason;
  cause?: "incarnation change";
}): void {
  const { record, leaseId, reason, cause } = input;
  const lease = record.leases.get(leaseId);
  if (!lease) {
    return;
  }
  record.leases.delete(leaseId);
  pruneEndedLeases();
  endedLeases.set(leaseId, {
    streamId: record.streamId,
    reason,
    kind: lease.kind,
    expiresAt: dependencies.timer.now() + WEBRTC_STREAM_LEASE_TTL_MS,
  });
  if (endedLeases.size > ENDED_LEASE_CAP) {
    const oldest = endedLeases.keys().next().value;
    if (oldest !== undefined) {
      endedLeases.delete(oldest);
    }
  }
  const message = `[WebRtcStream] ending subscription: ${subscriptionLogContext({ record, leaseId, kind: lease.kind })} reason=${reason}${cause ? ` cause=${cause}` : ""}`;
  if (!cause && (reason === "device_removed" || reason === "identity_quarantined")) {
    logger.warn(message);
  } else {
    logger.info(message);
  }
  wakeStateWaiters(record);
}
/**
 * Reconnect if a connected stream produces no frames for this long. Covers an
 * encoder/capture that wedges without dropping the peer connection (which would
 * otherwise leave the viewer on a frozen frame with no recovery).
 */
const FRAME_STALL_TIMEOUT_MS = 10_000;
export const DEFAULT_STREAM_READY_TIMEOUT_MS = 30_000;
export const WEBRTC_STREAM_LEASE_TTL_MS = 60_000;
export const WEBRTC_STREAM_STOP_TIMEOUT_MS = 5_000;

/** Claim synchronously, before any cleanup await can race another stop path. */
function claimStreamRecord(record: WebRtcStreamRecord): boolean {
  if (streams.get(record.streamId) !== record) {
    return false;
  }
  discardDeadRecord(record);
  return true;
}

async function stopClaimedRecords(records: WebRtcStreamRecord[], reason: string): Promise<void> {
  await Promise.all(
    records.filter(claimStreamRecord).map(async (record) => {
      try {
        await raceWithDeadline(() => stopActiveRecord(record), {
          timer: dependencies.timer,
          timeoutMs: WEBRTC_STREAM_STOP_TIMEOUT_MS,
          label: `WebRTC stream ${record.streamId} cleanup (${reason})`,
        });
      } catch (error) {
        logger.warn(`[WebRtcStream] cleanup failed (${reason}): ${errorMessage(error)}`, error);
      }
    }),
  );
}

export interface EndWebRtcStreamsForDeviceOptions {
  deviceId: string;
  reason: StreamSubscriptionLifecycleEndReason;
  cause?: "incarnation change";
}

function endRecordLeases({
  record,
  ...options
}: Omit<EndWebRtcStreamsForDeviceOptions, "deviceId"> & { record: WebRtcStreamRecord }): void {
  for (const [leaseId, lease] of record.leases) {
    const decision = decideLifecycleEvent({ kind: lease.kind, event: options.reason });
    endLease({ record, leaseId, reason: decision.reason, cause: options.cause });
  }
}

/** End subscriptions synchronously, then claim streams before bounded cleanup awaits. */
export function endWebRtcStreamsForDevice(
  options: EndWebRtcStreamsForDeviceOptions,
): Promise<void> {
  const records = [...streams.values()].filter(
    (record) => record.device.deviceId === options.deviceId,
  );
  for (const record of records) {
    endRecordLeases({ record, ...options });
  }
  return stopClaimedRecords(records, options.reason);
}

/** Apply the shared subscription policy independently to each session lease. */
export function reconcileWebRtcStreamsForDeviceOwnership(
  deviceId: string,
  resolveIdentity: (sessionUuid: string) => StreamSubscriptionIdentity,
): Promise<void> {
  const revoked: WebRtcStreamRecord[] = [];
  for (const record of streams.values()) {
    if (record.device.deviceId !== deviceId) {
      continue;
    }
    for (const [leaseId, lease] of record.leases) {
      if (lease.sessionUuid !== undefined) {
        reconcileLease({ record, leaseId, lease, resolveIdentity });
      }
    }
    if (record.leases.size === 0) {
      revoked.push(record);
    } else {
      scheduleLeaseExpiry(record);
    }
  }
  return stopClaimedRecords(revoked, "device ownership changed");
}

function reconcileLease(input: {
  record: WebRtcStreamRecord;
  leaseId: string;
  lease: { sessionUuid?: string; kind: StreamSubscriptionKind };
  resolveIdentity: (sessionUuid: string) => StreamSubscriptionIdentity;
}): void {
  const { record, leaseId, lease, resolveIdentity } = input;
  const decision = decideOwnershipChange({
    ...resolveIdentity(lease.sessionUuid!),
    kind: lease.kind,
  });
  if (decision.action === "end") {
    endLease({ record, leaseId, reason: decision.reason });
  } else if (decision.action === "downgrade") {
    lease.kind = "viewer";
    logger.info(
      `[WebRtcStream] downgraded subscription: ${subscriptionLogContext({ record, leaseId, kind: lease.kind })}`,
    );
  }
}

/** Stop all live captures on daemon shutdown without serial cleanup delays. */
export function stopAllWebRtcStreams(reason: StreamSubscriptionLifecycleEndReason): Promise<void> {
  const records = [...streams.values()];
  for (const record of records) {
    endRecordLeases({ record, reason });
  }
  return stopClaimedRecords(records, reason);
}

registerWebRtcStreamIncarnationCleanup({ stopStreamsForDevice: endWebRtcStreamsForDevice });

/** Override manager dependencies (tests). */
export function setWebRtcStreamManagerDependencies(
  overrides: Partial<WebRtcStreamManagerDependencies>,
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
  endedLeases.clear();
  dependencies = { ...defaultDependencies };
}

/** Run an action against the current record for a stream id, if it still exists. */
async function withRecord(
  streamId: string,
  action: (record: WebRtcStreamRecord) => Promise<void>,
): Promise<void> {
  const record = streams.get(streamId);
  if (record) {
    await action(record);
  }
}

function scheduleLeaseExpiry(record: WebRtcStreamRecord): void {
  if (record.leaseExpiryHandle) {
    dependencies.timer.clearTimeout(record.leaseExpiryHandle);
    record.leaseExpiryHandle = null;
  }
  const earliestExpiry = Math.min(
    ...Array.from(record.leases.values(), (lease) => lease.expiresAt),
  );
  if (!Number.isFinite(earliestExpiry)) {
    return;
  }
  record.leaseExpiryHandle = dependencies.timer.setTimeout(
    () => {
      if (streams.get(record.streamId) !== record) {
        return;
      }
      const now = dependencies.timer.now();
      for (const [leaseId, lease] of record.leases) {
        if (lease.expiresAt <= now) {
          record.leases.delete(leaseId);
        }
      }
      if (record.leases.size > 0) {
        scheduleLeaseExpiry(record);
        return;
      }
      void stopClaimedRecords([record], "lease expired");
    },
    Math.max(0, earliestExpiry - dependencies.timer.now()),
  );
}

function assertLeaseAccess(
  record: WebRtcStreamRecord,
  leaseId: string,
  ownerSessionUuid: string | undefined,
  sessionUuid: string | undefined,
): void {
  if (
    ownerSessionUuid &&
    sessionUuid &&
    ownerSessionUuid !== sessionUuid &&
    dependencies.isSessionLive?.(ownerSessionUuid)
  ) {
    throw new ActionableError(
      `WebRTC lease ${leaseId} for stream ${record.streamId} belongs to another active session.`,
    );
  }
}

function acquireLease(
  record: WebRtcStreamRecord,
  options: {
    requestedLeaseId?: string;
    sessionUuid?: string;
    mintIfUnknown?: boolean;
    subscriptionKind?: StreamSubscriptionKind;
  },
): string {
  const { requestedLeaseId, sessionUuid, mintIfUnknown = false } = options;
  if (!mintIfUnknown) {
    assertLeaseNotEnded({ streamId: record.streamId, leaseId: requestedLeaseId });
  }
  const existing = requestedLeaseId === undefined ? undefined : record.leases.get(requestedLeaseId);
  if (requestedLeaseId !== undefined && !existing && !mintIfUnknown) {
    throw new ActionableError(
      `No active WebRTC lease ${requestedLeaseId} for stream ${record.streamId}; call start to resume.`,
    );
  }
  if (existing && requestedLeaseId !== undefined) {
    assertLeaseAccess(record, requestedLeaseId, existing.sessionUuid, sessionUuid);
    existing.sessionUuid = sessionUuid ?? existing.sessionUuid;
    existing.expiresAt = dependencies.timer.now() + WEBRTC_STREAM_LEASE_TTL_MS;
    scheduleLeaseExpiry(record);
    return requestedLeaseId;
  }
  const leaseId = `lease_${dependencies.idGenerator.next()}`;
  record.leases.set(leaseId, {
    expiresAt: dependencies.timer.now() + WEBRTC_STREAM_LEASE_TTL_MS,
    sessionUuid,
    kind: options.subscriptionKind ?? "owner",
  });
  scheduleLeaseExpiry(record);
  return leaseId;
}

function releaseLease(record: WebRtcStreamRecord, leaseId: string, sessionUuid?: string): boolean {
  const existing = record.leases.get(leaseId);
  if (existing) {
    assertLeaseAccess(record, leaseId, existing.sessionUuid, sessionUuid);
  }
  const removed = record.leases.delete(leaseId);
  if (removed) {
    scheduleLeaseExpiry(record);
  }
  return removed;
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
  state: "degraded" | "failed" = "failed",
): void {
  record.failure = {
    code,
    message: errorMessage(error),
    at: dependencies.now().toISOString(),
  };
  setLifecycleState(record, state);
}

function recordPublisherEvent(
  record: WebRtcStreamRecord,
  event: WebRtcPublisherLifecycleEvent,
): void {
  const at = dependencies.now().toISOString();
  const timestampField = publisherTimestampField(event);
  if (timestampField) {
    record.telemetry[timestampField] ??= at;
  }
  if (event === "ice_gathering_complete" || event === "ice_gathering_timeout") {
    const offerTime = Date.parse(record.telemetry.sdpOffer ?? at);
    record.telemetry.nonTrickleIceGatheringDelayMs ??= Math.max(
      0,
      dependencies.now().getTime() - offerTime,
    );
  }
  if (event === "ice_connected" && !record.sourceFailed) {
    setLifecycleState(record, "publishing");
  }
}

function createStreamRecord(
  streamId: string,
  device: BootedDevice,
  config: ReturnType<typeof resolveWebRtcStreamingConfig>,
  jarPath: string | null,
  bitrateBps: number | undefined,
  requestReceived: string,
): WebRtcStreamRecord {
  const publisherRef: { current?: WebRtcStreamPublisher } = {};
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
          await withRecord(streamId, async (currentRecord) => {
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
      onSourceFailure: (error) => {
        const record = streams.get(streamId);
        if (record && record.publisher === publisherRef.current && !record.sourceFailed) {
          record.sourceFailed = true;
          markFailure(record, "capture_runtime_failed", error, "degraded");
        }
      },
      onLifecycleEvent: (event) => {
        const record = streams.get(streamId);
        if (record && record.publisher === publisherRef.current) {
          recordPublisherEvent(record, event);
        }
      },
    },
  );
  publisherRef.current = publisher;
  const record: WebRtcStreamRecord = {
    config: structuredClone(config),
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
    initialStartFailed: false,
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

function getCaptureRegistry(): DeviceCaptureRegistry {
  return dependencies.captureRegistry ?? getDefaultDeviceCaptureRegistry();
}

/** Stop and clear the capture source for a stream (before each (re)establish). */
async function stopSource(record: WebRtcStreamRecord): Promise<void> {
  record.sourceStarted = false;
  record.frameMetrics = undefined;
  if (record.source) {
    const source = record.source;
    record.sourceTelemetry = source.getTelemetry?.() ?? record.sourceTelemetry;
    // Detach before awaiting: lifecycle cleanup and a late start completion must
    // not call stop twice on the same source, even if its stop never settles.
    record.source = null;
    record.sourceState = "stopped";
    await source.stop().catch((error) => {
      logger.warn(`[WebRtcStream] source stop failed: ${errorMessage(error)}`, error);
    });
  }
}

/** Cache parameter sets and stamp the first IDR from NALs the source's splitter released. */
function observeMediaNals(record: WebRtcStreamRecord, nals: Buffer[]): void {
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
  const consumeData = (chunk: Buffer, fresh: boolean): void => {
    if (record.source !== source) {
      return;
    }
    if (fresh && !record.telemetry.firstMediaFrame) {
      record.telemetry.firstMediaFrame = dependencies.now().toISOString();
    }
    let nals: Buffer[];
    try {
      nals = record.mediaParser.push(chunk);
    } catch (error) {
      record.sourceFailed = true;
      markFailure(record, "capture_runtime_failed", error, "degraded");
      record.publisher.notifySourceFailed(
        error instanceof Error ? error : new Error(String(error)),
      );
      return;
    }
    observeMediaNals(record, nals);
    record.publisher.writeH264Chunk(chunk);
  };
  source = getCaptureRegistry().acquire({
    device: record.device,
    create: (options) => dependencies.createSource(options, record.jarPath),
    options: {
      device: record.device,
      onData: (chunk) => consumeData(chunk, true),
      onReplayData: (chunk) => consumeData(chunk, false),
      // The source delivered one complete length-framed packet (Android persistent encoder), so
      // release the NAL the splitters hold for a next start code instead of waiting for the
      // encoder's next output (issue #10150).
      onEncodedAccessUnit: () => {
        if (record.source !== source) {
          return;
        }
        observeMediaNals(record, record.mediaParser.flush());
        record.publisher.endOfH264Packet();
      },
      onAudioData: (chunk) => {
        if (record.source === source) {
          record.publisher.writePcmAudioChunk(chunk);
        }
      },
      onError: (error) => {
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
      onFrameMetrics: (metrics) => {
        if (record.source === sourceRef.current) {
          record.frameMetrics = metrics;
        }
      },
    },
  });
  sourceRef.current = source;
  record.source = source;
  try {
    await source.start();
  } catch (error) {
    record.sourceState = "failed";
    record.lastSourceError = errorMessage(error);
    record.sourceTelemetry = source.getTelemetry?.() ?? record.sourceTelemetry;
    record.sourceFailed = true;
    markFailure(record, "capture_start_failed", error, "degraded");
    record.publisher.notifySourceFailed(error instanceof Error ? error : new Error(String(error)));
    throw error;
  }
  // A lifecycle stop may have claimed this source while start was pending.
  // Retire a late-starting source if it has not already been claimed for stop.
  if (streams.get(record.streamId) !== record) {
    if (record.source === source) {
      await stopSource(record);
    }
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
  const existing = streams.get(streamId);
  if (!existing) {
    return;
  }
  if (!existing.initialStartFailed) {
    throw new ActionableError(`WebRTC stream ${streamId} already active. Stop it first.`);
  }
  // A retired record is already torn down; an explicit retry of the same id replaces it.
  discardDeadRecord(existing);
}

/**
 * Remove a record that never became live from `streams` and clear its lease
 * timer. A failed start with concurrent leases remains queryable until those
 * leases are released or expire; new starts skip it and use a fresh record.
 */
function discardDeadRecord(record: WebRtcStreamRecord): void {
  if (streams.get(record.streamId) === record) {
    streams.delete(record.streamId);
  }
  if (record.leaseExpiryHandle) {
    dependencies.timer.clearTimeout(record.leaseExpiryHandle);
    record.leaseExpiryHandle = null;
  }
}

/** Stop live media components while retaining best-effort cleanup semantics. */
async function stopActiveRecord(record: WebRtcStreamRecord): Promise<void> {
  setLifecycleState(record, "stopping");
  await stopSourceAndPublisher(record);
}

/** A stuck capture must not prevent the publisher from closing its transport. */
async function stopSourceAndPublisher(record: WebRtcStreamRecord): Promise<void> {
  await Promise.all([
    stopSource(record),
    record.publisher.stop().catch((error) => {
      logger.warn(`[WebRtcStream] publisher stop failed: ${errorMessage(error)}`, error);
    }),
  ]);
}

/**
 * Retire a record whose initial start (capture start or first WHIP publish)
 * failed terminally: it can never recover, because the publisher is closed for
 * good and nothing restarts the source. The single teardown path for both
 * failure sites (#7555 capture, #10149 publish).
 *
 * `initialStartFailed` is set synchronously, before any await, so a start that
 * races the teardown builds a fresh stream instead of re-leasing this one. The
 * record is then discarded once no more than `discardAtOrBelowLeases` leases
 * remain; a record that keeps its leases stays queryable (status/await/stop) so
 * their holders can read the failure, and lease expiry or stop cleans it up
 * (both are idempotent after this teardown). A teardown failure is logged and
 * never leaves the record half-retired.
 */
async function retireFailedInitialStart(
  record: WebRtcStreamRecord,
  discardAtOrBelowLeases: number,
): Promise<void> {
  record.initialStartFailed = true;
  try {
    await stopSourceAndPublisher(record);
  } catch (error) {
    logger.warn(
      `[WebRtcStream] cleanup of failed initial start ${record.streamId} failed: ${errorMessage(error)}`,
      error,
    );
  } finally {
    if (record.leases.size <= discardAtOrBelowLeases) {
      discardDeadRecord(record);
    }
  }
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
      record.failure ? "degraded" : "failed",
    );
    // The creator's descriptor was returned before this publish settled, so its
    // lease can only learn of the failure through status/await: keep the record
    // queryable while any lease is held, and discard it only when none remain.
    await retireFailedInitialStart(record, 0);
  }
}

async function attachOrReplaceWebRtcStream(
  existing: WebRtcStreamRecord,
  request: StartWebRtcStreamRequest,
): Promise<WebRtcStreamDescriptor> {
  if (request.ownsDevice && differingConfigKeys(existing, request.overrides).length > 0) {
    // Reuse owner-stop cleanup and its bounded teardown; viewers cannot veto replacement.
    await stopWebRtcStreamAsOwner({
      streamId: existing.streamId,
      sessionUuid: request.sessionUuid,
    });
    return startWebRtcStream({ ...request, leaseId: undefined, subscriptionKind: "owner" });
  }
  return describeRecord(
    existing,
    acquireLease(existing, {
      requestedLeaseId: request.leaseId,
      sessionUuid: request.sessionUuid,
      subscriptionKind: request.subscriptionKind,
      mintIfUnknown: true,
    }),
  );
}

/**
 * Start publishing a device's screen to the configured coordination server over
 * WHIP. Android capture prefers the persistent on-device encoder and falls back
 * to segment-rotated `screenrecord`; iOS capture uses the macOS screen-capture
 * helper and a local H.264 encoder. Returns the reconnect descriptor for the new
 * stream.
 */
export async function startWebRtcStream(
  request: StartWebRtcStreamRequest,
): Promise<WebRtcStreamDescriptor> {
  const requestReceived = dependencies.now().toISOString();
  const existing = activeStreamForDevice(request.device.deviceId);
  if (existing) {
    return attachOrReplaceWebRtcStream(existing, request);
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
    requestReceived,
  );
  const leaseId = acquireLease(record, {
    requestedLeaseId: request.leaseId,
    sessionUuid: request.sessionUuid,
    subscriptionKind: request.subscriptionKind,
    mintIfUnknown: true,
  });
  streams.set(streamId, record);

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
    logger.warn(
      `[WebRtcStream] initial start failed for ${streamId}: ${errorMessage(error)}`,
      error,
    );
    if (streams.get(streamId) === record) {
      markFailure(record, record.failure?.code ?? "capture_start_failed", error, "degraded");
      // The initial start never became live, so this record can never recover
      // (prepareAndPublish/onBeforeEstablish never ran to restart the source).
      // A lone caller needs no retained failure lookup; raced leases do.
      await retireFailedInitialStart(record, 1);
    }
    return { ...describeRecord(record, leaseId), state: "stopped" };
  }
}

/** Release one lease, or the caller's and unowned leases when no lease is supplied. */
export async function stopWebRtcStream(
  streamId?: string,
  leaseId?: string,
  sessionUuid?: string,
): Promise<WebRtcStreamDescriptor> {
  assertLeaseNotEnded({ streamId, leaseId });
  const record = resolveStreamRecord(streamId);
  if (leaseId !== undefined && !releaseLease(record, leaseId, sessionUuid)) {
    throw new ActionableError(`No active WebRTC lease ${leaseId} for stream ${record.streamId}.`);
  }
  if (leaseId !== undefined && record.leases.size > 0) {
    return describeRecord(record);
  }
  if (leaseId === undefined) {
    for (const [activeLeaseId, lease] of record.leases) {
      if (lease.sessionUuid === undefined || lease.sessionUuid === sessionUuid) {
        record.leases.delete(activeLeaseId);
      }
    }
    if (
      Array.from(record.leases.values()).some(
        (lease) => lease.sessionUuid && dependencies.isSessionLive?.(lease.sessionUuid),
      )
    ) {
      scheduleLeaseExpiry(record);
      return describeRecord(record);
    }
  }
  claimStreamRecord(record);
  await stopActiveRecord(record);
  return { ...describeRecord(record), state: "stopped" };
}

export interface WebRtcStreamLeaseStopOptions {
  streamId?: string;
  leaseId?: string;
  sessionUuid?: string;
}

function resolveLeaseStopRecord(options: WebRtcStreamLeaseStopOptions): WebRtcStreamRecord {
  assertLeaseNotEnded(options);
  return leaseStreamRecord(options) ?? resolveStreamRecord(options.streamId);
}

/** Authenticated non-owner release: no anonymous or foreign lease cleanup. */
export async function releaseWebRtcStreamOwnLeases(
  options: WebRtcStreamLeaseStopOptions,
): Promise<WebRtcStreamDescriptor> {
  const record = resolveLeaseStopRecord(options);
  const own = [...record.leases].filter(
    ([leaseId, lease]) =>
      lease.sessionUuid === options.sessionUuid &&
      (options.leaseId === undefined || leaseId === options.leaseId),
  );
  if (own.length === 0) {
    throw new ActionableError("No caller-owned WebRTC leases on the addressed stream.");
  }
  for (const [leaseId] of own) {
    record.leases.delete(leaseId);
  }
  if (record.leases.size > 0) {
    scheduleLeaseExpiry(record);
    return describeRecord(record);
  }
  await stopClaimedRecords([record], "own leases released");
  return { ...describeRecord(record), state: "stopped" };
}

/** The authenticated device owner controls the whole record, regardless of lease kind. */
export async function stopWebRtcStreamAsOwner(
  options: WebRtcStreamLeaseStopOptions,
): Promise<WebRtcStreamDescriptor> {
  const record = resolveLeaseStopRecord(options);
  for (const [leaseId, lease] of record.leases) {
    if (lease.sessionUuid === options.sessionUuid) {
      record.leases.delete(leaseId);
    } else {
      endLease({ record, leaseId, reason: "stopped_by_owner" });
    }
  }
  await stopClaimedRecords([record], "stopped_by_owner");
  return { ...describeRecord(record), state: "stopped" };
}

/** List reconnect descriptors for all active streams. */
export function listWebRtcStreams(): WebRtcStreamDescriptor[] {
  return Array.from(streams.values()).map((record) => describeRecord(record));
}

/** Get the reconnect descriptor for one stream (or null). */
export function getWebRtcStreamDescriptor(
  streamId: string,
  leaseId?: string,
  sessionUuid?: string,
): WebRtcStreamDescriptor | null {
  assertLeaseNotEnded({ streamId, leaseId });
  const record = streams.get(streamId);
  if (!record) {
    return null;
  }
  const activeLeaseId =
    leaseId !== undefined
      ? acquireLease(record, { requestedLeaseId: leaseId, sessionUuid })
      : undefined;
  return describeRecord(record, activeLeaseId);
}

const queries = new WebRtcStreamQueries({
  get dependencies() {
    return dependencies;
  },
  get streams() {
    return streams;
  },
  get endedLeases() {
    return endedLeases;
  },
  pruneEndedLeases,
  assertLeaseNotEnded,
  assertLeaseAccess,
  acquireLease,
  get DEFAULT_STREAM_READY_TIMEOUT_MS() {
    return DEFAULT_STREAM_READY_TIMEOUT_MS;
  },
  get WEBRTC_STREAM_LEASE_TTL_MS() {
    return WEBRTC_STREAM_LEASE_TTL_MS;
  },
});
export const {
  getWebRtcStreamControlContext,
  getWebRtcStreamDeviceIds,
  getWebRtcSubscriptionKind,
  waitForWebRtcStreamReadiness,
} = queries;
const {
  leaseStreamRecord,
  resolveStreamRecord,
  describeRecord,
  activeStreamForDevice,
  publisherTimestampField,
  differingConfigKeys,
} = queries;
