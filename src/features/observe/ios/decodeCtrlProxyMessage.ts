/**
 * decodeCtrlProxyMessage - pure wire-protocol decoding for the iOS CtrlProxy.
 *
 * This module owns the request/response reshaping that maps the ~30 wire message
 * types the runner emits into the result objects the request manager resolves.
 * It is intentionally free of client/connection state so it can be unit-tested in
 * isolation; `IOSCtrlProxyClient.processMessage` is a thin adapter over it.
 */

import type { WebSocketMessage } from "./types";
import { rewriteUnknownCommandError as rewritePlatformUnknownCommandError } from "../shared/rewriteUnknownCommandError";

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
  totalTimeMs?: number;
}

/**
 * Rewrite the runner's terse "Unknown command type: X" error into an actionable
 * message pointing at the daemon/runner version skew. Non-matching errors pass
 * through unchanged.
 */
export function rewriteUnknownCommandError(error: string): string {
  return rewritePlatformUnknownCommandError(error, "ios");
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

  let result: unknown;

  switch (type) {
    case "hierarchy_update":
      result = {
        hierarchy: message.data,
        perfTiming: message.perfTiming,
        frameContext: message.frameContext,
      };
      break;

    case "screenshot":
      result = {
        success: true,
        data: message.data,
        format: message.format ?? "png",
        timestamp: message.timestamp,
        frameContext: message.frameContext,
        rotation: message.rotation,
      };
      break;

    case "pinch_result":
      // Carry the runner's pinchPath so PinchOn can warn when the center-less
      // public fallback was used instead of the center-honoring synthesis (#2910).
      result = {
        success: message.success ?? true,
        totalTimeMs: message.totalTimeMs ?? 0,
        error: message.error,
        perfTiming: message.perfTiming,
        pinchPath: message.pinchPath,
      };
      break;

    case "tap_coordinates_result":
    case "swipe_result":
    case "drag_result":
    case "set_text_result":
    case "append_text_result":
    case "clear_text_result":
    case "select_all_result":
    case "press_button_result":
    case "press_home_result":
    case "press_back_result":
    case "recent_apps_result":
    case "launch_app_result":
    case "reset_permissions_result":
      result = {
        success: message.success ?? true,
        totalTimeMs: message.totalTimeMs ?? 0,
        error: message.error,
        perfTiming: message.perfTiming,
      };
      break;

    case "keyboard_result":
      result = {
        success: message.success ?? true,
        open: message.open ?? false,
        totalTimeMs: message.totalTimeMs ?? 0,
        error: message.error,
        perfTiming: message.perfTiming,
      };
      break;

    case "rotate_result":
      result = {
        success: message.success ?? true,
        totalTimeMs: message.totalTimeMs ?? 0,
        error: message.error,
        perfTiming: message.perfTiming,
        previousOrientation: message.previousOrientation ?? "",
        currentOrientation: message.currentOrientation ?? "",
        value: message.value ?? 0,
        rotationPerformed: message.rotationPerformed ?? false,
      };
      break;

    case "ime_action_result":
    case "action_result":
      result = {
        success: message.success ?? true,
        action: (message as { action?: string }).action,
        totalTimeMs: message.totalTimeMs ?? 0,
        error: message.error,
        perfTiming: message.perfTiming,
      };
      break;

    case "voiceover_state_result":
      result = {
        success: message.success ?? true,
        enabled: (message as { enabled?: boolean }).enabled ?? false,
        totalTimeMs: message.totalTimeMs ?? 0,
        error: message.error,
      };
      break;

    case "voiceover_set_result":
      // The runner deliberately returns success:false with an error (e.g. the
      // Settings VoiceOver row could not be located) rather than throwing, so it
      // must RESOLVE as a typed CtrlProxyActionResult — VoiceOverToggle maps
      // success:false to supported:false, never a silent success (#2501).
      result = {
        success: message.success ?? false,
        totalTimeMs: message.totalTimeMs ?? 0,
        error: message.error,
      };
      break;

    case "highlight_response":
      result = {
        success: message.success ?? false,
        totalTimeMs: message.totalTimeMs ?? 0,
        error: message.error,
        requestId,
        timestamp: message.timestamp,
      };
      break;

    case "multi_finger_swipe_result":
      result = {
        success: message.success ?? true,
        totalTimeMs: message.totalTimeMs ?? 0,
        error: message.error,
        perfTiming: message.perfTiming,
      };
      break;

    case "clipboard_result":
      result = {
        success: message.success ?? true,
        action: (message as { action?: string }).action ?? "",
        text: (message as { text?: string }).text,
        totalTimeMs: message.totalTimeMs ?? 0,
        error: message.error,
      };
      break;

    // Storage response types (matching Android wire protocol)
    case "preference_files":
      result = {
        success: message.success ?? false,
        files: (message as { files?: unknown[] }).files || [],
        totalTimeMs: message.totalTimeMs ?? 0,
        error: message.error,
      };
      break;

    case "preferences":
      result = {
        success: message.success ?? false,
        entries: (message as { entries?: unknown[] }).entries || [],
        totalTimeMs: message.totalTimeMs ?? 0,
        error: message.error,
      };
      break;

    case "get_preference_result": {
      const msg = message as { found?: boolean; key?: string; value?: string; valueType?: string };
      const entry = msg.found && msg.key ? {
        key: msg.key,
        value: msg.value ?? null,
        type: msg.valueType ?? "UNKNOWN",
      } : undefined;
      result = {
        success: message.success ?? false,
        found: msg.found ?? false,
        entry,
        totalTimeMs: message.totalTimeMs ?? 0,
        error: message.error,
      };
      break;
    }

    case "set_preference_result":
    case "remove_preference_result":
    case "clear_preferences_result":
    case "set_network_fault_rules_result":
    case "set_network_error_simulation_result":
      result = {
        success: message.success ?? message.ok ?? false,
        totalTimeMs: message.totalTimeMs ?? 0,
        error: message.error,
      };
      break;

    case "execute_sql_result":
      result = {
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
      break;

    case "list_databases_result":
      result = {
        success: message.success ?? false,
        databases: (message as { databases?: unknown[] }).databases ?? [],
        totalTimeMs: message.totalTimeMs ?? 0,
        error: message.error,
      };
      break;

    case "storage_capabilities_result":
      result = {
        success: message.success ?? false,
        capabilities: (message as { capabilities?: unknown }).capabilities,
        totalTimeMs: message.totalTimeMs ?? 0,
        error: message.error,
      };
      break;

    case "list_tables_result":
      result = {
        success: message.success ?? false,
        tables: (message as { tables?: string[] }).tables ?? [],
        totalTimeMs: message.totalTimeMs ?? 0,
        error: message.error,
      };
      break;

    case "table_data_result":
      result = {
        success: message.success ?? false,
        columns: (message as { columns?: string[] }).columns ?? [],
        rows: (message as { rows?: unknown[][] }).rows ?? [],
        total: (message as { total?: number }).total ?? 0,
        diagnostic: (message as { diagnostic?: unknown }).diagnostic,
        totalTimeMs: message.totalTimeMs ?? 0,
        error: message.error,
      };
      break;

    case "table_structure_result":
      result = {
        success: message.success ?? false,
        columns: (message as { columns?: unknown[] }).columns ?? [],
        diagnostic: (message as { diagnostic?: unknown }).diagnostic,
        totalTimeMs: message.totalTimeMs ?? 0,
        error: message.error,
      };
      break;

    default:
      // Unrecognized message type carrying an error → reject the request with the
      // rewritten error. Otherwise (unknown type, no error) resolve verbatim with the
      // raw wire message, so a newer runner reply the daemon doesn't model yet still
      // reaches its awaiter unchanged.
      if (message.error) {
        return {
          requestId,
          errorMessage: rewriteUnknownCommandError(message.error),
          totalTimeMs: message.totalTimeMs ?? 0,
        };
      }
      result = message;
  }

  return { requestId, result };
}
