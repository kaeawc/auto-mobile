import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decodeCtrlProxyMessage } from "../../../../src/features/observe/ios/decodeCtrlProxyMessage";
import type { WebSocketMessage } from "../../../../src/features/observe/ios/types";
import {
  RUNNER_DEADLINE_COMPLETED_LATE_CODE,
  RUNNER_DEADLINE_NOT_STARTED_CODE,
  RUNNER_FOCUS_QUERY_FAILED_CODE,
  RUNNER_GESTURE_BOUND_EXCEEDED_CODE,
  RUNNER_HIERARCHY_CAPTURE_FAILED_CODE,
} from "../../../../src/features/observe/ios/runnerErrorCodes";

// Read once: each test only exercises the pure host decoder against Swift-produced JSON.
const fixture = JSON.parse(
  readFileSync(
    join(import.meta.dir, "../../../fixtures/ios-contract/runner-responses.json"),
    "utf8",
  ),
) as {
  responseTypes: string[];
  responses: { name: string; wire: WebSocketMessage }[];
  commandErrors: { name: string; error: string; errorCode: string | null }[];
};
const timing = {
  name: "gesturePhases",
  durationMs: 7,
  children: [{ name: "dispatch", durationMs: 3 }],
};
const diagnostic = { code: "fixture", message: "fixture diagnostic" };
const rows = [["42"], [null]];
const requestId = "fixture-request-id";

