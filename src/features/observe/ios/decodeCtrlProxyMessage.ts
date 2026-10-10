/**
 * decodeCtrlProxyMessage - pure wire-protocol decoding for the iOS CtrlProxy.
 *
 * This module owns the request/response reshaping that maps the ~30 wire message
 * types the runner emits into the result objects the request manager resolves.
 * It is intentionally free of client/connection state so it can be unit-tested in
 * isolation; `IOSCtrlProxyClient.processMessage` is a thin adapter over it.
 */

import type { CtrlProxyPerfTiming, WebSocketMessage } from "./types";
import { rewriteUnknownCommandError as rewritePlatformUnknownCommandError } from "../shared/rewriteUnknownCommandError";
import type { KeyValueEntry } from "../../storage/storageTypes";

/**
 * Decoded request/response message. Exactly one of `result` / `errorMessage` is
 * meaningful:
 * - `result` set (errorMessage undefined) → resolve the pending request with it.
 * - `errorMessage` set → reject the pending request with `totalTimeMs` elapsed.
 */
export interface DecodedCtrlProxyMessage {
  requestId: string;
  result?: unknown;
  errorMessage?: string;
  runnerBusy?: boolean;
  runnerStalled?: boolean;
  totalTimeMs?: number;
  perfTiming?: CtrlProxyPerfTiming | CtrlProxyPerfTiming[];
}

/**
 * Rewrite the runner's terse "Unknown command type: X" error into an actionable
 * message pointing at the daemon/runner version skew. Non-matching errors pass
 * through unchanged.
 */
export function rewriteUnknownCommandError(error: string): string {
  return rewritePlatformUnknownCommandError(error, "ios");
}

function decodeHierarchyUpdate(
  message: WebSocketMessage,
  requestId: string,
): DecodedCtrlProxyMessage {
  // Swift CommandHandler failures use hierarchy_update without data. Updates
  // carrying a hierarchy retain their existing result shape, even with an error.
  if (!message.data && (message.success === false || message.error)) {
    return {
      requestId,
      errorMessage: rewriteUnknownCommandError(
        message.error || "iOS runner failed to produce a view hierarchy",
      ),
      ...(message.perfTiming ? { perfTiming: message.perfTiming } : {}),
      totalTimeMs: message.totalTimeMs ?? 0,
    };
  }
  return {
    requestId,
    result: {
      hierarchy: message.data,
      perfTiming: message.perfTiming,
      frameContext: message.frameContext,
      ...(message.servedFromCache === undefined
        ? {}
        : { servedFromCache: message.servedFromCache }),
    },
  };
}

/**
 * Decode a request/response message into the shape the request manager resolves.
 * Returns `null` for push messages (no `requestId`) — those are handled by the
 * client's push branches, not here.
 */
export function decodeCtrlProxyMessage(message: WebSocketMessage): DecodedCtrlProxyMessage | null {
  const { type, requestId } = message;
  if (!requestId) {
    return null;
  }
  if (message.error === "runner_busy") {
    return decodeRunnerBusy(message, requestId);
  }
  const phaseSummary =
    type === "swipe_result" ? gesturePhaseSummary(message.perfTiming) : undefined;
  if (type === "hierarchy_update") {
    return decodeHierarchyUpdate(message, requestId);
  }
  const decoder = typeof type === "string" ? messageDecoders.get(type) : undefined;
  if (typeof decoder === "function") {
    return { requestId, result: decoder(message, requestId, phaseSummary, type) };
  }
  if (message.error) {
    return {
      requestId,
      errorMessage: rewriteUnknownCommandError(message.error),
      ...(message.perfTiming ? { perfTiming: message.perfTiming } : {}),
      totalTimeMs: message.totalTimeMs ?? 0,
    };
  }
  return { requestId, result: message };
}

