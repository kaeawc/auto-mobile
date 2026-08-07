import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  decodeCtrlProxyMessage,
  rewriteUnknownCommandError,
} from "../../../../src/features/observe/ios/decodeCtrlProxyMessage";
import type { WebSocketMessage } from "../../../../src/features/observe/ios/types";

const REQ = "req-1";

/** Helper to build a WebSocketMessage with a requestId. */
const msg = (partial: Partial<WebSocketMessage> & { type: string }): WebSocketMessage => ({
  requestId: REQ,
  ...partial,
});

describe("decodeCtrlProxyMessage", () => {
  test("returns null for a push message with no requestId", () => {
    expect(decodeCtrlProxyMessage({ type: "hierarchy_update" })).toBeNull();
    expect(decodeCtrlProxyMessage({ type: "performance_update" })).toBeNull();
    expect(decodeCtrlProxyMessage({ type: "connected" })).toBeNull();
  });

  test("hierarchy_update returns hierarchy + perfTiming", () => {
    const data = { hierarchy: {}, packageName: "com.x", updatedAt: 1 } as never;
    const perfTiming = { totalMs: 5 } as never;
    const decoded = decodeCtrlProxyMessage(msg({ type: "hierarchy_update", data, perfTiming }));
    expect(decoded).toEqual({ requestId: REQ, result: { hierarchy: data, perfTiming } });
  });

  test("screenshot forwards capture-time rotation", () => {
    const decoded = decodeCtrlProxyMessage(msg({ type: "screenshot", data: "b64" as never, timestamp: 9, rotation: 1 }));
    expect(decoded).toEqual({
      requestId: REQ,
      result: { success: true, data: "b64", format: "png", timestamp: 9, rotation: 1 },
    });
  });

  test("screenshot preserves explicit format", () => {
    const decoded = decodeCtrlProxyMessage(msg({ type: "screenshot", data: "b64" as never, format: "jpeg" }));
    expect((decoded?.result as { format: string }).format).toBe("jpeg");
  });

  const baseResultTypes = [
    "tap_coordinates_result",
    "swipe_result",
    "drag_result",
    "set_text_result",
    "append_text_result",
    "clear_text_result",
    "select_all_result",
    "press_button_result",
    "press_home_result",
    "press_back_result",
    "recent_apps_result",
    "launch_app_result",
    "reset_permissions_result",
    "multi_finger_swipe_result",
  ];

  for (const type of baseResultTypes) {
    test(`${type} maps to base timing result with success default true`, () => {
      const perfTiming = { totalMs: 3 } as never;
      const decoded = decodeCtrlProxyMessage(msg({ type, totalTimeMs: 12, perfTiming }));
      expect(decoded).toEqual({
        requestId: REQ,
        result: { success: true, totalTimeMs: 12, error: undefined, perfTiming },
      });
    });
  }

  test("pinch_result carries element-anchored pinchPath through (#2910)", () => {
    const decoded = decodeCtrlProxyMessage(
      msg({ type: "pinch_result", totalTimeMs: 7, pinchPath: "element-anchored" })
    );
    expect(decoded).toEqual({
      requestId: REQ,
      result: {
        success: true,
        totalTimeMs: 7,
        error: undefined,
        perfTiming: undefined,
        pinchPath: "element-anchored",
      },
    });
  });

  test("pinch_result pinchPath is undefined when the runner omits it", () => {
    const decoded = decodeCtrlProxyMessage(msg({ type: "pinch_result", totalTimeMs: 5 }));
    expect((decoded?.result as { pinchPath?: string }).pinchPath).toBeUndefined();
  });

  test("base result respects explicit success=false and totalTimeMs default", () => {
    const decoded = decodeCtrlProxyMessage(msg({ type: "swipe_result", success: false, error: "boom" }));
    expect(decoded?.result).toEqual({ success: false, totalTimeMs: 0, error: "boom", perfTiming: undefined });
  });

  test("keyboard_result includes open flag", () => {
    const decoded = decodeCtrlProxyMessage(msg({ type: "keyboard_result", open: true, totalTimeMs: 4 }));
    expect(decoded?.result).toEqual({
      success: true,
      open: true,
      totalTimeMs: 4,
      error: undefined,
      perfTiming: undefined,
    });
  });

  test("keyboard_result open defaults to false", () => {
    const decoded = decodeCtrlProxyMessage(msg({ type: "keyboard_result" }));
    expect((decoded?.result as { open: boolean }).open).toBe(false);
  });

  test("rotate_result carries orientation fields", () => {
    const decoded = decodeCtrlProxyMessage(msg({
      type: "rotate_result",
      previousOrientation: "portrait",
      currentOrientation: "landscape",
      value: 90,
      rotationPerformed: true,
      totalTimeMs: 7,
    }));
    expect(decoded?.result).toEqual({
      success: true,
      totalTimeMs: 7,
      error: undefined,
      perfTiming: undefined,
      previousOrientation: "portrait",
      currentOrientation: "landscape",
      value: 90,
      rotationPerformed: true,
    });
  });

  test("rotate_result defaults orientation fields", () => {
    const decoded = decodeCtrlProxyMessage(msg({ type: "rotate_result" }));
    expect(decoded?.result).toEqual({
      success: true,
      totalTimeMs: 0,
      error: undefined,
      perfTiming: undefined,
      previousOrientation: "",
      currentOrientation: "",
      value: 0,
      rotationPerformed: false,
    });
  });

  for (const type of ["ime_action_result", "action_result"]) {
    test(`${type} includes action field`, () => {
      const decoded = decodeCtrlProxyMessage(msg({ type, action: "done" } as never));
      expect(decoded?.result).toEqual({
        success: true,
        action: "done",
        totalTimeMs: 0,
        error: undefined,
        perfTiming: undefined,
      });
    });
  }

  test("voiceover_state_result includes enabled", () => {
    const decoded = decodeCtrlProxyMessage(msg({ type: "voiceover_state_result", enabled: true } as never));
    expect(decoded?.result).toEqual({ success: true, enabled: true, totalTimeMs: 0, error: undefined });
  });

  test("voiceover_state_result enabled defaults false", () => {
    const decoded = decodeCtrlProxyMessage(msg({ type: "voiceover_state_result" }));
    expect((decoded?.result as { enabled: boolean }).enabled).toBe(false);
  });


  test("highlight_response defaults success to false and echoes requestId/timestamp", () => {
    const decoded = decodeCtrlProxyMessage(msg({ type: "highlight_response", timestamp: 42 }));
    expect(decoded?.result).toEqual({
      success: false,
      totalTimeMs: 0,
      error: undefined,
      requestId: REQ,
      timestamp: 42,
    });
  });

  test("clipboard_result carries action and text", () => {
    const decoded = decodeCtrlProxyMessage(msg({ type: "clipboard_result", action: "get", text: "hi" } as never));
    expect(decoded?.result).toEqual({
      success: true,
      action: "get",
      text: "hi",
      totalTimeMs: 0,
      error: undefined,
    });
  });

  test("clipboard_result action defaults to empty string", () => {
    const decoded = decodeCtrlProxyMessage(msg({ type: "clipboard_result" }));
    expect((decoded?.result as { action: string }).action).toBe("");
  });

  test("preference_files defaults files to empty array and success false", () => {
    const decoded = decodeCtrlProxyMessage(msg({ type: "preference_files" }));
    expect(decoded?.result).toEqual({ success: false, files: [], totalTimeMs: 0, error: undefined });
  });

  test("preference_files preserves files", () => {
    const files = [{ name: "a" }];
    const decoded = decodeCtrlProxyMessage(msg({ type: "preference_files", files } as never));
    expect((decoded?.result as { files: unknown[] }).files).toEqual(files);
  });

  test("preferences defaults entries to empty array", () => {
    const decoded = decodeCtrlProxyMessage(msg({ type: "preferences" }));
    expect(decoded?.result).toEqual({ success: false, entries: [], totalTimeMs: 0, error: undefined });
  });

  test("get_preference_result builds entry when found", () => {
    const decoded = decodeCtrlProxyMessage(msg({
      type: "get_preference_result",
      found: true,
      key: "k",
      value: "v",
      valueType: "STRING",
    } as never));
    expect(decoded?.result).toEqual({
      success: false,
      found: true,
      entry: { key: "k", value: "v", type: "STRING" },
      totalTimeMs: 0,
      error: undefined,
    });
  });

  test("get_preference_result entry undefined when not found", () => {
    const decoded = decodeCtrlProxyMessage(msg({ type: "get_preference_result", found: false } as never));
    expect((decoded?.result as { entry: unknown }).entry).toBeUndefined();
  });

  test("get_preference_result defaults value to null and type to UNKNOWN", () => {
    const decoded = decodeCtrlProxyMessage(msg({ type: "get_preference_result", found: true, key: "k" } as never));
    expect((decoded?.result as { entry: unknown }).entry).toEqual({ key: "k", value: null, type: "UNKNOWN" });
  });

  for (const type of ["set_preference_result", "remove_preference_result", "clear_preferences_result"]) {
    test(`${type} returns bare success result`, () => {
      const decoded = decodeCtrlProxyMessage(msg({ type }));
      expect(decoded?.result).toEqual({ success: false, totalTimeMs: 0, error: undefined });
    });
  }

  test("set_network_error_simulation_result maps ok to success", () => {
    const decoded = decodeCtrlProxyMessage(msg({
      type: "set_network_error_simulation_result",
      ok: true,
      totalTimeMs: 7,
    }));

    expect(decoded?.result).toEqual({
      success: true,
      totalTimeMs: 7,
      error: undefined,
    });
  });

  test("execute_sql_result carries query fields", () => {
    const decoded = decodeCtrlProxyMessage(msg({
      type: "execute_sql_result",
      queryType: "SELECT",
      columns: ["id"],
      rows: [[1]],
      rowsAffected: 0,
      totalTimeMs: 2,
    } as never));
    expect(decoded?.result).toEqual({
      success: false,
      queryType: "SELECT",
      columns: ["id"],
      rows: [[1]],
      rowsAffected: 0,
      totalTimeMs: 2,
      error: undefined,
    });
  });

  test("list_databases_result defaults databases to empty array", () => {
    const decoded = decodeCtrlProxyMessage(msg({ type: "list_databases_result" }));
    expect(decoded?.result).toEqual({ success: false, databases: [], totalTimeMs: 0, error: undefined });
  });

  test("list_tables_result defaults tables to empty array", () => {
    const decoded = decodeCtrlProxyMessage(msg({ type: "list_tables_result" }));
    expect(decoded?.result).toEqual({ success: false, tables: [], totalTimeMs: 0, error: undefined });
  });

  test("table_data_result defaults columns/rows/total", () => {
    const decoded = decodeCtrlProxyMessage(msg({ type: "table_data_result" }));
    expect(decoded?.result).toEqual({
      success: false,
      columns: [],
      rows: [],
      total: 0,
      totalTimeMs: 0,
      error: undefined,
    });
  });

  test("table_structure_result defaults columns", () => {
    const decoded = decodeCtrlProxyMessage(msg({ type: "table_structure_result" }));
    expect(decoded?.result).toEqual({ success: false, columns: [], totalTimeMs: 0, error: undefined });
  });

  test("unknown type with an error resolves as a rewritten error", () => {
    const decoded = decodeCtrlProxyMessage(msg({
      type: "mystery",
      error: "Unknown command type: request_teleport",
      totalTimeMs: 3,
    }));
    expect(decoded?.requestId).toBe(REQ);
    expect(decoded?.result).toBeUndefined();
    expect(decoded?.totalTimeMs).toBe(3);
    expect(decoded?.errorMessage).toContain("request_teleport");
    expect(decoded?.errorMessage).toContain("older than this daemon");
  });

  test("unknown type error totalTimeMs defaults to 0", () => {
    const decoded = decodeCtrlProxyMessage(msg({ type: "mystery", error: "some failure" }));
    expect(decoded?.errorMessage).toBe("some failure");
    expect(decoded?.totalTimeMs).toBe(0);
  });

  test("unknown type without an error returns the raw message as result", () => {
    const message = msg({ type: "mystery", value: 7 });
    const decoded = decodeCtrlProxyMessage(message);
    expect(decoded?.errorMessage).toBeUndefined();
    expect(decoded?.result).toBe(message);
  });
});

