import { logger } from "../utils/logger";
import type { TelemetryRecorder } from "../features/telemetry/TelemetryRecorder";

/** What a client declared in its `elicitation` capability. */
export type ElicitationDeclared = "none" | "bare" | "form" | "url";
/** Legacy asks push `elicitation/create`; modern (2026-07-28) asks answer with `input_required`. */
export type ElicitationEra = "legacy" | "modern";
/**
 * How an ambiguous-device question ended. `not_offered` means the client cannot be asked (no
 * capability, or url-only); `disabled` means `AUTOMOBILE_ELICITATION=off`; `remembered` means this
 * connection already declined or cancelled the same candidate set; `asked` is a modern question handed back to the client, whose answer
 * arrives on a later request and is recorded then.
 */
export type ElicitationOutcome =
  | "not_offered"
  | "disabled"
  | "remembered"
  | "asked"
  | "accept"
  | "decline"
  | "cancel"
  | "timeout"
  | "invalid"
  | "error";

export interface ElicitationRecord {
  readonly toolName: string;
  readonly era: ElicitationEra;
  readonly declared: ElicitationDeclared;
  readonly outcome: ElicitationOutcome;
  readonly candidateCount: number;
  /** Wall-clock time of the record on the injected clock. */
  readonly atMs: number;
  /** Ask-to-answer time on the injected clock; absent when there was no answer to time. */
  readonly latencyMs?: number;
}

/** One record per ambiguous-device refusal, so `not_offered` is the denominator for the rest. */
export interface ElicitationRecorder {
  record(record: ElicitationRecord): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Classifies the `elicitation` entry of a client's declared capabilities. */
export function classifyElicitationDeclaration(capabilities: unknown): ElicitationDeclared {
  const elicitation = isRecord(capabilities) ? capabilities.elicitation : undefined;
  if (!isRecord(elicitation)) {
    return "none";
  }
  if (elicitation.form !== undefined) {
    return "form";
  }
  return elicitation.url !== undefined ? "url" : "bare";
}

function logLine(record: ElicitationRecord): string {
  return (
    `[elicitation] ${record.toolName} era=${record.era} declared=${record.declared} ` +
    `outcome=${record.outcome} candidates=${record.candidateCount}` +
    (record.latencyMs === undefined ? "" : ` latencyMs=${record.latencyMs}`)
  );
}

/** Logs one info line per record; every process can do this without a telemetry sink. */
export const loggingElicitationRecorder: ElicitationRecorder = {
  record: (record) => logger.info(logLine(record)),
};

/** Logs, then pushes a push-only `elicitation` telemetry event to the given sink. */
export function createTelemetryElicitationRecorder(
  sink: Pick<TelemetryRecorder, "recordElicitationEvent">,
): ElicitationRecorder {
  return {
    record(record) {
      loggingElicitationRecorder.record(record);
      sink.recordElicitationEvent(record);
    },
  };
}

let registered: ElicitationRecorder = loggingElicitationRecorder;

/** Composition roots with a telemetry sink register it; everything else keeps logging only. */
export function registerElicitationRecorder(recorder: ElicitationRecorder): void {
  registered = recorder;
}

/** The recorder callers use by default: whatever the composition root registered. */
export const defaultElicitationRecorder: ElicitationRecorder = {
  record: (record) => registered.record(record),
};
