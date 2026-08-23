/**
 * Field-name wire-parity backstop for the iOS control-proxy TS client ↔ Swift runner
 * (issue #2954, checklist item 3 of #2857).
 *
 * The command-name tripwire (`ctrlProxyWireParity.test.ts`) catches a dropped/renamed
 * `type` discriminator but NOT a renamed field *inside* a command payload: renaming
 * `disableAllFiltering` on the TS side compiles cleanly and only fails at runtime
 * on-device, when the Swift payload struct (`Models.swift`) decodes the wrong field.
 *
 * This suite is one half of a two-sided guard around a shared JSON snapshot fixture,
 * `test/fixtures/ios-ctrlproxy-request-snapshots.json`:
 *
 *   1. (here) Every snapshot is captured LIVE from the real TS builder — the delegate
 *      method is invoked against a fake `DelegateContext` and the exact JSON written to
 *      the WebSocket is compared with the committed fixture. A TS-side field rename
 *      diverges from the fixture and fails here, forcing a fixture update.
 *   2. (Swift) `RequestSnapshotWireParityTests.swift` decodes each snapshot through the
 *      real `WebSocketRequest` wire path and asserts every fixture field lands on a
 *      same-named property of the typed payload struct with the same value. A fixture
 *      update that the Swift structs can't decode — or a Swift-side field rename —
 *      fails there.
 *
 * Together, a one-sided rename of any covered payload field fails a test on whichever
 * side moved.
 *
 * To regenerate the fixture after an INTENTIONAL wire change:
 *   AUTOMOBILE_UPDATE_IOS_WIRE_SNAPSHOTS=1 bun test test/features/observe/ios/ctrlProxyRequestSnapshots.test.ts
 * then re-run the Swift suite (`cd ios/control-proxy && swift test`) — an intentional
 * change must update Models.swift (or the Swift test) in the same commit.
 *
 * `set_network_mock_rules` is the one semi-transcribed entry: it is emitted by the
 * private `IOSCtrlProxyClient.syncNetworkMockRulesToDevice()` (not a delegate we can
 * drive in isolation), so its envelope is transcribed while the `rules` payload — where
 * all the field names live — is built by the production `buildNetworkMockRules`.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
import { CtrlProxyClipboard } from "../../../../src/features/observe/ios/CtrlProxyClipboard";
import { CtrlProxyDatabase } from "../../../../src/features/observe/ios/CtrlProxyDatabase";
import { CtrlProxyGestures } from "../../../../src/features/observe/ios/CtrlProxyGestures";
import { CtrlProxyHierarchy } from "../../../../src/features/observe/ios/CtrlProxyHierarchy";
import { CtrlProxyHighlights } from "../../../../src/features/observe/ios/CtrlProxyHighlights";
import { CtrlProxyKeyboard } from "../../../../src/features/observe/ios/CtrlProxyKeyboard";
import { CtrlProxyNavigation } from "../../../../src/features/observe/ios/CtrlProxyNavigation";
import { CtrlProxyPermissions } from "../../../../src/features/observe/ios/CtrlProxyPermissions";
import { CtrlProxyScreenshot } from "../../../../src/features/observe/ios/CtrlProxyScreenshot";
import { CtrlProxyStorage } from "../../../../src/features/observe/ios/CtrlProxyStorage";
import { CtrlProxyText } from "../../../../src/features/observe/ios/CtrlProxyText";
import { CtrlProxyVoiceOver } from "../../../../src/features/observe/ios/CtrlProxyVoiceOver";
import { IOS_KNOWN_REQUEST_TYPE_SET } from "../../../../src/features/observe/ios/ctrlProxyRequestTypes";
import type { HierarchyDelegateContext } from "../../../../src/features/observe/ios/types";
import { buildNetworkMockRules } from "../../../../src/server/networkMockRules";
import { NetworkState } from "../../../../src/server/NetworkState";
import { RequestManager } from "../../../../src/utils/RequestManager";
import { FakeTimer } from "../../../fakes/FakeTimer";

const FIXTURE_PATH = resolve(
  import.meta.dir,
  "../../../fixtures/ios-ctrlproxy-request-snapshots.json",
);

/**
 * `requestId` values are generated per call (`RequestManager.generateId`), so captured
 * ids are normalized to this placeholder before comparison. The KEY name itself is
 * still guarded: a rename of the `requestId` wire key leaves the captured object with
 * a different key than the fixture and fails the deep-equality assertion.
 */
const FIXTURE_REQUEST_ID = "fixture-request-id";

interface FixtureFile {
  $comment: string[];
  snapshots: { name: string; builder: string; wire: Record<string, unknown> }[];
}