/**
 * Parse every `case` rawValue from the Swift `ResponseType: String` enum.
 *
 * Swift String-enum semantics: a case without an explicit `= "..."` uses the
 * case name itself as its rawValue (e.g. `case screenshot` → "screenshot"), so
 * we fall back to the identifier when no string literal is present.
 */
function parseSwiftResponseTypeRawValues(swiftSource: string): string[] {
  const lines = swiftSource.split("\n");
  const startIdx = lines.findIndex(line => /enum\s+ResponseType\s*:\s*String\s*\{/.test(line));
  if (startIdx < 0) {
    throw new Error("Could not locate `enum ResponseType: String` in Models.swift");
  }
  const rawValues: string[] = [];
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "}") {
      break; // end of the (brace-flat) enum body
    }
    const match = line.match(/^\s*case\s+([A-Za-z0-9_]+)(?:\s*=\s*"([^"]+)")?/);
    if (match) {
      rawValues.push(match[2] ?? match[1]);
    }
  }
  return rawValues;
}

/**
 * A rawValue is "explicitly decoded" when the switch has a dedicated case that
 * reshapes it into a fresh result object. The default branch, by contrast,
 * resolves the message verbatim (`result === message` by identity), so identity
 * equality is a precise, source-parsing-free probe for the default fall-through.
 */
