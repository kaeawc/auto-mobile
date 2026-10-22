import { SocketServerSingleton } from "./socketServerSingleton";
import { Timer, defaultTimer } from "../utils/SystemTimer";
import { RequestResponseSocketServer, getSocketPath } from "./socketServer/index";
import type { DeviceReadiness } from "./readiness/DeviceReadiness";
import type { PlatformDeviceManager } from "../devices/deviceUtils";
import { ActionableError, type BootedDevice, type Platform } from "../models";
import {
  getDeviceGestureRecordingStatus,
  startDeviceGestureRecording,
  getStoppedDeviceGestureRecording,
  joinInFlightDeviceGestureRecordingStop,
  stopDeviceGestureRecording,
  NoUserInputCapturedError,
} from "./deviceGestureRecordingManager";
import { logger } from "../utils/logger";
import {
  DeviceGestureRecordingCommand,
  DeviceGestureRecordingResponse,
} from "./deviceGestureRecordingSocketTypes";
import { DEVICE_GESTURE_RECORDING_SOCKET_CONFIG } from "./daemonFiles";
import {
  authorizeResolvedDevice,
  createDefaultStreamSocketAuthenticator,
  type StreamSocketAuthenticator,
} from "./streamSocketAuth";
import { daemonDeviceAdmissionGate, type DeviceAdmissionGate } from "../utils/deviceAdmissionGate";
import { reconcileDiscoveryObservation } from "./discoveryReconcile";
import { assertInputNotOnForeignBindingDevice } from "./inputDeviceOwnership";
import { defaultDaemonContext } from "./daemonContext";
import { resolveDirectSessionDevice } from "../utils/directSessionDeviceRegistry";
import { deviceGestureRecordingStartOwnershipRefusal } from "./deviceGestureRecordingStartAdmission";

/** Completes the FUNNEL 2 refusal: "Refusing `<purpose>` on device '<serial>'". */
const DEVICE_GESTURE_RECORDING_PURPOSE = "to start a device gesture recording";

/**
 * Device resolution for a `start`, in two steps the server keeps apart so the
 * admission gate can run between them: SELECT the target (discovery folded into
 * the pool, then a match — no device side effects), then READY it (runner
 * setup on a device the gate has already admitted). Injected so the server can
 * be tested without a device pool or a real runner (#6923).
 */
export interface DeviceGestureRecordingDeviceResolution {
  selectDevice(deviceId?: string, platform?: Platform, sessionUuid?: string): Promise<BootedDevice>;
  /**
   * `sessionUuid` is the session that asked for the recording: readiness writes to the device
   * (appearance on connect), and those writes follow that session's own config, not the global
   * one (#10976, #11641).
   */
  readyDevice(device: BootedDevice, sessionUuid?: string): Promise<BootedDevice>;
}

/** What device resolution needs of the device session manager; narrowed so a test can supply one. */
export type DeviceGestureRecordingDeviceSessions = Pick<
  DeviceReadiness,
  "ensureDeviceReady" | "getPlatformDeviceManager"
>;

/**
 * Pick the device this recording targets, and fold the discovery it ran into
 * the pool first.
 *
 * FUNNEL 1. This resolver runs its OWN fresh discovery, so it can be the first
 * path to see the `Unknown (<serial>)` placeholder or a different AVD on a
 * reused serial. It used to discover through
 * `DeviceReadiness.detectConnectedPlatforms` and never fold the
 * observation in, so the admission gate in `handleRequest` re-read pool state
 * from BEFORE this discovery — the same shape the video-stream and WebRTC
 * resolvers were given in #6888 (#6923).
 *
 * Reconciling happens BEFORE the serial is matched, so an observation about
 * some OTHER serial is still folded in even when this request goes on to fail.
 * Selection only: readiness is {@link DeviceGestureRecordingDeviceResolution.readyDevice}.
 *
 * With no serial named, several connected devices resolve to the requester's
 * session device when it is among them; otherwise the caller must name a device.
 */
