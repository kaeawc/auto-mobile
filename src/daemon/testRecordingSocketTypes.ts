import type { Platform } from "../models";
import type { TestRecordingStatus } from "../server/testRecordingManager";

export interface TestRecordingCommand {
  command: "start" | "stop" | "status";
  deviceId?: string;
  platform?: Platform;
  recordingId?: string;
  planName?: string;
  /** Daemon session on whose behalf the command is made (issue #4752). */
  sessionUuid?: string;
}

export interface TestRecordingResponse {
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
  recording?: TestRecordingStatus;
  error?: string;
}