// Concrete values deliberately independent of wire values: a missing field cannot pass
// by comparing two undefineds. The Swift equality gate additionally detects encoder drift.
const typedResults: Record<string, Record<string, unknown>> = {
  delete_keychain_item_result: {
    success: true,
    totalTimeMs: 17,
    outcome: "deleted",
    deletedScope: {
      itemClass: "genericPassword",
      service: "test.service",
      account: "fixture",
      accessGroup: "TEAM.app",
    },
  },
  screenshot: {
    success: true,
    data: "aW9z",
    format: "png",
    timestamp: 1700000000000,
    rotation: 1,
    frameContext: "frame-42",
  },
  hierarchy_update: {
    hierarchy: {
      updatedAt: 1700000000000,
      packageName: "fixture.app",
      screenWidth: 390,
      screenHeight: 844,
      insets: {
        available: false,
        source: "unavailable",
        units: "unknown",
        displayCutoutInfo: { classification: "unknown" },
      },
    },
    perfTiming: timing,
    frameContext: "frame-42",
    servedFromCache: true,
  },
  keyboard_result: { success: true, open: true, method: "fixture", totalTimeMs: 17 },
  rotate_result: {
    success: true,
    totalTimeMs: 17,
    previousOrientation: "portrait",
    currentOrientation: "landscape",
    value: 1,
    rotationPerformed: true,
  },
  hinge_angle_result: { success: false, angle: 90, error: "unsupported", totalTimeMs: 17 },
  accessibility_audit_result: {
    success: true,
    issues: [
      {
        check: "contrast",
        summary: "fixture issue",
        detail: "fixture detail",
        elementId: "fixture-element",
        label: "Fixture",
        bounds: { left: 1, top: 2, right: 3, bottom: 4 },
      },
    ],
    unsupportedChecks: ["fixture-check"],
    totalTimeMs: 17,
  },
  magic_tap_result: {
    success: false,
    available: true,
    handled: false,
    unsupported: true,
    requiresVoiceOver: false,
    error: "not handled",
    totalTimeMs: 17,
  },
  sdk_trigger_result: {
    success: false,
    available: true,
    statusCode: 404,
    sdkError: "unknown_trigger",
    reason: "fixture",
    registeredModules: ["callkit"],
    supportedTriggers: ["incoming"],
    error: "fixture failure",
    totalTimeMs: 17,
  },
  voiceover_state_result: { success: true, enabled: true, totalTimeMs: 17 },
  voiceover_set_result: { success: false, error: "fixture failure", totalTimeMs: 17 },
  preference_files: {
    success: true,
    files: [{ name: "Standard", path: "/fixture", displayName: "Defaults", entryCount: 2 }],
    totalTimeMs: 17,
  },
  preferences: {
    success: true,
    entries: [{ key: "token", value: "hidden", type: "STRING", redacted: true }],
    totalTimeMs: 17,
  },
  get_preference_result: {
    success: true,
    found: true,
    entry: { key: "token", value: "hidden", type: "STRING", redacted: true },
    totalTimeMs: 17,
  },
  set_network_mock_rules_result: {
    success: true,
    totalTimeMs: 17,
    rejectedMockIds: ["mock-42"],
    rejectedReasons: { "mock-42": "invalid pattern" },
  },
  set_network_fault_rules_result: { success: true, totalTimeMs: 17 },
  set_network_error_simulation_result: { success: true, totalTimeMs: 17 },
  sdk_capabilities_result: {
    success: true,
    available: true,
    bundleId: "fixture.app",
    capabilities: ["database", "hierarchy"],
    totalTimeMs: 17,
  },
  execute_sql_result: {
    success: true,
    queryType: "query",
    columns: ["id"],
    rows,
    rowsAffected: 2,
    diagnostic,
    truncated: true,
    totalTimeMs: 17,
  },
  list_databases_result: {
    success: true,
    databases: [{ name: "app", path: "/app.sqlite", sizeBytes: 4096 }],
    totalTimeMs: 17,
  },
  storage_capabilities_result: {
    success: true,
    capabilities: {
      readOnly: false,
      mutationAuthorized: true,
      registeredAppGroupSuites: ["group.fixture"],
      coreDataStores: [],
      unavailableStores: ["locked"],
    },
    totalTimeMs: 17,
  },
  list_tables_result: { success: true, tables: ["users"], totalTimeMs: 17 },
  table_data_result: {
    success: true,
    columns: ["id"],
    rows,
    total: 2,
    diagnostic,
    totalTimeMs: 17,
  },
  table_structure_result: {
    success: true,
    columns: [
      { name: "id", type: "INTEGER", nullable: false, primaryKey: true, defaultValue: "0" },
    ],
    diagnostic,
    totalTimeMs: 17,
  },
  clipboard_result: { success: true, text: "fixture text", action: "", totalTimeMs: 17 },
  appearance_result: { success: true, appearance: "dark", totalTimeMs: 17 },
  location_result: { success: true, totalTimeMs: 17 },
};
const genericTypes = new Set([
  "tap_coordinates_result",
  "swipe_result",
  "multi_finger_swipe_result",
  "path_gesture_result",
  "drag_result",
  "pinch_result",
  "set_text_result",
  "append_text_result",
  "clear_text_result",
  "ime_action_result",
  "select_all_result",
  "press_key_result",
  "press_button_result",
  "press_home_result",
  "press_back_result",
  "recent_apps_result",
  "action_result",
  "launch_app_result",
  "reset_permissions_result",
  "highlight_response",
  "set_preference_result",
  "remove_preference_result",
  "clear_preferences_result",
]);

function expectedGeneric(type: string): Record<string, unknown> {
  const result: Record<string, unknown> = { success: true, totalTimeMs: 17 };
  // These response decoders consume perfTiming; preference/highlight decoders do not.
  if (
    ![
      "set_preference_result",
      "remove_preference_result",
      "clear_preferences_result",
      "highlight_response",
    ].includes(type)
  ) {
    result.perfTiming = timing;
  }
  if (type === "press_key_result") {
    Object.assign(result, { verified: true, warning: "fixture warning" });
  }
  if (type === "action_result") {
    result.warning = "fixture warning";
  }
  if (type === "pinch_result") {
    result.pinchPath = "event-path";
  }
  if (type === "highlight_response") {
    Object.assign(result, { requestId, timestamp: 1700000000000 });
  }
  if (type === "set_preference_result") {
    Object.assign(result, { resolvedStore: "Standard", effectiveValueDiffers: true });
  }
  if (type === "tap_coordinates_result") {
    result.tapDiagnostics = {
      requested: {
        x: 12.5,
        y: 25.5,
        durationMs: 35,
        mode: "press",
        coordinateConstruction: "appFrameOriginPlusPointOffset",
        units: "points",
      },
      sampleErrors: [],
    };
  }
  return result;
}