function isExplicitlyDecoded(rawValue: string): boolean {
  const message = { type: rawValue, requestId: REQ } as WebSocketMessage;
  const decoded = decodeCtrlProxyMessage(message);
  return decoded !== null && decoded.result !== message;
}

describe("decodeCtrlProxyMessage ↔ Swift ResponseType parity (ADD-3 / item 4)", () => {
  const swiftSource = readFileSync(
    join(import.meta.dir, "../../../../ios/control-proxy/Sources/CtrlProxy/Models.swift"),
    "utf8"
  );
  const rawValues = parseSwiftResponseTypeRawValues(swiftSource);

  // Response types the daemon deliberately does NOT reshape: they reach the
  // decoder's default verbatim-resolve branch on purpose because no client
  // await path consumes them (fire-and-forget push/ack replies). Documented
  // here — per the spec we do not assert on their absence from the switch,
  // only subtract them so the genuinely-unhandled residue is isolated.
  //   1. set_hierarchy_poll_interval_result — poll-interval ack
  //   2. screenshot_error                   — error push, handled client-side
  //   3. current_focus_result               — focus push, no awaiter
  //   4. traversal_order_result             — traversal push, no awaiter
  //   5. connected                          — connection handshake push
  //   6. set_network_mock_rules_result      — mock-rules ack
  const FIRE_AND_FORGET_EXCUSES = [
    "set_hierarchy_poll_interval_result",
    "screenshot_error",
    "current_focus_result",
    "traversal_order_result",
    "connected",
    "set_network_mock_rules_result",
  ];

  test("Swift ResponseType declares exactly 44 rawValues", () => {
    expect(rawValues.length).toBe(44);
  });

  test("rawValues are unique (no accidental duplicate)", () => {
    expect(new Set(rawValues).size).toBe(rawValues.length);
  });

  test("every fire-and-forget excuse is a real Swift rawValue", () => {
    for (const excuse of FIRE_AND_FORGET_EXCUSES) {
      expect(rawValues).toContain(excuse);
    }
  });

  test("the decoder explicitly reshapes exactly 37 response types", () => {
    expect(rawValues.filter(isExplicitlyDecoded).length).toBe(37);
  });

  test("the only unhandled ResponseType (excluding fire-and-forget) is shake_result", () => {
    const unhandled = rawValues
      .filter(rawValue => !isExplicitlyDecoded(rawValue))
      .filter(rawValue => !FIRE_AND_FORGET_EXCUSES.includes(rawValue))
      .sort();
    expect(unhandled).toEqual(["shake_result"]);
  });
});