export async function resolveDeviceGestureRecordingDevice(
  deviceManager: Pick<PlatformDeviceManager, "getBootedDevices">,
  deviceId?: string,
  platform?: Platform,
  sessionDeviceId: () => string | undefined = () => undefined,
): Promise<BootedDevice> {
  const observed = await deviceManager.getBootedDevices(platform ?? "either");
  await reconcileDiscoveryObservation(observed, "device-gesture-recording-resolve");
  // Discovery is already platform-scoped; the filter guards the same
  // cross-platform contamination `ensureDeviceReady` checks for.
  const devices = platform ? observed.filter((device) => device.platform === platform) : observed;

  const scope = platform ? `connected ${platform} devices` : "connected devices";
  if (deviceId) {
    const match = devices.find((device) => device.deviceId === deviceId);
    if (!match) {
      throw new ActionableError(`Device ${deviceId} not found among ${scope}.`);
    }
    return match;
  }

  if (devices.length === 0) {
    throw new ActionableError(`No ${scope} found.`);
  }
  if (devices.length === 1) {
    return devices[0];
  }
  const assignedDeviceId = sessionDeviceId();
  const sessionMatch = devices.find((device) => device.deviceId === assignedDeviceId);
  if (sessionMatch) {
    return sessionMatch;
  }
  throw new ActionableError(
    `Multiple ${scope}; specify deviceId. Found: ${devices
      .map((device) => device.deviceId)
      .join(", ")}`,
  );
}

/**
 * The broker binding exclusion for a recording start or stop (#11352): a device a broker binding
 * holds, idle or executing, is recorded only by that binding's own execution. Refuses with the typed
 * `device_assigned_to_binding`. Injected so tests can assert on the call without a pool.
 */
export type DeviceGestureRecordingBindingGate = (input: {
  action: string;
  device: { deviceId: string; platform: Platform };
  requesterSessionUuid: string | undefined;
}) => Promise<void>;

const defaultBindingGate: DeviceGestureRecordingBindingGate = async (input) => {
  const sessionManager = defaultDaemonContext.sessionManager();
  const pool = defaultDaemonContext.devicePool();
  if (!sessionManager || !pool) {
    return;
  }
  await assertInputNotOnForeignBindingDevice({
    action: input.action,
    deviceId: input.device.deviceId,
    platform: input.device.platform,
    requesterSessionUuid: input.requesterSessionUuid,
    sessionManager,
    gate: pool,
  });
};

/**
 * The production device resolution over a device session manager, resolved at each use. Exported
 * with readiness and the session-device ID lookup injectable so tests can use fakes.
 */
export function createDeviceGestureRecordingDeviceResolution(
  deviceSessions: () => DeviceGestureRecordingDeviceSessions,
  sessionDeviceId: (sessionUuid: string | undefined) => string | undefined = (sessionUuid) => {
    if (!sessionUuid) {
      return undefined;
    }
    const manager = defaultDaemonContext.sessionManager();
    return manager
      ? (manager.getDeviceForSession(sessionUuid) ?? undefined)
      : resolveDirectSessionDevice(sessionUuid)?.device.deviceId;
  },
): DeviceGestureRecordingDeviceResolution {
  return {
    selectDevice: (deviceId, platform, sessionUuid) => {
      const deviceReadiness = deviceSessions();
      return resolveDeviceGestureRecordingDevice(
        deviceReadiness.getPlatformDeviceManager(),
        deviceId,
        platform,
        () => sessionDeviceId(sessionUuid),
      );
    },
    // Readiness for an already-selected, already-admitted device: the same
    // provided-device path (runner setup, current-device selection, appearance)
    // a start took before, now naming its target exactly and the session it runs for.
    readyDevice: (device, sessionUuid) =>
      deviceSessions().ensureDeviceReady(device.platform, device.deviceId, {
        sessionId: sessionUuid,
      }),
  };
}

/**
 * The stream authenticator trims the session UUID it authorizes, so every lookup uses the same
 * trimmed UUID; a derived `base:label` suffix is kept (#14378).
 */
function withTrimmedSessionUuid(
  request: DeviceGestureRecordingCommand,
): DeviceGestureRecordingCommand {
  return typeof request?.sessionUuid === "string"
    ? { ...request, sessionUuid: request.sessionUuid.trim() || undefined }
    : request;
}

const ensurePlatform = (value: unknown): Platform | undefined => {
  if (value === undefined) {
    return undefined;
  }

  if (value === "android" || value === "ios") {
    return value;
  }

  throw new Error(`Unsupported platform value: ${String(value)}`);
};

/**
 * Socket server for device gesture recording commands.
 * Handles start, stop, and status commands.
 */
export class DeviceGestureRecordingSocketServer extends RequestResponseSocketServer<
  DeviceGestureRecordingCommand,
  DeviceGestureRecordingResponse