interface Harness {
  context: HierarchyDelegateContext;
  requestManager: RequestManager;
  sent: string[];
}

function createHarness(): Harness {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const sent: string[] = [];
  const requestManager = new RequestManager(timer);
  const context: HierarchyDelegateContext = {
    getWebSocket: () =>
      ({
        send: (data: string) => {
          sent.push(data);
        },
        readyState: 1,
      }) as any,
    requestManager,
    timer,
    ensureConnected: async () => true,
    cancelScreenshotBackoff: () => {},
    // Hierarchy-specific members (unused by the other delegates).
    cacheFreshTtlMs: 0,
    getCachedHierarchy: () => null,
    setCachedHierarchy: () => {},
  };
  return { context, requestManager, sent };
}

interface SnapshotSpec {
  /** Unique snapshot key; usually the wire `type`, suffixed when a command has variants. */
  name: string;
  /** The production builder captured, for the fixture's documentation field. */
  builder: string;
  invoke: (h: Harness) => Promise<unknown>;
  /**
   * Response the fake resolves the request with. Several builders (storage, database)
   * throw unless the response reports success, so those specs provide a matching shape.
   */
  resolveWith?: unknown;
}

/**
 * One spec per (command × payload shape) the iOS TS client can put on the wire.
 * Argument values are chosen so every payload field is present and distinctive
 * (fractional coordinates prove the iOS no-rounding path; no two coordinate
 * fields share a value, so a swapped field is caught by value, not just name).
 */
