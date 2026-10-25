import { isDeepStrictEqual } from "node:util";
import type { StreamSubscriptionEndReason } from "./wire/streamSubscriptionPolicy";
import { type StreamSubscriptionKind } from "./wire/streamSubscriptionPolicy";
import type { WebRtcPublisherLifecycleEvent } from "../features/webrtc";
import {
  H264AnnexBParser,
  resolveWebRtcStreamingConfig,
  type H264CaptureSource,
  type H264CaptureSourceMetrics,
  type H264CaptureSourceOptions,
  type H264CaptureSourceTelemetry,
  type WebRtcCaptureSourceState,
  type WebRtcPublisherConfig,
  type WebRtcPublisherDeps,
  type WebRtcStreamDescriptor,
  type WebRtcStreamingOverrides,
  type WebRtcStreamPublisher,
} from "../features/webrtc";
import { type DeviceCaptureRegistry } from "../features/webrtc/deviceCaptureRegistry";
import { ActionableError, type BootedDevice } from "../models";
import { type IdGenerator } from "../utils/IdGenerator";
import { type Timer } from "../utils/SystemTimer";

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
  sessionUuid?: string;
  subscriptionKind?: StreamSubscriptionKind;
  /** Resolved by the socket authenticator; the manager never queries daemon ownership. */
  ownsDevice?: boolean;
  overrides?: WebRtcStreamingOverrides;
}

export interface WebRtcStreamRecord {
  config: ReturnType<typeof resolveWebRtcStreamingConfig>;
  streamId: string;
  device: BootedDevice;
  publisher: WebRtcStreamPublisher;
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
  /** Initial capture failed, but raced consumers still need its failure descriptor. */
  initialStartFailed: boolean;
  mediaParser: H264AnnexBParser;
  cachedSps: Buffer | null;
  cachedPps: Buffer | null;
  stateWaiters: Set<() => void>;
  leases: Map<string, { expiresAt: number; sessionUuid?: string; kind: StreamSubscriptionKind }>;
  leaseExpiryHandle: NodeJS.Timeout | null;
}

export interface WebRtcStreamManagerDependencies {
  captureRegistry?: DeviceCaptureRegistry;
  idGenerator: IdGenerator;
  createPublisher: (
    config: WebRtcPublisherConfig,
    deps: WebRtcPublisherDeps,
  ) => WebRtcStreamPublisher;
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
  isSessionLive?: (sessionUuid: string) => boolean;
}

export interface WebRtcSubscriptionLookup {
  streamId?: string;
  leaseId?: string;
  sessionUuid?: string;
  allowEndedLease?: boolean;
  existingLeaseOnly?: boolean;
}

export type ReadinessRecordResolution =
  | { type: "active"; record: WebRtcStreamRecord }
  | { type: "stopped"; descriptor: WebRtcStreamDescriptor };
interface WebRtcStreamQueryContext {
  dependencies: WebRtcStreamManagerDependencies;
  streams: Map<string, WebRtcStreamRecord>;
  endedLeases: Map<
    string,
    {
      streamId: string;
      reason: StreamSubscriptionEndReason;
      kind: StreamSubscriptionKind;
      expiresAt: number;
    }
  >;
  pruneEndedLeases(): void;
  assertLeaseNotEnded(input: { streamId?: string; leaseId?: string }): void;
  DEFAULT_STREAM_READY_TIMEOUT_MS: number;
  WEBRTC_STREAM_LEASE_TTL_MS: number;
  assertLeaseAccess(
    record: WebRtcStreamRecord,
    leaseId: string,
    ownerSessionUuid: string | undefined,
    sessionUuid: string | undefined,
  ): void;
  acquireLease(
    record: WebRtcStreamRecord,
    options: {
      requestedLeaseId?: string;
      sessionUuid?: string;
      mintIfUnknown?: boolean;
      subscriptionKind?: StreamSubscriptionKind;
    },
  ): string;
}
export class WebRtcStreamQueries {
  constructor(private readonly context: WebRtcStreamQueryContext) {}