/**
 * PARAM-5 / item 11: per-type `success` defaulting.
 *
 * The decoder defaults `success` differently per response type: base-timing and
 * gesture results default to `true` (a reply that arrived without an explicit
 * failure flag is treated as success), while storage/database/highlight results
 * default to `false` (absence of an explicit success is treated as failure).
 * `screenshot` hardcodes `true`, and `hierarchy_update` carries no `success`.
 */
describe("decodeCtrlProxyMessage success defaulting (PARAM-5 / item 11)", () => {
  // One row per decoded response type → the value of `success` when the wire
  // message omits it. 37 rows = the 37 explicitly-decoded ResponseTypes.
  const DEFAULT_WHEN_ABSENT: Array<{ type: string; expected: boolean | undefined }> = [
    { type: "hierarchy_update", expected: undefined },
    { type: "screenshot", expected: true },
    { type: "pinch_result", expected: true },
    { type: "tap_coordinates_result", expected: true },
    { type: "swipe_result", expected: true },
    { type: "drag_result", expected: true },
    { type: "set_text_result", expected: true },
    { type: "append_text_result", expected: true },
    { type: "clear_text_result", expected: true },
    { type: "select_all_result", expected: true },
    { type: "press_button_result", expected: true },
    { type: "press_home_result", expected: true },
    { type: "press_back_result", expected: true },
    { type: "recent_apps_result", expected: true },
    { type: "launch_app_result", expected: true },
    { type: "reset_permissions_result", expected: true },
    { type: "keyboard_result", expected: true },
    { type: "rotate_result", expected: true },
    { type: "ime_action_result", expected: true },
    { type: "action_result", expected: true },
    { type: "voiceover_state_result", expected: true },
    { type: "multi_finger_swipe_result", expected: true },
    { type: "clipboard_result", expected: true },
    { type: "highlight_response", expected: false },
    { type: "preference_files", expected: false },
    { type: "preferences", expected: false },
    { type: "get_preference_result", expected: false },
    { type: "set_preference_result", expected: false },
    { type: "remove_preference_result", expected: false },
    { type: "clear_preferences_result", expected: false },
    { type: "set_network_error_simulation_result", expected: false },
    { type: "execute_sql_result", expected: false },
    { type: "list_databases_result", expected: false },
    { type: "storage_capabilities_result", expected: false },
    { type: "list_tables_result", expected: false },
    { type: "table_data_result", expected: false },
    { type: "table_structure_result", expected: false },
  ];

  test("the default table covers all 37 explicitly-decoded types", () => {
    expect(DEFAULT_WHEN_ABSENT.length).toBe(37);
  });

  for (const { type, expected } of DEFAULT_WHEN_ABSENT) {
    test(`${type} defaults success to ${String(expected)} when the wire omits it`, () => {
      const decoded = decodeCtrlProxyMessage(msg({ type }));
      expect((decoded?.result as { success?: boolean }).success).toBe(expected);
    });
  }

  // Every type that reads `message.success` (all decoded types except the
  // no-success hierarchy_update and the hardcoded-true screenshot) must pass an
  // explicit success flag straight through, both true and false.
  const READS_MESSAGE_SUCCESS = DEFAULT_WHEN_ABSENT
    .filter(row => row.type !== "hierarchy_update" && row.type !== "screenshot")
    .map(row => row.type);

  test("the passthrough set is the 35 success-reading types", () => {
    expect(READS_MESSAGE_SUCCESS.length).toBe(35);
  });

  for (const type of READS_MESSAGE_SUCCESS) {
    test(`${type} passes an explicit success=true through`, () => {
      const decoded = decodeCtrlProxyMessage(msg({ type, success: true }));
      expect((decoded?.result as { success?: boolean }).success).toBe(true);
    });
    test(`${type} passes an explicit success=false through`, () => {
      const decoded = decodeCtrlProxyMessage(msg({ type, success: false }));
      expect((decoded?.result as { success?: boolean }).success).toBe(false);
    });
  }

  test("screenshot hardcodes success=true even when the wire says false", () => {
    const decoded = decodeCtrlProxyMessage(msg({ type: "screenshot", success: false }));
    expect((decoded?.result as { success?: boolean }).success).toBe(true);
  });

  // The four `success ?? ok ?? false` types read the `ok` alias when `success`
  // is absent (Android wire-protocol carryover), but `success` still wins when
  // both are present.
  const OK_ALIAS_TYPES = [
    "set_preference_result",
    "remove_preference_result",
    "clear_preferences_result",
    "set_network_error_simulation_result",
  ];

  for (const type of OK_ALIAS_TYPES) {
    test(`${type} falls back to ok=true when success is absent`, () => {
      const decoded = decodeCtrlProxyMessage(msg({ type, ok: true }));
      expect((decoded?.result as { success?: boolean }).success).toBe(true);
    });
    test(`${type} defaults to false when both success and ok are absent`, () => {
      const decoded = decodeCtrlProxyMessage(msg({ type }));
      expect((decoded?.result as { success?: boolean }).success).toBe(false);
    });
    test(`${type} lets explicit success=false win over ok=true`, () => {
      const decoded = decodeCtrlProxyMessage(msg({ type, success: false, ok: true }));
      expect((decoded?.result as { success?: boolean }).success).toBe(false);
    });
  }

  test("a message with a missing requestId decodes to null", () => {
    expect(decodeCtrlProxyMessage({ type: "swipe_result", success: false })).toBeNull();
  });

  test("a message with an empty-string requestId decodes to null", () => {
    expect(decodeCtrlProxyMessage({ type: "swipe_result", requestId: "", success: false })).toBeNull();
  });
});

describe("rewriteUnknownCommandError", () => {
  test("rewrites a known 'Unknown command type' error", () => {
    const out = rewriteUnknownCommandError("Unknown command type: add_highlight");
    expect(out).toContain("add_highlight");
    expect(out).toContain("rebuild and redeploy");
  });

  test("passes through unrelated errors unchanged", () => {
    expect(rewriteUnknownCommandError("timeout")).toBe("timeout");
  });
});