const SNAPSHOT_SPECS: SnapshotSpec[] = [
  {
    name: "request_hierarchy",
    builder: "CtrlProxyHierarchy.requestHierarchySync (disableAllFiltering=true)",
    invoke: (h) => new CtrlProxyHierarchy(h.context).requestHierarchySync(undefined, true),
    resolveWith: {},
  },
  {
    name: "request_hierarchy_if_stale",
    builder: "CtrlProxyHierarchy.requestHierarchySync (disableAllFiltering=false)",
    invoke: (h) => new CtrlProxyHierarchy(h.context).requestHierarchySync(undefined, false),
    resolveWith: {},
  },
  {
    name: "request_screenshot",
    builder: "CtrlProxyScreenshot.requestScreenshot",
    invoke: (h) => new CtrlProxyScreenshot(h.context).requestScreenshot(),
  },
  {
    name: "request_tap_coordinates",
    builder:
      "SharedGestureDelegate.requestTapCoordinates (via CtrlProxyGestures, roundCoordinates=false)",
    invoke: (h) => new CtrlProxyGestures(h.context).requestTapCoordinates(120.5, 240.25, 35),
  },
  {
    name: "request_swipe",
    builder: "SharedGestureDelegate.requestSwipe (via CtrlProxyGestures)",
    invoke: (h) => new CtrlProxyGestures(h.context).requestSwipe(10.5, 20.25, 300.75, 401.5, 275),
  },
  {
    name: "request_drag",
    builder: "SharedGestureDelegate.requestDrag (via CtrlProxyGestures)",
    invoke: (h) =>
      new CtrlProxyGestures(h.context).requestDrag(11.5, 22.25, 33.75, 44.5, 350, 900, 150, 5000),
  },
  {
    name: "request_pinch",
    builder: "SharedGestureDelegate.requestPinch (via CtrlProxyGestures)",
    invoke: (h) =>
      new CtrlProxyGestures(h.context).requestPinch(160.5, 320.25, 80.5, 200.75, 45.5, 275),
  },
  {
    name: "request_multi_finger_swipe",
    builder: "CtrlProxyGestures.requestMultiFingerSwipe",
    invoke: (h) =>
      new CtrlProxyGestures(h.context).requestMultiFingerSwipe(
        15.5,
        25.25,
        35.75,
        46.5,
        3,
        450,
        5000,
        undefined,
        24.5,
      ),
  },
  {
    name: "request_set_text",
    builder: "SharedTextDelegate.requestSetText (via CtrlProxyText)",
    invoke: (h) =>
      new CtrlProxyText(h.context).requestSetText("hello world", {
        resourceId: "login_username_field",
      }),
  },
  {
    name: "request_append_text",
    builder: "CtrlProxyText.requestAppendText",
    invoke: (h) =>
      new CtrlProxyText(h.context).requestAppendText("a", 5000, undefined, "frame-context"),
  },
  {
    name: "request_clear_text",
    builder: "CtrlProxyText.requestClearText",
    invoke: (h) => new CtrlProxyText(h.context).requestClearText("login_username_field"),
  },
  {
    name: "request_ime_action",
    builder: "SharedTextDelegate.requestImeAction (via CtrlProxyText)",
    invoke: (h) => new CtrlProxyText(h.context).requestImeAction("done"),
  },
  {
    name: "request_select_all",
    builder: "SharedTextDelegate.requestSelectAll (via CtrlProxyText)",
    invoke: (h) => new CtrlProxyText(h.context).requestSelectAll(),
  },
  {
    name: "request_keyboard",
    builder: "CtrlProxyKeyboard.requestKeyboard",
    invoke: (h) => new CtrlProxyKeyboard(h.context).requestKeyboard("open"),
  },
  {
    name: "request_press_button",
    builder: "CtrlProxyNavigation.requestPressButton",
    invoke: (h) =>
      new CtrlProxyNavigation(h.context).requestPressButton(
        "volume_up",
        5000,
        undefined,
        "frame-context",
      ),
  },
  {
    name: "request_press_home",
    builder: "CtrlProxyNavigation.requestPressHome",
    invoke: (h) =>
      new CtrlProxyNavigation(h.context).requestPressHome(5000, undefined, "frame-context"),
  },
  {
    name: "request_press_back",
    builder: "CtrlProxyNavigation.requestPressBack",
    invoke: (h) =>
      new CtrlProxyNavigation(h.context).requestPressBack(5000, undefined, "frame-context"),
  },
  {
    name: "request_shake",
    builder: "CtrlProxyNavigation.requestShake",
    invoke: (h) => new CtrlProxyNavigation(h.context).requestShake(),
  },
  {
    name: "request_recent_apps",
    builder: "CtrlProxyNavigation.requestRecentApps",
    invoke: (h) =>
      new CtrlProxyNavigation(h.context).requestRecentApps(5000, undefined, "frame-context"),
  },
  {
    name: "request_action",
    builder: "CtrlProxyVoiceOver.requestAction (resourceId + label lookup)",
    invoke: (h) =>
      new CtrlProxyVoiceOver(h.context).requestAction(
        "scroll_forward",
        "primary_table",
        "Primary Table",
      ),
  },
  {
    name: "request_action_voiceover_activate",
    builder: "CtrlProxyVoiceOver.requestVoiceOverActivate (label-only lookup)",
    invoke: (h) => new CtrlProxyVoiceOver(h.context).requestVoiceOverActivate("Submit", "activate"),
  },
  {
    name: "request_action_null_lookup",
    builder: "CtrlProxyVoiceOver.requestAction (explicit-null resourceId/label)",
    invoke: (h) => new CtrlProxyVoiceOver(h.context).requestAction("scroll_backward"),
  },
  {
    name: "request_launch_app",
    builder: "CtrlProxyNavigation.requestLaunchApp",
    invoke: (h) =>
      new CtrlProxyNavigation(h.context).requestLaunchApp(
        "com.example.app",
        10000,
        undefined,
        true,
      ),
  },
  {
    name: "request_rotate",
    builder: "CtrlProxyNavigation.requestRotate",
    invoke: (h) => new CtrlProxyNavigation(h.context).requestRotate("landscape"),
  },
  {
    name: "request_clipboard",
    builder: "CtrlProxyClipboard.requestClipboard",
    invoke: (h) => new CtrlProxyClipboard(h.context).requestClipboard("copy", "clipboard text"),
  },
  {
    name: "add_highlight_box",
    builder:
      "CtrlProxyHighlights.requestAddHighlight (box shape; bounds are rounded by the builder)",
    invoke: (h) =>
      new CtrlProxyHighlights(h.context).requestAddHighlight("hl-1", {
        type: "box",
        bounds: {
          x: 10.4,
          y: 20.6,
          width: 100.2,
          height: 50.5,
          sourceWidth: 390,
          sourceHeight: 844,
        },
        style: {
          strokeColor: "#FF0000",
          strokeWidth: 3.5,
          dashPattern: [4, 2],
          smoothing: "bezier",
          tension: 0.5,
          capStyle: "round",
          joinStyle: "miter",
        },
      }),
  },
  {
    name: "add_highlight_path",
    builder: "CtrlProxyHighlights.requestAddHighlight (path shape with points)",
    invoke: (h) =>
      new CtrlProxyHighlights(h.context).requestAddHighlight("hl-2", {
        type: "path",
        points: [
          { x: 1.5, y: 2.5 },
          { x: 3.5, y: 4.5 },
        ],
        bounds: { x: 1, y: 2, width: 10, height: 12 },
      }),
  },
  {
    name: "request_reset_permissions",
    builder: "CtrlProxyPermissions.requestResetPermissions",
    invoke: (h) =>
      new CtrlProxyPermissions(h.context).requestResetPermissions("com.example.app", [
        "camera",
        "photos",
      ]),
  },
  {
    name: "get_voiceover_state",
    builder: "CtrlProxyVoiceOver.requestVoiceOverState",
    invoke: (h) => new CtrlProxyVoiceOver(h.context).requestVoiceOverState(),
  },
  {
    name: "list_preference_files",
    builder: "CtrlProxyStorage.listPreferenceFiles",
    invoke: (h) => new CtrlProxyStorage(h.context).listPreferenceFiles("unused"),
    resolveWith: { success: true, files: [] },
  },
  {
    name: "get_preferences",
    builder: "CtrlProxyStorage.getPreferenceEntries",
    invoke: (h) => new CtrlProxyStorage(h.context).getPreferenceEntries("unused", "Standard"),
    resolveWith: { success: true, entries: [] },
  },
  {
    name: "get_preference",
    builder: "CtrlProxyStorage.getPreference",
    invoke: (h) =>
      new CtrlProxyStorage(h.context).getPreference("unused", "Standard", "launch_count"),
    resolveWith: { success: true, found: false },
  },
  {
    name: "set_preference",
    builder: "CtrlProxyStorage.setPreference",
    invoke: (h) =>
      new CtrlProxyStorage(h.context).setPreference(
        "unused",
        "Standard",
        "launch_count",
        "42",
        "INT",
      ),
    resolveWith: { success: true },
  },
  {
    name: "remove_preference",
    builder: "CtrlProxyStorage.removePreference",
    invoke: (h) =>
      new CtrlProxyStorage(h.context).removePreference("unused", "Standard", "launch_count"),
    resolveWith: { success: true },
  },
  {
    name: "clear_preferences",
    builder: "CtrlProxyStorage.clearPreferenceStore",
    invoke: (h) => new CtrlProxyStorage(h.context).clearPreferenceStore("unused", "Standard"),
    resolveWith: { success: true },
  },
  {
    name: "execute_sql",
    builder: "CtrlProxyDatabase.executeSQL",
    invoke: (h) =>
      new CtrlProxyDatabase(h.context).executeSQL(
        "com.example.app",
        "/Documents/app.sqlite",
        "SELECT * FROM users",
      ),
    resolveWith: { success: true, totalTimeMs: 1, queryType: "query", columns: [], rows: [] },
  },
  {
    name: "list_databases",
    builder: "CtrlProxyDatabase.listDatabases",
    invoke: (h) => new CtrlProxyDatabase(h.context).listDatabases("com.example.app"),
    resolveWith: { success: true, totalTimeMs: 1, databases: [] },
  },
  {
    name: "list_tables",
    builder: "CtrlProxyDatabase.listTables",
    invoke: (h) =>
      new CtrlProxyDatabase(h.context).listTables("com.example.app", "/Documents/app.sqlite"),
    resolveWith: { success: true, totalTimeMs: 1, tables: [] },
  },
  {
    name: "get_table_data",
    builder: "CtrlProxyDatabase.getTableData",
    invoke: (h) =>
      new CtrlProxyDatabase(h.context).getTableData(
        "com.example.app",
        "/Documents/app.sqlite",
        "users",
        25,
        10,
      ),
    resolveWith: { success: true, totalTimeMs: 1, columns: [], rows: [], total: 0 },
  },
  {
    name: "get_table_structure",
    builder: "CtrlProxyDatabase.getTableStructure",
    invoke: (h) =>
      new CtrlProxyDatabase(h.context).getTableStructure(
        "com.example.app",
        "/Documents/app.sqlite",
        "users",
      ),
    resolveWith: { success: true, totalTimeMs: 1, columns: [] },
  },
];

