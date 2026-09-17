import type { SessionOwnershipHeartbeat } from "./sessionOwnershipHeartbeat";
import { defaultTimer, type Timer } from "../../src/utils/SystemTimer";

const DEFAULT_RECORDING_STOP_TIMEOUT_MS = 5_000;

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
  recordingStopTimeoutMs?: number;
  timer?: Timer;
  stopRecording(sessionUuid: string, recordingId: string, signal: AbortSignal): Promise<void>;
  releaseSession(sessionUuid: string): Promise<void>;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

async function stopRecordingWithinCleanupBudget(
  options: IosVideoRecordingSessionCleanupOptions,
  sessionUuid: string,
  recordingId: string,
): Promise<void> {
  const timer = options.timer ?? defaultTimer;
  const timeoutMs = options.recordingStopTimeoutMs ?? DEFAULT_RECORDING_STOP_TIMEOUT_MS;
  const controller = new AbortController();
  let timeoutHandle: NodeJS.Timeout | undefined;

  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutHandle = timer.setTimeout(() => {
      const error = new Error(
        `recording stop did not settle before cleanup timeout (${timeoutMs}ms)`,
      );
      reject(error);
      controller.abort(error);
    }, timeoutMs);
  });

  try {
    await Promise.race([
      options.stopRecording(sessionUuid, recordingId, controller.signal),
      timeout,
    ]);
  } finally {
    if (timeoutHandle !== undefined) {
      timer.clearTimeout(timeoutHandle);
    }
  }
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
      await stopRecordingWithinCleanupBudget(options, options.sessionUuid, options.recordingId);
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