  /**
   * Records that count as active for an unaddressed lookup. A record whose initial
   * start failed is retired: it stays in `streams` only so its lease holders can
   * read the failure by `streamId`, and never competes with a live stream.
   */
  unaddressedStreamCandidates = (): WebRtcStreamRecord[] => {
    const all = [...this.context.streams.values()];
    const active = all.filter((record) => !record.initialStartFailed);
    return active.length > 0 ? active : all;
  };

  addressedStreamRecord = (streamId?: string): WebRtcStreamRecord | undefined => {
    if (streamId !== undefined) {
      return this.context.streams.get(streamId);
    }
    const candidates = this.unaddressedStreamCandidates();
    return candidates.length === 1 ? candidates[0] : undefined;
  };

  leaseStreamRecord = (input: WebRtcSubscriptionLookup): WebRtcStreamRecord | undefined => {
    if (input.leaseId === undefined) {
      return undefined;
    }
    if (input.streamId !== undefined) {
      return this.context.streams.get(input.streamId);
    }
    const leaseId = input.leaseId;
    return [...this.context.streams.values()].find((record) => record.leases.has(leaseId));
  };

  callerSubscriptionKind = (input: WebRtcSubscriptionLookup): StreamSubscriptionKind => {
    // An ended lease on start is a fresh admission even if the caller holds other viewer leases.
    if (input.allowEndedLease && input.leaseId && this.context.endedLeases.has(input.leaseId)) {
      return "owner";
    }
    const record = this.addressedStreamRecord(input.streamId);
    const held = [...(record?.leases.values() ?? [])].filter(
      (lease) => lease.sessionUuid === input.sessionUuid,
    );
    return held.length > 0 && held.every((lease) => lease.kind === "viewer") ? "viewer" : "owner";
  };

  /** Existing lease kind wins, then all of the caller's addressed leases; never renews. */
  getWebRtcSubscriptionKind = (
    input: WebRtcSubscriptionLookup,
  ): StreamSubscriptionKind | undefined => {
    this.context.pruneEndedLeases();
    if (!input.allowEndedLease) {
      this.context.assertLeaseNotEnded(input);
    }
    const record = this.leaseStreamRecord(input);
    const leaseId = input.leaseId;
    const lease = leaseId ? record?.leases.get(leaseId) : undefined;
    if (record && leaseId && lease) {
      this.context.assertLeaseAccess(record, leaseId, lease.sessionUuid, input.sessionUuid);
      return lease.kind;
    }
    return input.existingLeaseOnly ? undefined : this.callerSubscriptionKind(input);
  };

  /** Snapshot of manager facts only; never renews a lease or trusts a wire target. */
  getWebRtcStreamControlContext = (input: {
    streamId?: string;
    leaseId?: string;
    sessionUuid?: string;
    deviceId?: string;
    overrides?: WebRtcStreamingOverrides;
    compareParameters?: boolean;
  }):
    | { streamId: string; deviceId: string; holdsLease: boolean; parametersMatch: boolean }
    | undefined => {
    const record =
      input.deviceId !== undefined
        ? this.activeStreamForDevice(input.deviceId)
        : (this.leaseStreamRecord(input) ?? this.addressedStreamRecord(input.streamId));
    if (!record) {
      return undefined;
    }
    const holdsLease = [...record.leases].some(
      ([leaseId, lease]) =>
        lease.sessionUuid === input.sessionUuid &&
        lease.expiresAt > this.context.dependencies.timer.now() &&
        (input.leaseId === undefined || leaseId === input.leaseId),
    );
    return {
      streamId: record.streamId,
      deviceId: record.device.deviceId,
      holdsLease,
      parametersMatch:
        !input.compareParameters || this.differingConfigKeys(record, input.overrides).length === 0,
    };
  };