/**
 * Semi-transcribed snapshot for `set_network_mock_rules` (see module doc). The `rules`
 * array — the payload's entire field surface — is produced by the production
 * `buildNetworkMockRules`, mirroring `IOSCtrlProxyClient.syncNetworkMockRulesToDevice()`:
 *   this.sendMessage(JSON.stringify({ type: "set_network_mock_rules", rules }));
 */
function buildNetworkMockRulesSnapshot(): Record<string, unknown> {
  const state = new NetworkState({
    timer: new FakeTimer(),
    notifier: { notifyResourceUpdated: () => {} },
  });
  state.addMock({
    host: "api.example.com",
    path: "/v1/users",
    method: "GET",
    limit: 3,
    remaining: 3,
    statusCode: 200,
    responseHeaders: { "X-Mocked": "true" },
    responseBody: '{"users":[]}',
    contentType: "application/json",
  });
  const rules = buildNetworkMockRules(state);
  // Round-trip through JSON.stringify exactly like the emit site, so the captured
  // object reflects on-the-wire serialization (dropped undefineds, etc.).
  return JSON.parse(JSON.stringify({ type: "set_network_mock_rules", rules }));
}

/** Run a spec against a fresh harness and return the exact JSON object put on the wire. */
async function captureWire(spec: SnapshotSpec): Promise<Record<string, unknown>> {
  const h = createHarness();
  const promise = spec.invoke(h);
  // Let ensureConnected/register microtasks run until the message is sent.
  for (let i = 0; i < 20 && h.sent.length === 0; i++) {
    await Promise.resolve();
  }
  expect(h.sent.length).toBe(1);
  const wire = JSON.parse(h.sent[0]) as Record<string, unknown>;
  h.requestManager.resolve(
    wire.requestId as string,
    spec.resolveWith ?? { success: true, totalTimeMs: 1 },
  );
  await promise;
  return wire;
}

