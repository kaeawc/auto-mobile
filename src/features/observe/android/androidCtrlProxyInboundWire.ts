import { panelFingerprintFromWire } from "../../../models/DisplayPanel";

import { logger } from "../../../utils/logger";
import { type ScreenshotPerformanceMetadata } from "../ScreenshotMetadata";

import type {
  AndroidDisplayTransition,
  StorageTelemetryInput,
  WsStorageChangedMessage,
} from "./androidCtrlProxyInboundProtocol";

export function displayTransitionFromWire(value: unknown): AndroidDisplayTransition | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const event = value as Record<string, unknown>;
  if (
    !["added", "changed", "removed", "device_state"].includes(String(event.change)) ||
    !Number.isInteger(event.displayId)
  ) {
    return null;
  }
  const result: AndroidDisplayTransition = {
    change: event.change as AndroidDisplayTransition["change"],
    displayId: event.displayId as number,
  };
  if (typeof event.panelUniqueId === "string") {
    result.panelUniqueId = event.panelUniqueId;
  }
  const fingerprint = panelFingerprintFromWire(event.panelFingerprint);
  if (fingerprint) {
    result.panelFingerprint = fingerprint;
  }
  if (typeof event.width === "number") {
    result.width = event.width;
  }
  if (typeof event.height === "number") {
    result.height = event.height;
  }
  if (typeof event.state === "number") {
    result.state = event.state;
  }
  if (Number.isInteger(event.rotation)) {
    result.rotation = event.rotation as number;
  }
  if (typeof event.deviceState === "number") {
    result.deviceState = event.deviceState;
  }
  return result;
}

export function screenshotPerformanceMetadataFrom(
  metadata: ScreenshotPerformanceMetadata,
): ScreenshotPerformanceMetadata {
  return {
    screenshotCaptureDurationMs: metadata.screenshotCaptureDurationMs,
    screenshotEncodeDurationMs: metadata.screenshotEncodeDurationMs,
    screenshotByteLength: metadata.screenshotByteLength,
    screenshotBase64Length: metadata.screenshotBase64Length,
  };
}

/**
 * WebSocket message types that carry an SDK telemetry event to be fanned out to
 * `TelemetryRecorder` via {@link AndroidSdkEventIngestor.recordSdkEvent} (#2764).
 * `custom_event` is the runtime-only exception to the typed `WebSocketMessage` union.
 */
export const SDK_TELEMETRY_EVENT_TYPES: ReadonlySet<string> = new Set([
  "network_event",
  "websocket_frame_event",
  "log_event",
  "broadcast_event",
  "lifecycle_event",
  "custom_event",
]);

/**
 * Build the telemetry `recordStorageEvent` input from a `storage_changed` wire
 * message, normalizing its value to the string contract used by storage updates.
 * Unsafe legacy bare LONG values are logged and rejected. The runner-supplied
 * `previousValue` is threaded through ONLY when the
 * wire message carries it (`!== undefined`), so the repository's
 * `previousValue !== undefined` guard falls through to the per-insert auto-lookup
 * for legacy runners that omit it (#3000). An explicit null ("no prior value")
 * is honored verbatim and also skips the lookup.
 */
export function storageTelemetryInputFromWire(
  message: WsStorageChangedMessage,
  resolvedTimestamp: number,
): StorageTelemetryInput | undefined {
  const normalizedValue = normalizeStorageWireValue(message.value, message.valueType);
  if (normalizedValue === undefined) {
    logger.warn(
      `[CTRL_PROXY] Ignoring unsafe legacy LONG storage value for telemetry ${message.packageName ?? "unknown"}/${message.fileName ?? "unknown"}`,
    );
    return undefined;
  }
  const input: StorageTelemetryInput = {
    timestamp: resolvedTimestamp,
    applicationId: message.packageName ?? null,
    fileName: message.fileName ?? "",
    key: message.key ?? null,
    value: normalizedValue,
    valueType: message.valueType ?? "STRING",
    changeType: message.changeType ?? "modify",
  };
  if (message.previousValue !== undefined) {
    input.previousValue = message.previousValue;
  }
  return input;
}

/**
 * Normalize a `storage_changed` wire value to the JSON-encoded string that
 * `StorageChangedEvent.value` and every downstream consumer expect.
 *
 * The CtrlProxy runner emits `value` as a raw JSON fragment: a quoted string for
 * STRING preferences, but a bare JSON number / boolean / array for INT, LONG,
 * FLOAT, BOOLEAN, and STRING_SET. `JSON.parse` on the wire frame therefore yields
 * a JS `number`/`boolean`/`array` for those types, not a string. Forwarding that
 * runtime value unchanged makes the desktop `storage_update` frame fail
 * kotlinx-serialization decoding (its `StorageEventData.value` is `String?`), so
 * live updates silently drop for every non-string preference type (#4709 review).
 * Re-encoding non-strings with `JSON.stringify` restores the string contract:
 * `42` -> `"42"`, `true` -> `"true"`, `["a","b"]` -> `'["a","b"]'` — each of which
 * the desktop `parseKeyValue` decodes back to its declared type. A legacy runner can send LONG
 * as a bare JSON number; JavaScript has already rounded unsafe values by the time this function
 * receives them, so return `undefined` to make callers reject rather than forward corrupted data.
 */
export function normalizeStorageWireValue(
  value: unknown,
  valueType?: string,
): string | null | undefined {
  if (value === null || value === undefined) {
    return null;
  }
  if (valueType === "LONG" && typeof value === "number" && !Number.isSafeInteger(value)) {
    return undefined;
  }
  return typeof value === "string" ? value : JSON.stringify(value);
}

export interface JsonParseContext {
  source?: string;
}

/**
 * Parse a CtrlProxy frame without rounding legacy bare 64-bit storage values. Modern runners quote
 * LONG values, but older runners sent them as JSON numbers. Bun's standard JSON.parse source
 * context exposes the original numeric token before IEEE-754 conversion loses digits.
 */
export function parseCtrlProxyJson<T>(text: string): T {
  return JSON.parse(text, (key: string, value: unknown, context?: JsonParseContext): unknown => {
    if (
      (key === "value" || key === "previousValue") &&
      typeof value === "number" &&
      Number.isInteger(value) &&
      !Number.isSafeInteger(value) &&
      context?.source
    ) {
      return context.source;
    }
    return value;
  });
}
