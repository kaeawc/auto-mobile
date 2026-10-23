import { CtrlProxySdkCapabilities } from "../../../../src/features/observe/ios/CtrlProxySdkCapabilities";
import { CtrlProxyNetworkSync } from "../../../../src/features/observe/ios/CtrlProxyNetworkSync";
import { FakeOpenSocket } from "../../../fakes/FakeOpenSocket";
/**
 * Field-name wire-parity backstop for the iOS control-proxy TS client ↔ Swift runner
 * (issue #2954, checklist item 3 of #2857).
 *
 * The command-name tripwire (`ctrlProxyWireParity.integration.test.ts`) catches a dropped/renamed
 * `type` discriminator but NOT a renamed field *inside* a command payload: renaming
 * `disableAllFiltering` on the TS side compiles cleanly and only fails at runtime
 * on-device, when the typed Swift payload struct (under
 * `ios/control-proxy/Sources/CtrlProxy/Models/`) decodes the wrong field.
 *
 * This suite is one half of a two-sided guard around a shared JSON snapshot fixture,
 * `test/fixtures/ios-ctrlproxy-request-snapshots.json`:
 *
 *   1. (here) Every snapshot is captured LIVE from the real TS builder — the delegate
 *      method is invoked against a fake `DelegateContext` and the exact JSON written to
 *      the WebSocket is compared with the committed fixture. A TS-side field rename
 *      diverges from the fixture and fails here, forcing a fixture update.
 *   2. (Swift) `WireDecodeParityTests.swift` decodes each snapshot through the
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
 * change must update the `Models/` payload structs (or the Swift test) in the same commit.
 *
 * `set_network_mock_rules` is the one semi-transcribed entry: it is emitted by the
 * private `IOSCtrlProxyClient.syncNetworkMockRulesToDevice()` (not a delegate we can
 * drive in isolation), so its envelope is transcribed while the `rules` payload — where
 * all the field names live — is built by the production `buildNetworkMockRules`.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
import { IOSCtrlProxyClient } from "../../../../src/features/observe/ios/IOSCtrlProxyClient";
import { requestSdkTrigger } from "../../../../src/features/observe/ios/CtrlProxySdkTrigger";
import { requestAccessibilityAudit } from "../../../../src/features/observe/ios/CtrlProxyAccessibilityAudit";
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
import { buildNetworkMockRules } from "../../../../src/utils/networkMockRules";
import { NetworkState } from "../../../../src/utils/NetworkState";
import { RequestManager } from "../../../../src/utils/RequestManager";
import { serializeIosRequest } from "../../../../src/features/observe/ios/serializeIosRequest";
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
    serializeRequest: serializeIosRequest,
    getWebSocket: () =>
      new FakeOpenSocket((data) => {
        sent.push(data);
      }),
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
  fireAndForget?: boolean;
}

/**
 * One spec per (command × payload shape) the iOS TS client can put on the wire.
 * Argument values are chosen so every payload field is present and distinctive
 * (fractional coordinates prove the iOS no-rounding path; no two coordinate
 * fields share a value, so a swapped field is caught by value, not just name).
 */
// These runner commands are declared by the host but have no production TS builder.
// Remove an entry when its builder lands: the disjointness test prevents stale exemptions.
const HOST_NEVER_SENDS = new Set([
  "get_current_focus",
  "get_traversal_order",
  "request_two_finger_swipe",
  "set_network_fault_rules",
]);

function snapshotSdkCapabilities(h: Harness): CtrlProxySdkCapabilities {
  return new CtrlProxySdkCapabilities({
    timer: h.context.timer,
    getSupportedCommands: () => null,
    isCommandSupported: () => true,
    createDelegateContext: () => h.context,
    syncNetworkMockRulesToDevice: () => {},
    syncNetworkErrorSimulationToDevice: () => {},
  });
}

async function withClient(
  h: Harness,
  invoke: (client: IOSCtrlProxyClient) => unknown,
): Promise<unknown> {
  const client = IOSCtrlProxyClient.createForTesting(
    { deviceId: "snapshot-device", platform: "ios", name: "fixture" },
    8765,
    () => {
      throw new Error("snapshot must never open a socket");
    },
    h.context.timer,
  );
  client.getSdkCapabilityTestHooks().sdkCapabilityGate = async () => null;
  client.sendMessage = (data) => {
    h.sent.push(data);
    return true;
  };
  return await invoke(client);
}

