import { z } from "zod/v4";
import type { BootedDevice } from "../models";
import {
  addDeviceTargetingToSchema,
  platformSchema,
  resourceLinkField,
} from "../utils/schemaHelpers";
import { highlightShapeSchema } from "../features/debug/VisualHighlight";
import { IOS_MAX_DURATION_SECONDS } from "../daemon/videoRecordingManager";
import type { LifecycleRequester } from "../features/deviceLifecycle/lifecycleRequester";
import {
  assertLifecycleCallerHoldsDevice,
  assertLifecycleCallerNotOnForeignBinding,
} from "./lifecycleDeviceOwnership";
import { InputDeviceOwnedError } from "../daemon/inputDeviceOwnership";
import { defaultDaemonContext } from "../daemon/daemonContext";
import { INTERNAL_MCP_SESSION_PARAM } from "../daemon/wire/constants";
import { resolveToolSelectionBaseSessionUuid } from "../features/toolSelection/selectionSessionResolver";
import { getToolSelectionContext } from "../features/toolSelection/toolSelectionContext";

/**
 * Narrow device-detection seam used by {@link resolveTargetDevices} when a call targets
 * all devices (e.g. a bare, by-device stop). The real {@link DeviceReadiness} singleton
 * satisfies it. Exposing only `detectConnectedPlatforms` keeps this honest under strict `tsc`
 * (a fake need not reproduce the manager's nominal private members) and lets a test resolve
 * devices without spawning real `adb`/`xcrun simctl` subprocesses — the latter can stall past
 * a test's timeout on a loaded macOS CI runner (issue #3943).
 */
interface ConnectedDeviceDetector {
  detectConnectedPlatforms(signal?: AbortSignal): Promise<BootedDevice[]>;
}

/** Collaborators the recording tools resolve devices and requesters through. */
export interface VideoRecordingToolDependencies {
  /** Resolves all-device targets; defaults to the live `DeviceReadiness`. */
  deviceDetector?: ConnectedDeviceDetector;
  /** Resolves requester and owner sessions; defaults to the daemon-backed resolver. */
  requesterResolver?: RecordingRequesterResolver;
}

export interface RecordingToolContext {
  deviceDetector: ConnectedDeviceDetector;
  requesterResolver: RecordingRequesterResolver;
}

export type VideoRecordingArgs = z.output<typeof videoRecordingSchema>;

const resolutionSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});

const highlightTimingSchema = z.object({
  startTimeMs: z.number().int().nonnegative().optional().describe("Start time in ms"),
});

const highlightSchema = z.object({
  description: z.string().optional().describe("Highlight description"),
  shape: highlightShapeSchema.describe("Red hand-drawn circle bounds"),
  timing: highlightTimingSchema.optional().describe("Highlight timing"),
});

export const videoRecordingSchema = addDeviceTargetingToSchema(
  z
    .object({
      action: z.enum(["start", "stop"]),
      // #5870: a `sessionUuid`/`deviceId` resolves the platform, so `platform` is
      // not required — a device handle from getAndroid/getApple is sufficient on
      // its own.
      platform: platformSchema.optional(),
      deviceId: z.string().optional(),
      recordingId: z.string().optional().describe("Recording ID"),
      qualityPreset: z.enum(["low", "medium", "high"]).optional(),
      targetBitrateKbps: z.number().int().positive().optional().describe("Bitrate Kbps"),
      maxThroughputMbps: z.number().positive().optional().describe("Max throughput Mbps"),
      fps: z.number().int().positive().optional().describe("FPS"),
      resolution: resolutionSchema.optional().describe("Resolution"),
      format: z.enum(["mp4"]).optional(),
      // Outer ceiling only; the manager enforces the real per-platform cap (iOS up to
      // IOS_MAX_DURATION_SECONDS, non-iOS 300s — see resolveMaxDurationSeconds).
      maxDuration: z
        .number()
        .int()
        .positive()
        .max(IOS_MAX_DURATION_SECONDS)
        .optional()
        .describe("Max duration seconds"),
      outputName: z.string().optional().describe("Recording label"),
      audio: z
        .boolean()
        .optional()
        .describe(
          "Also record the device's audio into the file (start only; local emulators and iOS Simulators; needs FFmpeg)",
        ),
      display: z.string().optional().describe('Android panel key, role, or "active" (start only)'),
      highlights: z.array(highlightSchema).optional().describe("Recording highlights"),
      resourceLink: resourceLinkField(),
    })
    .strict(),
);

/**
 * How a stop-by-id requester is matched to a recording's owner (#11140). The recorded owner is
 * the registry-resolved session (a derived `${base}:${label}` session, or the session holding
 * the device), while the caller may present the plan's base session or a proxy-bound one.
 */
export interface RecordingRequesterResolver {
  baseSessionUuid(sessionUuid: string): string;
  /** Whether the MCP connection acquired the session that holds `deviceId`. */
  connectionOwnsDeviceSession(
    mcpSessionId: string,
    deviceId: string,
    ownerBaseSessionUuid: string,
  ): boolean;
  /** Whether a live session holds `deviceId`. A device no session holds takes calls from anyone. */
  isDeviceHeld(deviceId: string): boolean;
  /** Daemon-aware holder and broker binding gate; omitted by small in-memory resolver fakes. */
  assertFanoutTargetAllowed?(device: BootedDevice, requester: LifecycleRequester): Promise<void>;
  /** Holder identity, when available, for the connection-ownership seam. Never sent to clients. */
  holdingSessionUuid?(deviceId: string): string | undefined;
  /** Session acquired by this connection on this device, for recording ownership at start. */
  resolveOwnedDeviceSessionForMcpSession?(
    mcpSessionId: string,
    deviceId: string,
  ): string | undefined;
}