  differingConfigKeys = (
    record: WebRtcStreamRecord,
    overrides?: WebRtcStreamingOverrides,
  ): Array<keyof WebRtcStreamRecord["config"]> => {
    const requested = resolveWebRtcStreamingConfig(overrides);
    const keys = Object.keys(record.config) as Array<keyof typeof requested>;
    return keys.filter((key) => !isDeepStrictEqual(record.config[key], requested[key]));
  };

  getWebRtcStreamDeviceIds = (): string[] => {
    return [...new Set([...this.context.streams.values()].map((record) => record.device.deviceId))];
  };

  isReadinessSatisfied = (
    record: WebRtcStreamRecord,
    readiness: "capture_ready" | "publishing",
  ): boolean => {
    if (readiness === "publishing") {
      return record.lifecycleState === "publishing";
    }
    return (
      record.sourceStarted &&
      (record.lifecycleState === "capture_ready" || record.lifecycleState === "publishing")
    );
  };

  stoppedReadinessDescriptor = (
    record: WebRtcStreamRecord,
    streamId: string,
    readiness: "capture_ready" | "publishing",
    leaseId?: string,
  ): WebRtcStreamDescriptor => {
    return {
      ...this.describeRecord(record, leaseId),
      state: "stopped",
      failure: {
        code: "stopped",
        message: `WebRTC stream ${streamId} was stopped while waiting for ${readiness}.`,
        at: this.context.dependencies.now().toISOString(),
      },
      fallback: null,
    };
  };

  readinessWaitDuration = (remainingMs: number, hasLease: boolean): number => {
    return hasLease
      ? Math.min(remainingMs, this.context.WEBRTC_STREAM_LEASE_TTL_MS / 2)
      : remainingMs;
  };

  waitForRecordStateChange = (record: WebRtcStreamRecord, waitMs: number): Promise<void> => {
    return new Promise<void>((resolve) => {
      const timeout = this.context.dependencies.timer.setTimeout(() => {
        record.stateWaiters.delete(wake);
        resolve();
      }, waitMs);
      const wake = () => {
        this.context.dependencies.timer.clearTimeout(timeout);
        resolve();
      };
      record.stateWaiters.add(wake);
    });
  };

  resolveReadinessRecord = (
    streamId: string,
    readiness: "capture_ready" | "publishing",
    leaseId: string | undefined,
    lastRecord: WebRtcStreamRecord | undefined,
  ): ReadinessRecordResolution => {
    const record = this.context.streams.get(streamId);
    if (record) {
      return { type: "active", record };
    }
    if (lastRecord?.lifecycleState === "stopping") {
      return {
        type: "stopped",
        descriptor: this.stoppedReadinessDescriptor(lastRecord, streamId, readiness, leaseId),
      };
    }
    throw new ActionableError(`No active WebRTC stream with id ${streamId}.`);
  };

  /**
   * Wait for local capture or WHIP publishing without conflating the two phases.
   * A timeout is a request-scoped result, not a capture failure, so one caller
   * cannot degrade a stream that is still healthy for another consumer.
   */
  waitForWebRtcStreamReadiness = async (
    streamId: string,
    readiness: "capture_ready" | "publishing",
    timeoutMs: number = this.context.DEFAULT_STREAM_READY_TIMEOUT_MS,
    leaseId?: string,
    sessionUuid?: string,
  ): Promise<WebRtcStreamDescriptor> => {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new ActionableError(
        "WebRTC stream readiness timeout must be a positive number of milliseconds.",
      );
    }
    const deadline = this.context.dependencies.timer.now() + timeoutMs;
    let activeLeaseId = leaseId;
    let lastRecord: WebRtcStreamRecord | undefined;

