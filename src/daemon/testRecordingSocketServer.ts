import { Timer, defaultTimer } from "../utils/SystemTimer";
import { RequestResponseSocketServer, getSocketPath } from "./socketServer/index";
import { DeviceSessionManager } from "../utils/DeviceSessionManager";
import type { BootedDevice, Platform, SomePlatform } from "../models";
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

const resolveDevice = async (deviceId?: string, platform?: Platform): Promise<BootedDevice> => {
  const deviceSessionManager = DeviceSessionManager.getInstance();

  let resolvedPlatform: SomePlatform = platform ?? "either";
  if (deviceId && !platform) {
    const connectedDevices = await deviceSessionManager.detectConnectedPlatforms();
    const match = connectedDevices.find((device) => device.deviceId === deviceId);
    if (!match) {
      throw new Error(`Device ${deviceId} not found among connected devices.`);
    }
    resolvedPlatform = match.platform;
  }

  return deviceSessionManager.ensureDeviceReady(resolvedPlatform, deviceId);
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

  constructor(
    socketPath: string = getSocketPath(TEST_RECORDING_SOCKET_CONFIG),
    timer: Timer = defaultTimer,
    authenticator: StreamSocketAuthenticator = createDefaultStreamSocketAuthenticator(
      "testRecording",
    ),
  ) {
    super(socketPath, timer, "TestRecording");
    this.authenticator = authenticator;
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
        const platform = ensurePlatform(request.platform);
        const device = await resolveDevice(request.deviceId, platform);
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