function decodeRunnerBusy(message: WebSocketMessage, requestId: string): DecodedCtrlProxyMessage {
  const blockingType =
    typeof message.blockingCommandType === "string" && message.blockingCommandType.length > 0
      ? message.blockingCommandType
      : "an unknown command";
  const elapsedMs = message.blockingElapsedMs;
  const elapsedDuration =
    typeof elapsedMs === "number" && Number.isFinite(elapsedMs) && elapsedMs >= 0
      ? `${(elapsedMs / 1000).toFixed(1)}s`
      : "an unknown duration";
  const remainingMs = message.blockingDeadlineRemainingMs;
  const runnerStalled = shouldRecoverBusyRunner(message);
  let deadlineDetail = "";
  if (typeof remainingMs === "number" && Number.isFinite(remainingMs)) {
    const deadlineStatus =
      remainingMs < 0
        ? `passed ${(-remainingMs / 1000).toFixed(1)}s ago`
        : `has ${(remainingMs / 1000).toFixed(1)}s remaining`;
    deadlineDetail = ` (its deadline ${deadlineStatus}; the gesture is a blocking XCUITest call the runner cannot interrupt)`;
  }
  return {
    requestId,
    runnerBusy: true,
    ...(runnerStalled ? { runnerStalled: true } : {}),
    errorMessage:
      `iOS runner is busy executing ${blockingType} for ${elapsedDuration}${deadlineDetail}; ` +
      (runnerStalled
        ? "bounded runner recovery is required. The blocking action's outcome is unknown; observe fresh state before deciding whether to repeat it"
        : "retry shortly"),
    totalTimeMs: message.totalTimeMs ?? 0,
  };
}

function shouldRecoverBusyRunner(message: WebSocketMessage): boolean {
  // These commands have 5s/10s host waits, but timing out does not cancel the
  // native call. Leave grace for completion and any explicit runner deadline.
  // Other commands (including potentially long text input) retain their policy.
  if (
    !["request_activate_accessibility_link", "request_launch_app"].includes(
      message.blockingCommandType ?? "",
    )
  ) {
    return false;
  }
  const elapsedMs = message.blockingElapsedMs;
  const remainingMs = message.blockingDeadlineRemainingMs;
  return (
    typeof elapsedMs === "number" &&
    Number.isFinite(elapsedMs) &&
    elapsedMs >= 30_000 &&
    (remainingMs === undefined ||
      (typeof remainingMs === "number" && Number.isFinite(remainingMs) && remainingMs <= 0))
  );
}

function decodeScreenshot(message: WebSocketMessage): unknown {
  return {
    // Successful ScreenshotResponse envelopes predate the shared success
    // field and omit it, while CommandHandler failures use the same
    // discriminator with success:false plus error. Preserve both shapes.
    success: message.success ?? true,
    data: message.data,
    format: message.format ?? "png",
    timestamp: message.timestamp,
    frameContext: message.frameContext,
    rotation: message.rotation,
    ...(message.error === undefined ? {} : { error: message.error }),
  };
}

function decodePinchResult(message: WebSocketMessage): unknown {
  // Carry the runner's pinchPath so PinchOn can warn when the center-less
  // public fallback was used instead of the center-honoring synthesis (#2910).
  return {
    success: message.success ?? (message.error === undefined || message.error === null),
    totalTimeMs: message.totalTimeMs ?? 0,
    error: message.error,
    perfTiming: message.perfTiming,
    pinchPath: message.pinchPath,
  };
}

function decodeGestureActionResult(
  message: WebSocketMessage,
  _requestId: string,
  phaseSummary: string | undefined,
  type: string,
): unknown {
  return {
    success: message.success ?? (message.error === undefined || message.error === null),
    totalTimeMs: message.totalTimeMs ?? 0,
    error: message.error && phaseSummary ? `${message.error}; ${phaseSummary}` : message.error,
    perfTiming: message.perfTiming,
    ...(message.errorCode === undefined ? {} : { errorCode: message.errorCode }),
    ...(type === "tap_coordinates_result" && message.tapDiagnostics !== undefined
      ? { tapDiagnostics: message.tapDiagnostics }
      : {}),
  };
}

function decodePressKeyResult(message: WebSocketMessage): unknown {
  return {
    success: message.success ?? (message.error === undefined || message.error === null),
    totalTimeMs: message.totalTimeMs ?? 0,
    error: message.error,
    verified: message.verified,
    warning: message.warning,
    perfTiming: message.perfTiming,
    ...(message.errorCode === undefined ? {} : { errorCode: message.errorCode }),
  };
}

function decodeKeyboardResult(message: WebSocketMessage): unknown {
  return {
    success: message.success ?? (message.error === undefined || message.error === null),
    open: message.open ?? false,
    method: message.method,
    totalTimeMs: message.totalTimeMs ?? 0,
    error: message.error,
    perfTiming: message.perfTiming,
  };
}