/** Normalize the generated requestId to the fixture placeholder (key name still guarded). */
function normalizeRequestId(wire: Record<string, unknown>): Record<string, unknown> {
  expect(typeof wire.requestId).toBe("string");
  expect((wire.requestId as string).length).toBeGreaterThan(0);
  return { ...wire, requestId: FIXTURE_REQUEST_ID };
}

async function captureAllSnapshots(): Promise<Map<string, Record<string, unknown>>> {
  const captured = new Map<string, Record<string, unknown>>();
  for (const spec of SNAPSHOT_SPECS) {
    captured.set(spec.name, normalizeRequestId(await captureWire(spec)));
  }
  // Sent without a requestId (fire-and-forget sync on reconnect) — not normalized.
  captured.set("set_network_mock_rules", buildNetworkMockRulesSnapshot());
  return captured;
}

function builderDoc(name: string): string {
  return (
    SNAPSHOT_SPECS.find((s) => s.name === name)?.builder ??
    "IOSCtrlProxyClient.syncNetworkMockRulesToDevice (envelope transcribed; rules built by buildNetworkMockRules)"
  );
}

function loadFixture(): FixtureFile {
  return JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as FixtureFile;
}

describe("iOS control-proxy — request snapshot fixture matches live TS builders", () => {
  test("every fixture snapshot equals the JSON the TS builder puts on the wire", async () => {
    const captured = await captureAllSnapshots();

    if (process.env.AUTOMOBILE_UPDATE_IOS_WIRE_SNAPSHOTS === "1") {
      const current = loadFixture();
      const updated: FixtureFile = {
        $comment: current.$comment,
        snapshots: [...captured.entries()].map(([name, wire]) => ({
          name,
          builder: builderDoc(name),
          wire,
        })),
      };
      writeFileSync(FIXTURE_PATH, `${JSON.stringify(updated, null, 2)}\n`);
    }

    const fixture = loadFixture();
    // Same snapshot set on both sides — a spec added here without a fixture entry (or a
    // stale fixture entry with no live spec) fails before any per-field comparison.
    expect([...captured.keys()].sort()).toEqual(fixture.snapshots.map((s) => s.name).sort());

    for (const snapshot of fixture.snapshots) {
      // Full deep equality: a renamed, added, dropped, or re-valued field in any TS
      // builder diverges from the committed fixture here.
      expect(captured.get(snapshot.name)).toEqual(snapshot.wire);
    }
  });

  test("fixture snapshot names are unique", () => {
    const names = loadFixture().snapshots.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test("every fixture wire type is a known RequestType rawValue", () => {
    for (const snapshot of loadFixture().snapshots) {
      expect(IOS_KNOWN_REQUEST_TYPE_SET.has(snapshot.wire.type as string)).toBe(true);
    }
  });

  test("the acceptance-critical commands are covered", () => {
    const covered = new Set(loadFixture().snapshots.map((s) => s.wire.type as string));
    const required = [
      "request_action",
      "request_set_text",
      "request_append_text",
      "request_ime_action",
      "request_hierarchy",
      "request_hierarchy_if_stale",
      // storage
      "list_preference_files",
      "get_preferences",
      "get_preference",
      "set_preference",
      "remove_preference",
      "clear_preferences",
      // database
      "execute_sql",
      "list_databases",
      "list_tables",
      "get_table_data",
      "get_table_structure",
    ];
    expect(required.filter((t) => !covered.has(t))).toEqual([]);
  });
});
