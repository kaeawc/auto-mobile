/**
 * Wire protocol of `sim-hid-helper` (ios/sim-hid, #19118): one JSON command per stdin line, one
 * JSON ack per stdout line. Coordinates are iOS points relative to `width` x `height`.
 */
export interface SimHidScreenSize {
  width: number;
  height: number;
}

export type SimHidButton = "home" | "lock";

export type SimHidCommand =
  | { cmd: "ping" }
  | ({ cmd: "tap"; x: number; y: number; holdMs: number } & SimHidScreenSize)
  | ({
      cmd: "swipe";
      x: number;
      y: number;
      toX: number;
      toY: number;
      durationMs: number;
    } & SimHidScreenSize)
  | { cmd: "key"; key: string; modifiers: string[] }
  | { cmd: "button"; button: SimHidButton; holdMs?: number };

export interface SimHidWireError {
  code: string;
  message: string;
}

export interface SimHidAck {
  id: string;
  ok: boolean;
  /** Whether any HID message reached the simulator; false means nothing happened. */
  sent: boolean;
  elapsedMs?: number;
  error?: SimHidWireError;
}

/**
 * The result of one helper command, as callers route on it.
 * - `delivered`: SimulatorKit accepted every message (not that the app handled it).
 * - `unavailable`: nothing was sent; another input path may run the action.
 * - `indeterminate`: some input may have reached the simulator; do not replay it elsewhere.
 */
export type SimHidOutcome =
  | { status: "delivered"; elapsedMs?: number }
  | { status: "unavailable"; reason: string }
  | { status: "indeterminate"; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseWireError(value: unknown): SimHidWireError | undefined {
  if (!isRecord(value) || typeof value.code !== "string" || typeof value.message !== "string") {
    return undefined;
  }
  return { code: value.code, message: value.message };
}

export function parseSimHidAck(value: unknown): SimHidAck | undefined {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.ok !== "boolean" ||
    typeof value.sent !== "boolean"
  ) {
    return undefined;
  }
  return {
    id: value.id,
    ok: value.ok,
    sent: value.sent,
    ...(typeof value.elapsedMs === "number" ? { elapsedMs: value.elapsedMs } : {}),
    ...(parseWireError(value.error) ? { error: parseWireError(value.error) } : {}),
  };
}

/** The helper's first line: `ready`, or `error` before it exits. */
export type SimHidStartupLine =
  | { event: "ready"; initMs?: number }
  | { event: "error"; error: SimHidWireError };

export function parseSimHidStartupLine(value: unknown): SimHidStartupLine | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (value.event === "ready") {
    return {
      event: "ready",
      ...(typeof value.initMs === "number" ? { initMs: value.initMs } : {}),
    };
  }
  const error = parseWireError(value.error);
  return value.event === "error" && error ? { event: "error", error } : undefined;
}

export function outcomeFromAck(ack: SimHidAck): SimHidOutcome {
  if (ack.ok) {
    return {
      status: "delivered",
      ...(ack.elapsedMs === undefined ? {} : { elapsedMs: ack.elapsedMs }),
    };
  }
  const reason = ack.error
    ? `sim-hid-helper ${ack.error.code}: ${ack.error.message}`
    : "sim-hid-helper reported a failure";
  return ack.sent ? { status: "indeterminate", reason } : { status: "unavailable", reason };
}