export const daemonRecordingRequesterResolver: RecordingRequesterResolver = {
  async assertFanoutTargetAllowed(device, requester) {
    const pool = defaultDaemonContext.devicePool();
    if (!pool) {
      return;
    }
    const held = requester.mcpSessionId
      ? pool.resolveOwnedDeviceSessionForMcpSession(requester.mcpSessionId, device.deviceId)
      : undefined;
    const effectiveRequester = held ? { ...requester, sessionUuid: held } : requester;
    const input = { toolName: "videoRecording", device, requester: effectiveRequester };
    await assertLifecycleCallerNotOnForeignBinding(input);
    assertLifecycleCallerHoldsDevice({ ...input, force: false });
  },
  baseSessionUuid(sessionUuid) {
    const sessionManager = defaultDaemonContext.sessionManager();
    if (!sessionManager) {
      return sessionUuid;
    }
    return resolveToolSelectionBaseSessionUuid(sessionUuid, sessionManager) ?? sessionUuid;
  },
  connectionOwnsDeviceSession(mcpSessionId, deviceId, ownerBaseSessionUuid) {
    const held = defaultDaemonContext
      .devicePool()
      ?.resolveOwnedDeviceSessionForMcpSession(mcpSessionId, deviceId);
    return held !== undefined && this.baseSessionUuid(held) === ownerBaseSessionUuid;
  },
  resolveOwnedDeviceSessionForMcpSession(mcpSessionId, deviceId) {
    return defaultDaemonContext
      .devicePool()
      ?.resolveOwnedDeviceSessionForMcpSession(mcpSessionId, deviceId);
  },
  isDeviceHeld(deviceId) {
    const owner = defaultDaemonContext.sessionManager()?.getSessionForDevice(deviceId);
    return owner !== undefined && owner !== null;
  },
};

export function mcpSessionIdOf(args: VideoRecordingArgs): string | undefined {
  const value: unknown = Reflect.get(args, INTERNAL_MCP_SESSION_PARAM);
  return typeof value === "string" && value.length > 0
    ? value
    : getToolSelectionContext()?.callerMcpSessionId;
}

export function recordingStartOwner(
  ctx: RecordingToolContext,
  args: VideoRecordingArgs,
  deviceId: string,
): string | undefined {
  const connection = mcpSessionIdOf(args);
  if (!connection) {
    return args.sessionUuid;
  }
  const resolved = ctx.requesterResolver.resolveOwnedDeviceSessionForMcpSession?.(
    connection,
    deviceId,
  );
  if (resolved) {
    return resolved;
  }
  const holder = ctx.requesterResolver.holdingSessionUuid?.(deviceId);
  return holder &&
    ctx.requesterResolver.connectionOwnsDeviceSession(
      connection,
      deviceId,
      ctx.requesterResolver.baseSessionUuid(holder),
    )
    ? holder
    : args.sessionUuid;
}

/**
 * An active recording another session started is not the caller's to stop (#11130): a stop by id
 * needs no device, so without this any caller holding a recordingId could end a capture on a
 * device it does not hold. The recording's owner (its base session counts) and the connection
 * that acquired the owner's device session may stop it.
 *
 * A caller with no session is judged like any sessionless control call (#11647,
 * docs/using/device-ownership.md): refused while a session holds the recording's device, open on
 * a device no session holds. An ownerless recording stays stoppable by anyone.
 */
export function assertActiveRecordingOwner(
  ctx: RecordingToolContext,
  input: {
    recordingId: string;
    deviceId: string;
    recordingOwner: string | undefined;
    requesterSessionUuid: string | undefined;
    requesterMcpSessionId?: string;
  },
): void {
  const { recordingId, deviceId, recordingOwner, requesterSessionUuid, requesterMcpSessionId } =
    input;
  if (!recordingOwner || recordingOwner === requesterSessionUuid) {
    return;
  }
  const ownerBase = ctx.requesterResolver.baseSessionUuid(recordingOwner);
  if (
    requesterSessionUuid !== undefined &&
    ctx.requesterResolver.baseSessionUuid(requesterSessionUuid) === ownerBase
  ) {
    return;
  }
  if (
    requesterMcpSessionId &&
    ctx.requesterResolver.connectionOwnsDeviceSession(requesterMcpSessionId, deviceId, ownerBase)
  ) {
    return;
  }
  if (requesterSessionUuid === undefined && !ctx.requesterResolver.isDeviceHeld(deviceId)) {
    return;
  }
  throw new InputDeviceOwnedError("videoRecording stop", deviceId, requesterSessionUuid, {
    message:
      `videoRecording stop refused: recording ${recordingId} on device '${deviceId}' belongs to ` +
      "another session. Only the session that started an active recording can stop it.",
  });
}