function decodeRotateResult(message: WebSocketMessage): unknown {
  return {
    success: message.success ?? (message.error === undefined || message.error === null),
    totalTimeMs: message.totalTimeMs ?? 0,
    error: message.error,
    perfTiming: message.perfTiming,
    previousOrientation: message.previousOrientation ?? "",
    currentOrientation: message.currentOrientation ?? "",
    value: message.value ?? 0,
    rotationPerformed: message.rotationPerformed ?? false,
  };
}

function decodeHingeAngleResult(message: WebSocketMessage): unknown {
  return {
    success: message.success ?? false,
    angle: message.angle,
    error: message.error,
    totalTimeMs: message.totalTimeMs ?? 0,
  };
}

function decodeImeActionResult(message: WebSocketMessage): unknown {
  return {
    success: message.success ?? (message.error === undefined || message.error === null),
    action: (message as { action?: string }).action,
    totalTimeMs: message.totalTimeMs ?? 0,
    error: message.error,
    // action_result carries the semantic-link owner-ambiguity note here (#10082).
    warning: message.warning,
    perfTiming: message.perfTiming,
  };
}

function decodeVoiceoverStateResult(message: WebSocketMessage): unknown {
  return {
    success: message.success ?? true,
    enabled: (message as { enabled?: boolean }).enabled ?? false,
    totalTimeMs: message.totalTimeMs ?? 0,
    error: message.error,
  };
}

function decodeVoiceoverSetResult(message: WebSocketMessage): unknown {
  // The runner deliberately returns success:false with an error (e.g. the
  // Settings VoiceOver row could not be located) rather than throwing, so it
  // must RESOLVE as a typed CtrlProxyActionResult — VoiceOverToggle maps
  // success:false to supported:false, never a silent success (#2501).
  return {
    success: message.success ?? false,
    totalTimeMs: message.totalTimeMs ?? 0,
    error: message.error,
  };
}

function decodeHighlightResponse(message: WebSocketMessage, requestId: string): unknown {
  return {
    success: message.success ?? false,
    totalTimeMs: message.totalTimeMs ?? 0,
    error: message.error,
    requestId,
    timestamp: message.timestamp,
  };
}

function decodeMultiFingerSwipeResult(message: WebSocketMessage): unknown {
  return {
    success: message.success ?? (message.error === undefined || message.error === null),
    totalTimeMs: message.totalTimeMs ?? 0,
    error: message.error,
    perfTiming: message.perfTiming,
  };
}

function decodeClipboardResult(message: WebSocketMessage): unknown {
  return {
    success: message.success ?? (message.error === undefined || message.error === null),
    action: (message as { action?: string }).action ?? "",
    text: (message as { text?: string }).text,
    totalTimeMs: message.totalTimeMs ?? 0,
    error: message.error,
  };
}

function decodePreferenceFiles(message: WebSocketMessage): unknown {
  return {
    success: message.success ?? false,
    files: (message as { files?: unknown[] }).files || [],
    totalTimeMs: message.totalTimeMs ?? 0,
    error: message.error,
  };
}

function decodePreferences(message: WebSocketMessage): unknown {
  const entries =
    (
      message as {
        entries?: Array<Omit<KeyValueEntry, "redacted"> & { redacted?: unknown }>;
      }
    ).entries || [];
  return {
    success: message.success ?? false,
    entries: entries.map(({ redacted, ...entry }): KeyValueEntry => ({
      ...entry,
      ...(redacted === true ? { redacted: true } : {}),
    })),
    totalTimeMs: message.totalTimeMs ?? 0,
    error: message.error,
  };
}

function decodeGetPreferenceResult(message: WebSocketMessage): unknown {
  const msg = message as {
    found?: boolean;
    key?: string;
    value?: string;
    valueType?: string;
    redacted?: true;
  };
  const entry =
    msg.found && msg.key
      ? {
          key: msg.key,
          value: msg.value ?? null,
          type: msg.valueType ?? "UNKNOWN",
          ...(msg.redacted === true ? { redacted: true } : {}),
        }
      : undefined;
  return {
    success: message.success ?? false,
    found: msg.found ?? false,
    entry,
    totalTimeMs: message.totalTimeMs ?? 0,
    error: message.error,
  };
}