    for (;;) {
      this.context.assertLeaseNotEnded({ streamId, leaseId: activeLeaseId });
      const resolved = this.resolveReadinessRecord(streamId, readiness, activeLeaseId, lastRecord);
      if (resolved.type === "stopped") {
        return resolved.descriptor;
      }
      const record = resolved.record;
      lastRecord = record;
      if (activeLeaseId !== undefined) {
        activeLeaseId = this.context.acquireLease(record, {
          requestedLeaseId: activeLeaseId,
          sessionUuid,
        });
      }
      if (this.isReadinessSatisfied(record, readiness)) {
        return this.describeRecord(record, activeLeaseId);
      }
      if (record.lifecycleState === "degraded" || record.lifecycleState === "failed") {
        return this.describeRecord(record, activeLeaseId);
      }
      const remainingMs = deadline - this.context.dependencies.timer.now();
      if (remainingMs <= 0) {
        return this.readinessTimeoutDescriptor(record, readiness, activeLeaseId);
      }
      await this.waitForRecordStateChange(
        record,
        this.readinessWaitDuration(remainingMs, Boolean(activeLeaseId)),
      );
    }
  };

  readinessTimeoutDescriptor = (
    record: WebRtcStreamRecord,
    readiness: "capture_ready" | "publishing",
    leaseId?: string,
  ): WebRtcStreamDescriptor => {
    const code = readiness === "capture_ready" ? "capture_ready_timeout" : "publishing_timeout";
    return {
      ...this.describeRecord(record, leaseId),
      failure: {
        code,
        message: `Timed out waiting for WebRTC stream ${record.streamId} to reach ${readiness}.`,
        at: this.context.dependencies.now().toISOString(),
      },
      fallback: null,
    };
  };

  resolveStreamRecord = (streamId?: string): WebRtcStreamRecord => {
    if (streamId) {
      const record = this.context.streams.get(streamId);
      if (!record) {
        throw new ActionableError(`No active WebRTC stream with id ${streamId}.`);
      }
      return record;
    }

    const candidates = this.unaddressedStreamCandidates();
    if (candidates.length === 0) {
      throw new ActionableError("No active WebRTC streams. Provide a streamId.");
    }
    if (candidates.length > 1) {
      throw new ActionableError("Multiple active WebRTC streams. Provide a streamId.");
    }
    return candidates[0];
  };

  activeStreamForDevice = (deviceId: string): WebRtcStreamRecord | undefined => {
    for (const record of this.context.streams.values()) {
      if (record.device.deviceId === deviceId && !record.initialStartFailed) {
        return record;
      }
    }
    return undefined;
  };

  leaseExpiryAt = (record: WebRtcStreamRecord, leaseId: string): string | undefined => {
    const lease = record.leases.get(leaseId);
    if (!lease) {
      return undefined;
    }
    return new Date(
      this.context.dependencies.now().getTime() +
        Math.max(0, lease.expiresAt - this.context.dependencies.timer.now()),
    ).toISOString();
  };

  /** Descriptor for a record, including the manager-owned capture-source state. */
  describeRecord = (record: WebRtcStreamRecord, leaseId?: string): WebRtcStreamDescriptor => {
    const descriptor = record.publisher.getDescriptor();
    const sourceTelemetry = record.source?.getTelemetry?.() ?? record.sourceTelemetry;
    const leaseExpiresAt = leaseId ? this.leaseExpiryAt(record, leaseId) : undefined;
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
      fallback:
        record.lifecycleState === "degraded" || record.lifecycleState === "failed"
          ? { mode: "screenshots", reason: record.failure?.code ?? "capture_unavailable" }
          : null,
      lease: leaseId && leaseExpiresAt ? { id: leaseId, expiresAt: leaseExpiresAt } : null,
      consumerCount: record.leases.size,
    };
  };

  publisherTimestampField = (
    event: WebRtcPublisherLifecycleEvent,
  ): "sdpOffer" | "sdpAnswer" | "iceConnected" | "firstRtpSent" | undefined => {
    const fields: Partial<
      Record<
        WebRtcPublisherLifecycleEvent,
        "sdpOffer" | "sdpAnswer" | "iceConnected" | "firstRtpSent"
      >
    > = {
      sdp_offer_created: "sdpOffer",
      ice_gathering_started: "sdpOffer",
      whip_answer_received: "sdpAnswer",
      ice_connected: "iceConnected",
      first_rtp_sent: "firstRtpSent",
    };
    return fields[event];
  };
}
