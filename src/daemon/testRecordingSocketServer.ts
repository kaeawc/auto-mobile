import { Timer, defaultTimer } from "../utils/SystemTimer";
import { RequestResponseSocketServer, getSocketPath } from "./socketServer/index";
import { DeviceSessionManager } from "../utils/DeviceSessionManager";
import type { PlatformDeviceManager } from "../utils/deviceUtils";
import { ActionableError, type BootedDevice, type Platform } from "../models";
import {
  getTestRecordingStatus,
  startTestRecording,
  stopTestRecording,
} from "../server/testRecordingManager";
import { TestRecordingCommand, TestRecordingResponse } from "./testRecordingSocketTypes";
import { TEST_RECORDING_SOCKET_CONFIG } from "./daemonFiles";
import {
  createDefaultStreamSocketAuthenticator,
  type StreamSocketAuthenticator,
} from "./streamSocketAuth";
import { daemonDeviceAdmissionGate, type DeviceAdmissionGate } from "./deviceAdmissionGate";
import { reconcileDiscoveryObservation } from "./discoveryReconcile";

/** Completes the FUNNEL 2 refusal: "Refusing `<purpose>` on device '<serial>'". */
const TEST_RECORDING_PURPOSE = "to start a test recording";

/**
 * Device resolution for a `start`, in two steps the server keeps apart so the
 * admission gate can run between them: SELECT the target (discovery folded into
 * the pool, then a match — no device side effects), then READY it (runner
 * setup on a device the gate has already admitted). Injected so the server can
 * be tested without a device pool or a real runner (#6923).
 */
export interface TestRecordingDeviceResolution {
  selectDevice(deviceId?: string, platform?: Platform): Promise<BootedDevice>;
  readyDevice(device: BootedDevice): Promise<BootedDevice>;
}

/**
 * Pick the device this recording targets, and fold the discovery it ran into
 * the pool first.
 *
 * FUNNEL 1. This resolver runs its OWN fresh discovery, so it can be the first
 * path to see the `Unknown (<serial>)` placeholder or a different AVD on a
 * reused serial. It used to discover through
 * `DeviceSessionManager.detectConnectedPlatforms` and never fold the
 * observation in, so the admission gate in `handleRequest` re-read pool state
 * from BEFORE this discovery — the same shape the video-stream and WebRTC
 * resolvers were given in #6888 (#6923).
 *
 * Reconciling happens BEFORE the serial is matched, so an observation about
 * some OTHER serial is still folded in even when this request goes on to fail.
 * Selection only: readiness is {@link TestRecordingDeviceResolution.readyDevice}.
 *
 * With no serial named, several connected devices resolve to `currentDevice`
 * (the one `setActiveDevice` selected) when it is among them, preserving the
 * tie-break `ensureDeviceReady` applied before selection was split out.
 */
export async function resolveTestRecordingDevice(
  deviceManager: Pick<PlatformDeviceManager, "getBootedDevices">,
  deviceId?: string,
  platform?: Platform,
  currentDevice: () => BootedDevice | undefined = () => undefined,
): Promise<BootedDevice> {
  const observed = await deviceManager.getBootedDevices(platform ?? "either");
  await reconcileDiscoveryObservation(observed, "test-recording-resolve");
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
  const current = currentDevice();
  const currentMatch = current
    ? devices.find((device) => device.deviceId === current.deviceId)
    : undefined;
  if (currentMatch) {
    return currentMatch;
  }
  throw new ActionableError(
    `Multiple ${scope}; specify deviceId. Found: ${devices
      .map((device) => device.deviceId)
      .join(", ")}`,
  );
}

const defaultDeviceResolution: TestRecordingDeviceResolution = {
  selectDevice: (deviceId, platform) => {
    const deviceSessionManager = DeviceSessionManager.getInstance();
    return resolveTestRecordingDevice(
      deviceSessionManager.getPlatformDeviceManager(),
      deviceId,
      platform,
      () => deviceSessionManager.getCurrentDevice(),
    );
  },
  // Readiness for an already-selected, already-admitted device: the same
  // provided-device path (runner setup, current-device selection, appearance)
  // a start took before, now naming its target exactly.
  readyDevice: (device) =>
    DeviceSessionManager.getInstance().ensureDeviceReady(device.platform, device.deviceId),
};

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
 * Socket server for test recording commands.
 * Handles start, stop, and status commands.
 */