function decodeSetPreferenceResult(message: WebSocketMessage): unknown {
  const msg = message as { resolvedStore?: unknown; effectiveValueDiffers?: unknown };
  return {
    success: message.success ?? message.ok ?? false,
    totalTimeMs: message.totalTimeMs ?? 0,
    error: message.error,
    ...(typeof msg.resolvedStore === "string" ? { resolvedStore: msg.resolvedStore } : {}),
    ...(typeof msg.effectiveValueDiffers === "boolean"
      ? { effectiveValueDiffers: msg.effectiveValueDiffers }
      : {}),
  };
}

function decodeSetNetworkFaultRulesResult(message: WebSocketMessage): unknown {
  return {
    success: message.success ?? message.ok ?? false,
    totalTimeMs: message.totalTimeMs ?? 0,
    error: message.error,
  };
}

/**
 * `rejectedMockIds` is passed through only when the runner sent it: its absence means the runner
 * (or the app SDK behind it) did not report, which the host must not read as "none rejected".
 */
function decodeSetNetworkMockRulesResult(message: WebSocketMessage): unknown {
  const msg = message as { rejectedMockIds?: unknown; rejectedReasons?: unknown };
  return {
    success: message.success ?? message.ok ?? false,
    totalTimeMs: message.totalTimeMs ?? 0,
    error: message.error,
    ...(Array.isArray(msg.rejectedMockIds) ? { rejectedMockIds: msg.rejectedMockIds } : {}),
    ...(typeof msg.rejectedReasons === "object" && msg.rejectedReasons !== null
      ? { rejectedReasons: msg.rejectedReasons }
      : {}),
  };
}

function decodeExecuteSqlResult(message: WebSocketMessage): unknown {
  return {
    success: message.success ?? false,
    queryType: (message as { queryType?: string }).queryType,
    columns: (message as { columns?: string[] }).columns,
    rows: (message as { rows?: unknown[][] }).rows,
    rowsAffected: (message as { rowsAffected?: number }).rowsAffected,
    diagnostic: (message as { diagnostic?: unknown }).diagnostic,
    truncated: (message as { truncated?: boolean }).truncated,
    totalTimeMs: message.totalTimeMs ?? 0,
    error: message.error,
  };
}

function decodeListDatabasesResult(message: WebSocketMessage): unknown {
  return {
    success: message.success ?? false,
    databases: (message as { databases?: unknown[] }).databases ?? [],
    totalTimeMs: message.totalTimeMs ?? 0,
    error: message.error,
  };
}

function decodeStorageCapabilitiesResult(message: WebSocketMessage): unknown {
  return {
    success: message.success ?? false,
    capabilities: (message as { capabilities?: unknown }).capabilities,
    totalTimeMs: message.totalTimeMs ?? 0,
    error: message.error,
  };
}

function decodeListTablesResult(message: WebSocketMessage): unknown {
  return {
    success: message.success ?? false,
    tables: (message as { tables?: string[] }).tables ?? [],
    totalTimeMs: message.totalTimeMs ?? 0,
    error: message.error,
  };
}

function decodeTableDataResult(message: WebSocketMessage): unknown {
  return {
    success: message.success ?? false,
    columns: (message as { columns?: string[] }).columns ?? [],
    rows: (message as { rows?: unknown[][] }).rows ?? [],
    total: (message as { total?: number }).total ?? 0,
    diagnostic: (message as { diagnostic?: unknown }).diagnostic,
    totalTimeMs: message.totalTimeMs ?? 0,
    error: message.error,
  };
}

function decodeTableStructureResult(message: WebSocketMessage): unknown {
  return {
    success: message.success ?? false,
    columns: (message as { columns?: unknown[] }).columns ?? [],
    diagnostic: (message as { diagnostic?: unknown }).diagnostic,
    totalTimeMs: message.totalTimeMs ?? 0,
    error: message.error,
  };
}

function decodeSdkCapabilitiesResult(message: WebSocketMessage): unknown {
  // Foreground-app-scoped SDK availability (#6832). `available: false` is a
  // legitimate success reply — the foreground app simply embeds no SDK — so
  // availability is defaulted independently of `success`.
  return {
    success: message.success ?? false,
    available: message.available ?? false,
    bundleId: message.bundleId,
    capabilities: message.capabilities ?? [],
    totalTimeMs: message.totalTimeMs ?? 0,
    error: message.error,
  };
}