> {
  private readonly authenticator: StreamSocketAuthenticator;
  private readonly admissionGate: DeviceAdmissionGate;
  private readonly deviceResolution: DeviceGestureRecordingDeviceResolution;
  private readonly bindingGate: DeviceGestureRecordingBindingGate;

  constructor(
    socketPath: string = getSocketPath(DEVICE_GESTURE_RECORDING_SOCKET_CONFIG),
    timer: Timer = defaultTimer,
    authenticator: StreamSocketAuthenticator = createDefaultStreamSocketAuthenticator(
      "deviceGestureRecording",
    ),
    admissionGate: DeviceAdmissionGate = daemonDeviceAdmissionGate,
    deviceResolution: DeviceGestureRecordingDeviceResolution = createDeviceGestureRecordingDeviceResolution(
      () => {
        throw new ActionableError("Inject device readiness before recording gestures.");
      },
    ),
    bindingGate: DeviceGestureRecordingBindingGate = defaultBindingGate,
  ) {
    super(socketPath, timer, "DeviceGestureRecording");
    this.authenticator = authenticator;
    this.admissionGate = admissionGate;
    this.deviceResolution = deviceResolution;
    this.bindingGate = bindingGate;
  }

  protected async handleRequest(
    received: DeviceGestureRecordingCommand,
  ): Promise<DeviceGestureRecordingResponse> {
    const request = withTrimmedSessionUuid(received);
    const command = request?.command;
    if (!command) {
      throw new Error("Request missing command field.");
    }

    switch (command) {
      case "start": {
        if (request.deviceId !== undefined) {
          const refusal = deviceGestureRecordingStartOwnershipRefusal(
            request.deviceId,
            request.sessionUuid,
          );
          if (refusal) {
            return refusal;
          }
        }
        const daemonInitialized = defaultDaemonContext.isInitialized();
        // With a daemon registry, resolve the target before authentication so an unheld-device
        // start gets the same acquire-session refusal even without a requester identity.
        if (!daemonInitialized) {
          this.authenticator.authorize({
            sessionUuid: request.sessionUuid,
            deviceId: request.deviceId,
          });
        }
        // FUNNEL 2, before any device work. The quarantine preserves the owning
        // session, so ownership alone still admits a serial whose AVD the pool can
        // no longer identify; readiness would set up whichever runtime now answers on it
        // ([#6888](https://github.com/kaeawc/auto-mobile/pull/6888) review).
        // Gated twice because an omitted `deviceId` names its target only after
        // selection — and selection is kept apart from readiness precisely so
        // this second gate runs BEFORE any runner setup side effect (#6923).
        if (request.deviceId !== undefined) {
          this.admissionGate.assertDeviceActionable(
            request.deviceId,
            DEVICE_GESTURE_RECORDING_PURPOSE,
          );
        }
        return this.handleStart(request, daemonInitialized);
      }
      case "stop":
        return this.handleStop(request);
      case "status": {
        // Status reveals the active recording's device/id; require a live
        // session so it is not readable by an unauthenticated caller (issue #4752).
        // It is a read, so a live non-owner watches a held device (#10970).
        this.authenticator.authorize({
          sessionUuid: request.sessionUuid,
          deviceId: request.deviceId,
          admitViewer: true,
        });
        const recording = getDeviceGestureRecordingStatus();
        if (!recording) {
          return { success: true };
        }
        return { success: true, recording };
      }
      default:
        throw new Error(`Unsupported device gesture recording command: ${String(command)}`);
    }
  }

  private async handleStart(
    request: DeviceGestureRecordingCommand,
    daemonInitialized: boolean,
  ): Promise<DeviceGestureRecordingResponse> {
    const platform = ensurePlatform(request.platform);
    const selected = await this.deviceResolution.selectDevice(
      request.deviceId,
      platform,
      request.sessionUuid,
    );
    this.admissionGate.assertDeviceActionable(selected.deviceId, DEVICE_GESTURE_RECORDING_PURPOSE);
    const refusal = deviceGestureRecordingStartOwnershipRefusal(
      selected.deviceId,
      request.sessionUuid,
    );
    if (refusal) {
      return refusal;
    }
    if (!daemonInitialized) {
      authorizeResolvedDevice(this.authenticator, {
        sessionUuid: request.sessionUuid,
        deviceId: selected.deviceId,
      });
    }
    // Preserve broker binding refusals before the unheld-device start refusal (#11665).
    await this.bindingGate({
      action: "deviceGestureRecording start",
      device: selected,
      requesterSessionUuid: request.sessionUuid,
    });
    const postSlotRefusal = deviceGestureRecordingStartOwnershipRefusal(
      selected.deviceId,
      request.sessionUuid,
      true,
    );
    if (postSlotRefusal) {
      return postSlotRefusal;
    }
    if (daemonInitialized) {
      authorizeResolvedDevice(this.authenticator, {
        sessionUuid: request.sessionUuid,
        deviceId: selected.deviceId,
      });
    }
    const device = await this.deviceResolution.readyDevice(selected, request.sessionUuid);
    const result = await startDeviceGestureRecording(
      device,
      undefined,
      undefined,
      undefined,
      request.sessionUuid,
    );
    return {
      success: true,
      recordingId: result.recordingId,
      startedAt: result.startedAt,
      deviceId: result.deviceId,
      platform: result.platform,
    };
  }

  private async handleStop(
    request: DeviceGestureRecordingCommand,
  ): Promise<DeviceGestureRecordingResponse> {
    // Authorize the stop against the active recording's device so a session
    // that does not own it cannot stop another session's recording — the
    // recordingId-only guard in stopDeviceGestureRecording is not an ownership check
    // (issue #4752).
    if (request.recordingId) {
      try {
        const joined = await joinInFlightDeviceGestureRecordingStop(
          request.recordingId,
          request.sessionUuid,
        );
        if (joined) {
          return this.toStopResponse(joined);
        }
      } catch (error) {
        return this.toStopFailure(error);
      }
    }
    const active = getDeviceGestureRecordingStatus();
    // A stop by id after a release-time stop returns the owner's retained plan (#10958).
    // It needs no device and no live session: the owning session's uuid is the scope.
    const retained =
      !active && request.recordingId
        ? getStoppedDeviceGestureRecording(request.recordingId, request.sessionUuid)
        : undefined;
    if (retained) {
      return this.toStopResponse(retained);
    }
    this.authenticator.authorize({
      sessionUuid: request.sessionUuid,
      deviceId: active?.deviceId ?? request.deviceId,
    });
    if (!active) {
      throw new ActionableError("No active recording. Start a recording before stopping.");
    }
    if (request.deviceId !== undefined && active.deviceId !== request.deviceId) {
      throw new ActionableError(`No active recording found for device ${request.deviceId}.`);
    }
    await this.bindingGate({
      action: "deviceGestureRecording stop",
      device: { deviceId: active.deviceId, platform: active.platform },
      requesterSessionUuid: request.sessionUuid,
    });
    return stopDeviceGestureRecording(request.recordingId, request.planName)
      .then((result) => this.toStopResponse(result))
      .catch((error: unknown) => this.toStopFailure(error));
  }

  private toStopFailure(error: unknown): DeviceGestureRecordingResponse {
    if (!(error instanceof NoUserInputCapturedError)) {
      throw error;
    }
    logger.warn(`[DeviceGestureRecording] ${error.message}`, error);
    return { success: false, error: error.message, reason: error.reason };
  }

  private toStopResponse(
    result: Awaited<ReturnType<typeof stopDeviceGestureRecording>>,
  ): DeviceGestureRecordingResponse {
    return {
      success: true,
      recordingId: result.recordingId,
      startedAt: result.startedAt,
      stoppedAt: result.stoppedAt,
      deviceId: result.deviceId,
      platform: result.platform,
      planName: result.planName,
      planContent: result.planContent,
      stepCount: result.stepCount,
      durationMs: result.durationMs,
      ...(result.error ? { error: result.error } : {}),
    };
  }

  protected createErrorResponse(
    _id: string | undefined,
    error: string,
  ): DeviceGestureRecordingResponse {
    return {
      success: false,
      error,
    };
  }
}

const socketServer = new SocketServerSingleton<DeviceGestureRecordingSocketServer>();

export function getDeviceGestureRecordingSocketPath(): string {
  return (
    socketServer.instance?.getSocketPath() ?? getSocketPath(DEVICE_GESTURE_RECORDING_SOCKET_CONFIG)
  );
}

export async function startDeviceGestureRecordingSocketServer(
  readiness: DeviceGestureRecordingDeviceSessions,
): Promise<void> {
  await socketServer.start(
    () =>
      new DeviceGestureRecordingSocketServer(
        undefined,
        undefined,
        undefined,
        undefined,
        createDeviceGestureRecordingDeviceResolution(() => readiness),
      ),
  );
}

export async function stopDeviceGestureRecordingSocketServer(): Promise<void> {
  await socketServer.stop();
}