export class TestRecordingSocketServer extends RequestResponseSocketServer<
  TestRecordingCommand,
  TestRecordingResponse
> {
  private readonly authenticator: StreamSocketAuthenticator;
  private readonly admissionGate: DeviceAdmissionGate;
  private readonly deviceResolution: TestRecordingDeviceResolution;

  constructor(
    socketPath: string = getSocketPath(TEST_RECORDING_SOCKET_CONFIG),
    timer: Timer = defaultTimer,
    authenticator: StreamSocketAuthenticator = createDefaultStreamSocketAuthenticator(
      "testRecording",
    ),
    admissionGate: DeviceAdmissionGate = daemonDeviceAdmissionGate,
    deviceResolution: TestRecordingDeviceResolution = defaultDeviceResolution,
  ) {
    super(socketPath, timer, "TestRecording");
    this.authenticator = authenticator;
    this.admissionGate = admissionGate;
    this.deviceResolution = deviceResolution;
  }

  protected async handleRequest(request: TestRecordingCommand): Promise<TestRecordingResponse> {
    const command = request?.command;
    if (!command) {
      throw new Error("Request missing command field.");
    }

    switch (command) {
      case "start": {
        // Authorize before touching device state: an unauthenticated or
        // cross-session caller cannot start a recording on another session's
        // device (issue #4752).
        this.authenticator.authorize({
          sessionUuid: request.sessionUuid,
          deviceId: request.deviceId,
        });
        // FUNNEL 2, before any device work. The quarantine preserves the owning
        // session, so the authorization above still passes on a serial whose AVD
        // the pool can no longer identify, and readiness would go on to set up
        // whichever runtime now answers on it
        // ([#6888](https://github.com/kaeawc/auto-mobile/pull/6888) review).
        // Gated twice because an omitted `deviceId` names its target only after
        // selection — and selection is kept apart from readiness precisely so
        // this second gate runs BEFORE any runner setup side effect (#6923).
        if (request.deviceId !== undefined) {
          this.admissionGate.assertDeviceActionable(request.deviceId, TEST_RECORDING_PURPOSE);
        }
        const platform = ensurePlatform(request.platform);
        const selected = await this.deviceResolution.selectDevice(request.deviceId, platform);
        this.admissionGate.assertDeviceActionable(selected.deviceId, TEST_RECORDING_PURPOSE);
        const device = await this.deviceResolution.readyDevice(selected);
        const result = await startTestRecording(device);
        return {
          success: true,
          recordingId: result.recordingId,
          startedAt: result.startedAt,
          deviceId: result.deviceId,
          platform: result.platform,
        };
      }
      case "stop": {
        // Authorize the stop against the active recording's device so a session
        // that does not own it cannot stop another session's recording — the
        // recordingId-only guard in stopTestRecording is not an ownership check
        // (issue #4752).
        const active = getTestRecordingStatus();
        this.authenticator.authorize({
          sessionUuid: request.sessionUuid,
          deviceId: request.deviceId ?? active?.deviceId,
        });
        const result = await stopTestRecording(request.recordingId, request.planName);
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
        };
      }
      case "status": {
        // Status reveals the active recording's device/id; require a live
        // session so it is not readable by an unauthenticated caller (issue #4752).
        this.authenticator.authorize({
          sessionUuid: request.sessionUuid,
          deviceId: request.deviceId,
        });
        const recording = getTestRecordingStatus();
        if (!recording) {
          return { success: true };
        }
        return { success: true, recording };
      }
      default:
        throw new Error(`Unsupported test recording command: ${String(command)}`);
    }
  }

  protected createErrorResponse(_id: string | undefined, error: string): TestRecordingResponse {
    return {
      success: false,
      error,
    };
  }
}

let socketServer: TestRecordingSocketServer | null = null;

export function getTestRecordingSocketPath(): string {
  return socketServer?.getSocketPath() ?? getSocketPath(TEST_RECORDING_SOCKET_CONFIG);
}

export async function startTestRecordingSocketServer(): Promise<void> {
  if (!socketServer) {
    socketServer = new TestRecordingSocketServer();
  }
  if (!socketServer.isListening()) {
    await socketServer.start();
  }
}

export async function stopTestRecordingSocketServer(): Promise<void> {
  if (!socketServer) {
    return;
  }
  await socketServer.close();
  socketServer = null;
}