const messageDecoders = new Map<
  string,
  (
    message: WebSocketMessage,
    requestId: string,
    phaseSummary: string | undefined,
    type: string,
  ) => unknown
>([
  ["screenshot", decodeScreenshot],
  ["pinch_result", decodePinchResult],
  ["tap_coordinates_result", decodeGestureActionResult],
  ["swipe_result", decodeGestureActionResult],
  ["drag_result", decodeGestureActionResult],
  ["set_text_result", decodeGestureActionResult],
  ["append_text_result", decodeGestureActionResult],
  ["clear_text_result", decodeGestureActionResult],
  ["select_all_result", decodeGestureActionResult],
  ["press_button_result", decodeGestureActionResult],
  ["press_home_result", decodeGestureActionResult],
  ["press_back_result", decodeGestureActionResult],
  ["recent_apps_result", decodeGestureActionResult],
  ["launch_app_result", decodeGestureActionResult],
  ["reset_permissions_result", decodeGestureActionResult],
  ["press_key_result", decodePressKeyResult],
  ["keyboard_result", decodeKeyboardResult],
  ["rotate_result", decodeRotateResult],
  ["hinge_angle_result", decodeHingeAngleResult],
  ["ime_action_result", decodeImeActionResult],
  ["action_result", decodeImeActionResult],
  [
    "magic_tap_result",
    (message) => ({
      success: message.success ?? false,
      available: message.available ?? false,
      handled: message.handled,
      unsupported: message.unsupported ?? false,
      requiresVoiceOver: false,
      error: message.error,
      totalTimeMs: message.totalTimeMs ?? 0,
    }),
  ],
  [
    "sdk_trigger_result",
    (message) => ({
      success: message.success ?? false,
      available: message.available ?? false,
      statusCode: message.statusCode,
      sdkError: message.sdkError,
      reason: message.reason,
      registeredModules: message.registeredModules,
      supportedTriggers: message.supportedTriggers,
      error: message.error,
      totalTimeMs: message.totalTimeMs ?? 0,
    }),
  ],
  ["voiceover_state_result", decodeVoiceoverStateResult],
  ["voiceover_set_result", decodeVoiceoverSetResult],
  ["highlight_response", decodeHighlightResponse],
  ["multi_finger_swipe_result", decodeMultiFingerSwipeResult],
  ["clipboard_result", decodeClipboardResult],
  ["preference_files", decodePreferenceFiles],
  ["preferences", decodePreferences],
  ["get_preference_result", decodeGetPreferenceResult],
  ["set_preference_result", decodeSetPreferenceResult],
  ["remove_preference_result", decodeSetPreferenceResult],
  ["clear_preferences_result", decodeSetPreferenceResult],
  ["set_network_mock_rules_result", decodeSetNetworkMockRulesResult],
  ["set_network_fault_rules_result", decodeSetNetworkFaultRulesResult],
  ["set_network_error_simulation_result", decodeSetNetworkFaultRulesResult],
  ["execute_sql_result", decodeExecuteSqlResult],
  ["list_databases_result", decodeListDatabasesResult],
  ["storage_capabilities_result", decodeStorageCapabilitiesResult],
  ["list_tables_result", decodeListTablesResult],
  ["table_data_result", decodeTableDataResult],
  ["table_structure_result", decodeTableStructureResult],
  ["sdk_capabilities_result", decodeSdkCapabilitiesResult],
]);

/** Summarize only runner-owned gesture children; old runners simply have none. */
export function gesturePhaseSummary(
  timing?: CtrlProxyPerfTiming | CtrlProxyPerfTiming[],
): string | undefined {
  if (!timing) {
    return undefined;
  }
  const entries = Array.isArray(timing) ? timing : [timing];
  for (const entry of entries) {
    if (entry.name === "gesturePhases") {
      return `gesture_phases ${(entry.children ?? []).map((phase) => `${phase.name}Ms=${phase.durationMs}`).join(" ")} totalMs=${entry.durationMs}`;
    }
    const nested = gesturePhaseSummary(entry.children);
    if (nested) {
      return nested;
    }
  }
  return undefined;
}