describe("Swift runner production response encoders → host decoder", () => {
  test("every reshaped response type has a production-encoded example", () => {
    const reshaped = fixture.responseTypes
      .filter((type) => {
        const wire = { type, requestId } as WebSocketMessage;
        return decodeCtrlProxyMessage(wire)?.result !== wire;
      })
      .sort();
    expect(reshaped).toEqual([...genericTypes, ...Object.keys(typedResults)].sort());
    const covered = new Set(fixture.responses.map(({ wire }) => wire.type));
    for (const type of reshaped) {
      expect(covered.has(type)).toBe(true);
    }
    expect(new Set(fixture.responses.map(({ name }) => name)).size).toBe(fixture.responses.length);
  });

  test("all machine-readable runner error codes equal the host constants", () => {
    expect(
      fixture.commandErrors.flatMap(({ errorCode }) => (errorCode ? [errorCode] : [])).sort(),
    ).toEqual(
      [
        RUNNER_DEADLINE_COMPLETED_LATE_CODE,
        RUNNER_DEADLINE_NOT_STARTED_CODE,
        RUNNER_FOCUS_QUERY_FAILED_CODE,
        RUNNER_GESTURE_BOUND_EXCEEDED_CODE,
        RUNNER_HIERARCHY_CAPTURE_FAILED_CODE,
      ].sort(),
    );
  });

  for (const { name, wire } of fixture.responses) {
    test(name, () => {
      const decoded = decodeCtrlProxyMessage(wire);
      expect(decoded?.requestId).toBe(requestId);
      if (name === "runner_busy") {
        expect(decoded).toEqual({
          requestId,
          runnerBusy: true,
          runnerStalled: true,
          totalTimeMs: 17,
          errorMessage:
            "iOS runner is busy executing request_activate_accessibility_link for 35.0s (its deadline passed 5.0s ago; the gesture is a blocking XCUITest call the runner cannot interrupt); bounded runner recovery is required. The blocking action's outcome is unknown; observe fresh state before deciding whether to repeat it",
        });
      } else if (name === "delete_keychain_item_denied") {
        expect(decoded?.result).toEqual({
          success: false,
          totalTimeMs: 17,
          outcome: "mutation_not_authorized",
          deletedScope: null,
        });
      } else if (name === "error_success_false_without_error") {
        expect(decoded?.result).toMatchObject({
          success: false,
          totalTimeMs: 17,
          perfTiming: timing,
        });
        expect(decoded?.result).toHaveProperty("error", undefined);
        expect(decoded?.result).not.toHaveProperty("errorCode");
      } else if (name.startsWith("error_")) {
        const error = fixture.commandErrors.find((entry) => name === `error_${entry.name}`);
        expect(error).toBeDefined();
        expect(decoded?.result).toMatchObject({
          success: false,
          totalTimeMs: 17,
          error: error!.error,
          perfTiming: timing,
          ...(error!.errorCode ? { errorCode: error!.errorCode } : {}),
        });
        if (error!.errorCode === null) {
          expect(decoded?.result).not.toHaveProperty("errorCode");
        } else {
          expect(decoded?.result).toHaveProperty("errorCode", error!.errorCode);
        }
      } else if (["current_focus_result", "traversal_order_result"].includes(name)) {
        if (name === "current_focus_result") {
          expect(decoded?.result).toMatchObject({
            type: "current_focus_result",
            requestId,
            success: true,
            totalTimeMs: 17,
          });
        } else {
          expect(decoded?.result).toMatchObject({
            type: "traversal_order_result",
            requestId,
            success: true,
            totalTimeMs: 17,
            focusedIndex: 0,
            totalCount: 0,
            elements: [],
          });
        }
        expect(decoded?.result).toEqual(wire); // Passthrough retains the full wire envelope.
      } else {
        const expected = genericTypes.has(name) ? expectedGeneric(name) : typedResults[name];
        expect(expected).toBeDefined();
        expect(decoded?.result).toMatchObject(expected);
        if (name === "hierarchy_update") {
          expect(decoded?.result).toMatchObject({
            hierarchy: {
              insets: {
                available: false,
                source: "unavailable",
                units: "unknown",
                displayCutoutInfo: { classification: "unknown" },
              },
            },
          });
        }
      }
    });
  }
});
