import { describe, expect, test } from "bun:test";
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

  test("screenshot defaults format to png", () => {
    const decoded = decodeCtrlProxyMessage(msg({ type: "screenshot", data: "b64" as never, timestamp: 9 }));
    expect(decoded).toEqual({
      requestId: REQ,
      result: { success: true, data: "b64", format: "png", timestamp: 9 },
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
    "clear_text_result",
    "select_all_result",
    "press_button_result",
    "press_home_result",
    "press_back_result",
    "recent_apps_result",
    "launch_app_result",
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