const SNAPSHOT_SPECS: SnapshotSpec[] = [
  {
    name: "get_sdk_capabilities",
    builder: "CtrlProxySdkCapabilities.requestSdkCapabilities",
    invoke: (h) => snapshotSdkCapabilities(h).requestSdkCapabilities(-1),
  },
  {
    name: "request_activate_accessibility_link",
    builder: "CtrlProxyVoiceOver.requestActivateAccessibilityLink",
    invoke: (h) =>
      new CtrlProxyVoiceOver(h.context).requestActivateAccessibilityLink({
        text: "Details",
        occurrence: 2,
        ownerResourceId: "owner-42",
      }),
  },
  {
    name: "request_accessibility_audit",
    builder: "requestAccessibilityAudit",
    invoke: (h) =>
      requestAccessibilityAudit(h.context, {
        appId: "com.example.audited",
        checks: ["contrast", "hitRegion"],
      }),
  },
  {
    name: "request_magic_tap",
    builder: "CtrlProxyVoiceOver.requestMagicTap",
    invoke: (h) => new CtrlProxyVoiceOver(h.context).requestMagicTap(),
  },
  {
    name: "request_sdk_trigger",
    builder: "requestSdkTrigger",
    invoke: (h) =>
      requestSdkTrigger(h.context, {
        module: "callkit",
        trigger: "incoming",
        payload: { caller: "fixture" },
      }),
  },
  {
    name: "set_hierarchy_poll_interval",
    builder: "IOSCtrlProxyClient.refreshObservationStreamHierarchyCadence",
    invoke: (h) => withClient(h, (client) => client.refreshObservationStreamHierarchyCadence(275)),
    fireAndForget: true,
  },
  {
    name: "set_network_error_simulation",
    builder: "CtrlProxyNetworkSync.setNetworkErrorSimulation",
    invoke: (h) =>
      new CtrlProxyNetworkSync({
        getDevice: () => ({ deviceId: "snapshot-device", platform: "ios", name: "fixture" }),
        requestManager: h.requestManager,
        sdkCapability: {
          hasSdkCapability: () => true,
          isLegacySdkCommandSupported: () => true,
          ensureSdkCapability: async () => true,
          sdkCapabilityGate: async () => null,
        },
        sendMessage: (data) => {
          h.sent.push(data);
          return true;
        },
        isCommandSupported: () => true,
        createDelegateContext: () => h.context,
      }).setNetworkErrorSimulation({
        enabled: true,
        errorType: "timeout",
        limit: 3,
        expiresAtEpochMs: 1700000000000,
        remainingMs: 2500,
      }),
  },
  {
    name: "set_voiceover_state",
    builder: "CtrlProxyVoiceOver.requestSetVoiceOverEnabled",
    invoke: (h) => new CtrlProxyVoiceOver(h.context).requestSetVoiceOverEnabled(true),
  },
  {
    name: "storage_capabilities",
    builder: "CtrlProxyDatabase.storageCapabilities",
    invoke: (h) => new CtrlProxyDatabase(h.context).storageCapabilities("com.example.app"),
  },
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
    invoke: (h) =>
      new CtrlProxyGestures(h.context).requestTapCoordinates({ x: 120.5, y: 240.25, duration: 35 }),
  },
  {
    name: "request_tap_coordinates_double_tap",
    builder: "CtrlProxyGestures.requestDoubleTapCoordinates",
    invoke: (h) =>
      new CtrlProxyGestures(h.context).requestDoubleTapCoordinates(120.5, 240.25, 5000),
  },
  {
    name: "request_swipe",
    builder: "SharedGestureDelegate.requestSwipe (via CtrlProxyGestures)",
    invoke: (h) =>
      new CtrlProxyGestures(h.context).requestSwipe({
        x1: 10.5,
        y1: 20.25,
        x2: 300.75,
        y2: 401.5,
        duration: 275,
      }),
  },
  {
    name: "request_drag",
    builder: "SharedGestureDelegate.requestDrag (via CtrlProxyGestures)",
    invoke: (h) =>
      new CtrlProxyGestures(h.context).requestDrag({
        x1: 11.5,
        y1: 22.25,
        x2: 33.75,
        y2: 44.5,
        pressDurationMs: 350,
        dragDurationMs: 900,
        holdDurationMs: 150,
        timeoutMs: 5000,
      }),
  },
  {
    name: "request_pinch",
    builder: "SharedGestureDelegate.requestPinch (via CtrlProxyGestures)",
    invoke: (h) =>
      new CtrlProxyGestures(h.context).requestPinch({
        centerX: 160.5,
        centerY: 320.25,
        distanceStart: 80.5,
        distanceEnd: 200.75,
        rotationDegrees: 45.5,
        duration: 275,
      }),
  },
  {
    name: "request_path_gesture",
    builder: "CtrlProxyGestures.requestPathGesture",
    invoke: (h) =>
      new CtrlProxyGestures(h.context, undefined, async () => [
        "path_gesture_v1",
      ]).requestPathGesture(
        [
          { x: 12.5, y: 24.25, offsetMs: 0 },
          { x: 12.5, y: 24.25, offsetMs: 300 },
          { x: 40.75, y: 80.5, offsetMs: 700 },
        ],
        5000,
        "frame-42",
      ),
  },
  {
    name: "request_multi_finger_swipe",
    builder: "CtrlProxyGestures.requestMultiFingerSwipe",
    invoke: (h) =>
      new CtrlProxyGestures(h.context).requestMultiFingerSwipe({
        x1: 15.5,
        y1: 25.25,
        x2: 35.75,
        y2: 46.5,
        fingerCount: 3,
        duration: 450,
        timeoutMs: 5000,
        fingerSpacing: 24.5,
      }),
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
    name: "request_press_key",
    builder: "CtrlProxyKeyboard.requestPressKey",
    invoke: (h) => new CtrlProxyKeyboard(h.context).requestPressKey("tab", ["shift"]),
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
    name: "request_location",
    builder: "CtrlProxyNavigation.requestLocation",
    invoke: (h) =>
      new CtrlProxyNavigation(h.context).requestLocation({
        latitude: 37.33,
        longitude: -122.03,
        altitude: 12,
        horizontalAccuracy: 5,
      }),
  },
  {
    name: "set_hinge_angle",
    builder: "CtrlProxyNavigation.requestSetHingeAngle",
    invoke: (h) => new CtrlProxyNavigation(h.context).requestSetHingeAngle(130),
  },
  {
    name: "request_appearance",
    builder: "CtrlProxyNavigation.requestAppearance",
    invoke: (h) => new CtrlProxyNavigation(h.context).requestAppearance("dark"),
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
        type: "circle",
        bounds: {
          x: 10.4,
          y: 20.6,
          width: 100.2,
          height: 50.5,
          sourceWidth: 390,
          sourceHeight: 844,
        },
      }),
  },
  {
    name: "add_highlight_path",
    builder: "CtrlProxyHighlights.requestAddHighlight (path shape with points)",
    invoke: (h) =>
      new CtrlProxyHighlights(h.context).requestAddHighlight("hl-2", {
        type: "circle",

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
    invoke: (h) => new CtrlProxyStorage(h.context).listPreferenceFiles("com.example.app"),
    resolveWith: { success: true, files: [] },
  },
  {
    name: "get_preferences",
    builder: "CtrlProxyStorage.getPreferenceEntries",
    invoke: (h) =>
      new CtrlProxyStorage(h.context).getPreferenceEntries("com.example.app", "Standard"),
    resolveWith: { success: true, entries: [] },
  },
  {
    name: "get_preference",
    builder: "CtrlProxyStorage.getPreference",
    invoke: (h) =>
      new CtrlProxyStorage(h.context).getPreference("com.example.app", "Standard", "launch_count"),
    resolveWith: { success: true, found: false },
  },
  {
    name: "set_preference",
    builder: "CtrlProxyStorage.setPreference",
    invoke: (h) =>
      new CtrlProxyStorage(h.context, () => "fixture-session-id").setPreference(
        "com.example.app",
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
      new CtrlProxyStorage(h.context, () => "fixture-session-id").removePreference(
        "com.example.app",
        "Standard",
        "launch_count",
      ),
    resolveWith: { success: true },
  },
  {
    name: "delete_keychain_item",
    builder: "CtrlProxyStorage.deleteKeychainItemForIos",
    invoke: (h) =>
      new CtrlProxyStorage(
        h.context,
        () => "fixture-session-id",
        () => "fixture-mutation-token",
      ).deleteKeychainItemForIos(
        "com.example.app",
        {
          itemClass: "genericPassword",
          service: "test.service",
          account: "fixture",
          accessGroup: "TEAM.app",
        },
        true,
      ),
    resolveWith: { success: true, outcome: "deleted", deletedScope: null },
  },
  {
    name: "clear_preferences",
    builder: "CtrlProxyStorage.clearPreferenceStore",
    invoke: (h) =>
      new CtrlProxyStorage(h.context, () => "fixture-session-id").clearPreferenceStore(
        "com.example.app",
        "Standard",
      ),
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
  state.addMock("snapshot-device", {
    host: "api.example.com",
    path: "/v1/users",
    method: "GET",
    limit: 3,
    statusCode: 200,
    responseHeaders: { "X-Mocked": "true" },
    responseBody: '{"users":[]}',
    contentType: "application/json",
  });
  const rules = buildNetworkMockRules(state, "snapshot-device");
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
  if (!spec.fireAndForget) {
    h.requestManager.resolve(
      wire.requestId as string,
      spec.resolveWith ?? { success: true, totalTimeMs: 1 },
    );
  }
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
    const wire = await captureWire(spec);
    captured.set(spec.name, spec.fireAndForget ? wire : normalizeRequestId(wire));
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

let committedFixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as FixtureFile;
function loadFixture(): FixtureFile {
  return committedFixture;
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
      committedFixture = updated;
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

  test("fixture covers every host-sent RequestType", () => {
    const covered = new Set(loadFixture().snapshots.map((s) => s.wire.type));
    expect([...covered].sort()).toEqual(
      [...IOS_KNOWN_REQUEST_TYPE_SET].filter((type) => !HOST_NEVER_SENDS.has(type)).sort(),
    );
  });

  test("host-never-sends exemptions are known and absent from the fixture", () => {
    const covered = new Set(loadFixture().snapshots.map((s) => s.wire.type));
    for (const type of HOST_NEVER_SENDS) {
      expect(IOS_KNOWN_REQUEST_TYPE_SET.has(type)).toBe(true);
      expect(covered.has(type)).toBe(false);
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
      "delete_keychain_item",
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

describe("iOS integer millisecond request boundary", () => {
  const timingFields: Readonly<Record<string, readonly string[]>> = {
    request_tap_coordinates: ["duration"],
    request_action: ["duration"],
    request_drag: ["pressDurationMs", "dragDurationMs", "holdDurationMs", "holdTime"],
    request_swipe: ["duration", "timeoutMs"],
    request_pinch: ["duration"],
    request_two_finger_swipe: ["duration"],
    request_multi_finger_swipe: ["duration"],
    set_hierarchy_poll_interval: ["intervalMs"],
  };
  for (const [type, fields] of Object.entries(timingFields)) {
    for (const field of fields) {
      test(`${type}.${field} rounds fractions, preserves integers and omits undefined`, () => {
        for (const [input, expected] of [
          [250.5, 251],
          [0.4, 1],
          [600.5, 601],
          [1500.4, 1500],
        ]) {
          const message = { type, [field]: input, x: 1.5 };
          expect(serializeIosRequest(message)).toBe(
            JSON.stringify({ ...message, [field]: expected }),
          );
        }
        for (const input of [0, 1, 250, 1500, undefined]) {
          const message = { type, [field]: input, x: 1.5 };
          expect(serializeIosRequest(message)).toBe(JSON.stringify(message));
        }
      });
    }
  }

  test("live gesture and VoiceOver builders share the serializer", async () => {
    const specs: SnapshotSpec[] = [
      {
        name: "tap",
        builder: "tap",
        invoke: (h) =>
          new CtrlProxyGestures(h.context).requestTapCoordinates({
            x: 1.5,
            y: 2.5,
            duration: 250.5,
          }),
      },
      {
        name: "action",
        builder: "action",
        invoke: (h) =>
          new CtrlProxyVoiceOver(h.context).requestVoiceOverActivate(
            "Row",
            "long_press",
            5000,
            undefined,
            { duration: 250.5 },
          ),
      },
      {
        name: "drag",
        builder: "drag",
        invoke: (h) =>
          new CtrlProxyGestures(h.context).requestDrag({
            x1: 1,
            y1: 2,
            x2: 3,
            y2: 4,
            pressDurationMs: 600.5,
            dragDurationMs: 1500.4,
            holdDurationMs: 0.4,
            timeoutMs: 5000,
          }),
      },
      {
        name: "swipe",
        builder: "swipe",
        invoke: (h) =>
          new CtrlProxyGestures(h.context).requestSwipe({
            x1: 1,
            y1: 2,
            x2: 3,
            y2: 4,
            duration: 250.5,
            timeoutMs: 1500.4,
          }),
      },
      {
        name: "pinch",
        builder: "pinch",
        invoke: (h) =>
          new CtrlProxyGestures(h.context).requestPinch({
            centerX: 1,
            centerY: 2,
            distanceStart: 3,
            distanceEnd: 4,
            rotationDegrees: 0.5,
            duration: 250.5,
          }),
      },
      {
        name: "multi",
        builder: "multi",
        invoke: (h) =>
          new CtrlProxyGestures(h.context).requestMultiFingerSwipe({
            x1: 1,
            y1: 2,
            x2: 3,
            y2: 4,
            fingerCount: 3,
            duration: 250.5,
          }),
      },
    ];
    for (const spec of specs) {
      const wire = await captureWire(spec);
      if (spec.name === "drag") {
        expect(wire.pressDurationMs).toBe(601);
        expect(wire.dragDurationMs).toBe(1500);
        expect(wire.holdDurationMs).toBe(1);
      } else {
        expect(wire.duration).toBe(251);
      }
      if (spec.name === "swipe") {
        expect(wire.timeoutMs).toBe(1500);
      }
      if (spec.name === "pinch") {
        expect(wire.rotationDegrees).toBe(0.5);
      }
    }
  });

  test("opaque payloads and unrelated numeric fields are unchanged", () => {
    const message = { type: "set_preference", duration: 0.4, value: { intervalMs: 250.5 } };
    expect(serializeIosRequest(message)).toBe(JSON.stringify(message));
  });
});
