import type { Platform } from "../models";
import type { DeviceGestureRecordingStatus } from "../server/deviceGestureRecordingManager";
import type { SocketRequest } from "./socketServer/SocketServerTypes";

export interface DeviceGestureRecordingCommand extends SocketRequest {
  command: "start" | "stop" | "status";
  deviceId?: string;
  platform?: Platform;
  recordingId?: string;
  planName?: string;
  /** Daemon session on whose behalf the command is made (issue #4752). */
  sessionUuid?: string;
}

export interface DeviceGestureRecordingResponse {
  success: boolean;
  recordingId?: string;
  startedAt?: string;
  stoppedAt?: string;
  deviceId?: string;
  platform?: Platform;
  planName?: string;
  planContent?: string;
  stepCount?: number;
  durationMs?: number;
  recording?: DeviceGestureRecordingStatus;
  error?: string;
  /** Machine-readable cause of an unsuccessful recording command, when available. */
  reason?: string;
}
