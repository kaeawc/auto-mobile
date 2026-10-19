import type { ToolCallRecord, ToolCallRepository } from "../db/toolCallRepository";
import { errorMessage } from "../models/describeUnknownError";
import { classifyToolResult } from "../utils/toolEnvelopePayload";
import { formatStructuredToolError } from "../utils/formatStructuredToolError";
import { logger } from "../utils/logger";
import type { Timer } from "../utils/SystemTimer";
import { isRecord } from "./pipeline/isRecord";

type ToolCallOutcome = Pick<ToolCallRecord, "status" | "errorType" | "errorMessage">;

function thrownToolCallOutcome(error: unknown): ToolCallOutcome {
  const code = isRecord(error) && typeof error.code === "string" ? error.code : undefined;
  return {
    status: "failure",
    errorType: code?.trim()
      ? code
      : error instanceof Error
        ? error.constructor.name || error.name
        : "UnknownError",
    errorMessage: errorMessage(error),
  };
}

function returnedToolCallFailure(response: unknown, name: string): ToolCallOutcome {
  const result = classifyToolResult(response, name, null);
  const details = result.kind === "payload" ? (result.failure ?? result.payload) : undefined;
  return {
    status: "failure",
    errorType: "ToolResultError",
    errorMessage:
      formatStructuredToolError(details?.error) ??
      formatStructuredToolError(details?.message) ??
      `Tool "${name}" returned failure status`,
  };
}

function recordCompletedToolCall(
  repository: Pick<ToolCallRepository, "recordToolCall">,
  record: ToolCallRecord,
): void {
  void Promise.resolve()
    .then(() => repository.recordToolCall(record))
    .catch((error: unknown) => {
      logger.warn(`[ToolRegistry] Failed to record tool call for ${record.toolName}: ${error}`);
    });
}

interface ToolCallRecordingState {
  sessionUuid?: string;
  deviceId?: string;
  durationMs?: number;
  executionError?: { error: unknown };
  outcome: ToolCallOutcome;
}

export function toolCallOutcome(
  result: { finalizedResponse: unknown },
  name: string,
  succeeded: boolean,
): ToolCallOutcome {
  return succeeded
    ? { status: "success" }
    : returnedToolCallFailure(result.finalizedResponse, name);
}

export async function runRecordedToolCall<T>(
  repository: Pick<ToolCallRepository, "recordToolCall">,
  timer: Timer,
  name: string,
  sessionUuid: string | undefined,
  handler: (recording: ToolCallRecordingState, startMs: number) => Promise<T>,
): Promise<T> {
  const startMs = timer.now();
  const timestamp = new Date().toISOString();
  const recording: ToolCallRecordingState = { sessionUuid, outcome: { status: "success" } };
  try {
    return await handler(recording, startMs);
  } catch (error) {
    recording.outcome = thrownToolCallOutcome(
      recording.executionError ? recording.executionError.error : error,
    );
    throw error;
  } finally {
    recordCompletedToolCall(repository, {
      toolName: name,
      timestamp,
      sessionUuid: recording.sessionUuid,
      deviceId: recording.deviceId,
      durationMs: recording.durationMs ?? timer.now() - startMs,
      ...recording.outcome,
    });
  }
}
