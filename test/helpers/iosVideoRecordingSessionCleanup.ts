import type { SessionOwnershipHeartbeat } from "./sessionOwnershipHeartbeat";

export type IosVideoRecordingCleanupStep =
  | "stop recording"
  | "stop session heartbeat"
  | "release session";

export interface IosVideoRecordingCleanupFailure {
  step: IosVideoRecordingCleanupStep;
  error: Error;
}

export interface IosVideoRecordingSessionCleanupOptions {
  sessionUuid?: string;
  recordingId?: string;
  recordingStopped: boolean;
  sessionHeartbeat?: SessionOwnershipHeartbeat;
  stopRecording(sessionUuid: string, recordingId: string): Promise<void>;
  releaseSession(sessionUuid: string): Promise<void>;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Releases every resource acquired by the real iOS recording integration.
 *
 * Cleanup is deliberately best-effort across steps: a failed recording stop
 * must not leave the heartbeat running or the simulator assigned, and callers
 * need every failure returned so cleanup cannot replace an earlier test error.
 */
export async function cleanupIosVideoRecordingSession(
  options: IosVideoRecordingSessionCleanupOptions,
): Promise<IosVideoRecordingCleanupFailure[]> {
  const failures: IosVideoRecordingCleanupFailure[] = [];

  if (options.sessionUuid && options.recordingId && !options.recordingStopped) {
    try {
      await options.stopRecording(options.sessionUuid, options.recordingId);
    } catch (error) {
      failures.push({ step: "stop recording", error: asError(error) });
    }
  }

  if (options.sessionHeartbeat) {
    try {
      const heartbeatError = await options.sessionHeartbeat.stop();
      if (heartbeatError) {
        failures.push({ step: "stop session heartbeat", error: heartbeatError });
      }
    } catch (error) {
      failures.push({ step: "stop session heartbeat", error: asError(error) });
    }
  }

  if (options.sessionUuid) {
    try {
      await options.releaseSession(options.sessionUuid);
    } catch (error) {
      failures.push({ step: "release session", error: asError(error) });
    }
  }

  return failures;
}
