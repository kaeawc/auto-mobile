/**
 * Byte-for-byte contract tests for the typed Android control-proxy request layer.
 *
 * Each builder must serialize to the exact JSON the device's Kotlin sealed hierarchy
 * (`android/protocol/.../WebSocketRequest.kt`) expects — the strings asserted here mirror the
 * pre-migration hand-built `JSON.stringify(...)` send sites, so a drift in field name, order,
 * optionality, or null-vs-omitted handling fails a test rather than silently breaking the wire.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import type { HighlightBoxShape } from "../../../../src/models/VisualHighlight";
import type { NetworkMockRuleSync } from "../../../../src/server/networkMockRules";
import {
  ctrlProxyRequests,
  serializeCtrlProxyRequest,
  KNOWN_REQUEST_TYPES,
} from "../../../../src/features/observe/android/ctrlProxyProtocol";

/**
 * Every `@SerialName` declared in WebSocketRequest.kt, transcribed by hand. Keep this in lockstep
 * with the Kotlin sealed hierarchy — this is the authoritative device contract the TS union mirrors.
 */
const KOTLIN_SERIAL_NAMES = [
  "request_hierarchy",
  "request_hierarchy_if_stale",
  "set_hierarchy_interval",
  "request_screenshot",
  "request_tap_coordinates",
  "request_swipe",
  "request_two_finger_swipe",
  "request_drag",
  "request_pinch",
  "request_gesture_start",
  "request_gesture_move",
  "request_gesture_end",
  "request_set_text",
  "request_ime_action",
  "request_select_all",
  "request_action",
  "request_hit_test",
  "request_clipboard",
  "request_settings_get",
  "request_settings_put",
  "request_settings_list",
  "install_ca_cert",
  "install_ca_cert_from_path",
  "remove_ca_cert",
  "get_device_owner_status",
  "get_permission",
  "get_current_focus",
  "get_traversal_order",
  "add_highlight",
  "list_preference_files",
  "get_preferences",
  "subscribe_storage",
  "unsubscribe_storage",
  "get_preference",
  "set_preference",
  "remove_preference",
  "clear_preferences",
  "request_global_action",
  "validate_frame_context",
  "request_device_info",
  "set_recomposition_tracking",
  "set_accessibility_flags",
  "set_network_mock_rules",
  "set_network_error_simulation",
  "request_installed_packages",
  "request_package_info",
  "request_launch_intent",
  "start_recording",
  "stop_recording",
];

describe("ctrlProxyProtocol — Kotlin contract coverage", () => {
  test("KNOWN_REQUEST_TYPES matches the device @SerialName set exactly", () => {
    expect([...KNOWN_REQUEST_TYPES].sort()).toEqual([...KOTLIN_SERIAL_NAMES].sort());
  });

  test("no duplicate discriminators", () => {
    expect(new Set(KNOWN_REQUEST_TYPES).size).toBe(KNOWN_REQUEST_TYPES.length);
  });

  // Authoritative cross-language guard: read the actual @SerialName set out of the Kotlin contract
  // and assert it equals ours. Unlike the hand-maintained KOTLIN_SERIAL_NAMES list above, this
  // catches a request type renamed/added/removed on the device — the drift the module exists to
  // prevent — instead of trusting a transcription. Skipped only if the Kotlin file isn't reachable
  // (e.g. running outside the monorepo), which never happens in CI.
  const KOTLIN_CONTRACT_PATH = resolve(
    import.meta.dir,
    "../../../../android/protocol/src/main/kotlin/dev/jasonpearson/automobile/protocol/WebSocketRequest.kt"
  );

  test.skipIf(!existsSync(KOTLIN_CONTRACT_PATH))(
    "KNOWN_REQUEST_TYPES matches the @SerialName set read from WebSocketRequest.kt",
    () => {
      const source = readFileSync(KOTLIN_CONTRACT_PATH, "utf8");
      const serialNames = [...source.matchAll(/@SerialName\("([^"]+)"\)/g)].map(m => m[1]);
      expect(serialNames.length).toBeGreaterThan(0);
      expect([...new Set(serialNames)].sort()).toEqual([...KNOWN_REQUEST_TYPES].sort());
      // The transcribed list must also match the source, so it can't rot independently.
      expect([...new Set(serialNames)].sort()).toEqual([...KOTLIN_SERIAL_NAMES].sort());
    }
  );
});


/**
 * Byte-for-byte wire contract for every builder in `ctrlProxyRequests`, as a single parameterized
 * table. Each row pairs a builder invocation with the exact JSON string the device must receive.
 * The rows are the specification: a drift in field name, order, optionality, or null-vs-omitted
 * handling fails the matching row rather than silently breaking the wire.
 *
 * The `builder` tag on each row feeds the completeness guard below, which fails when a new builder
 * ships with zero wire coverage (builder #37) — closing the gap the old per-case tests left open.
 */
describe("ctrlProxyProtocol — builders serialize byte-identically", () => {
  const shape: HighlightBoxShape = { type: "box", bounds: { x: 1, y: 2, width: 3, height: 4 } };
  const shapeJson = '{"type":"box","bounds":{"x":1,"y":2,"width":3,"height":4}}';
  const longCert = "A".repeat(4096);
  const networkRules: NetworkMockRuleSync[] = [{
    mockId: "m1", host: "example.com", path: "/v1", method: "GET",
    limit: null, remaining: null, statusCode: 200,
    responseHeaders: { "content-type": "application/json" },
    responseBody: "{}", contentType: "application/json",
  }];

  interface BuilderCase {
    builder: keyof typeof ctrlProxyRequests;
    name: string;
    actual: string;
    expected: string;
  }

  const cases: BuilderCase[] = [
    {
      builder: "requestHierarchy",
      name: "disableAllFiltering false",
      actual: serializeCtrlProxyRequest(ctrlProxyRequests.requestHierarchy({ requestId: "req-1", disableAllFiltering: false })),
      expected: '{"type":"request_hierarchy","requestId":"req-1","disableAllFiltering":false}',
    },
    {
      builder: "requestHierarchy",
      name: "disableAllFiltering true",
      actual: serializeCtrlProxyRequest(ctrlProxyRequests.requestHierarchy({ requestId: "req-2", disableAllFiltering: true })),
      expected: '{"type":"request_hierarchy","requestId":"req-2","disableAllFiltering":true}',
    },
    {
      builder: "requestHierarchyIfStale",
      name: "positive sinceTimestamp",
      actual: serializeCtrlProxyRequest(ctrlProxyRequests.requestHierarchyIfStale({ requestId: "stale-1", sinceTimestamp: 1720000000000 })),
      expected: '{"type":"request_hierarchy_if_stale","requestId":"stale-1","sinceTimestamp":1720000000000}',
    },
    {
      builder: "requestHierarchyIfStale",
      name: "negative sinceTimestamp (boundary) is sent verbatim",
      actual: serializeCtrlProxyRequest(ctrlProxyRequests.requestHierarchyIfStale({ requestId: "stale-neg", sinceTimestamp: -1 })),
      expected: '{"type":"request_hierarchy_if_stale","requestId":"stale-neg","sinceTimestamp":-1}',
    },
    {
      builder: "setHierarchyInterval",
      name: "numeric interval",
      actual: serializeCtrlProxyRequest(ctrlProxyRequests.setHierarchyInterval({ intervalMs: 500 })),
      expected: '{"type":"set_hierarchy_interval","intervalMs":500}',
    },
    {
      builder: "setHierarchyInterval",
      name: "explicit null interval is kept (not omitted)",
      actual: serializeCtrlProxyRequest(ctrlProxyRequests.setHierarchyInterval({ intervalMs: null })),
      expected: '{"type":"set_hierarchy_interval","intervalMs":null}',
    },
    {
      builder: "setHierarchyInterval",
      name: "non-finite interval (boundary) serializes to null per JSON.stringify",
      actual: serializeCtrlProxyRequest(ctrlProxyRequests.setHierarchyInterval({ intervalMs: Number.POSITIVE_INFINITY })),
      expected: '{"type":"set_hierarchy_interval","intervalMs":null}',
    },
    {
      builder: "requestScreenshot",
      name: "requestId only",
      actual: serializeCtrlProxyRequest(ctrlProxyRequests.requestScreenshot({ requestId: "s-1" })),
      expected: '{"type":"request_screenshot","requestId":"s-1"}',
    },
    {
      builder: "requestAction",
      name: "resourceId included when present",
      actual: serializeCtrlProxyRequest(ctrlProxyRequests.requestAction({ requestId: "a-1", action: "long_click", resourceId: "res" })),
      expected: '{"type":"request_action","requestId":"a-1","action":"long_click","resourceId":"res"}',
    },
    {
      builder: "requestAction",
      name: "resourceId omitted when undefined",
      actual: serializeCtrlProxyRequest(ctrlProxyRequests.requestAction({ requestId: "a-2", action: "clear_focus" })),
      expected: '{"type":"request_action","requestId":"a-2","action":"clear_focus"}',
    },
    {
      builder: "requestAction",
      name: "empty-string resourceId (boundary) is sent, not omitted",
      actual: serializeCtrlProxyRequest(ctrlProxyRequests.requestAction({ requestId: "a-empty", action: "x", resourceId: "" })),
      expected: '{"type":"request_action","requestId":"a-empty","action":"x","resourceId":""}',
    },
    {
      builder: "requestAction",
      name: "stable node selector carried alongside the legacy resource id",
      actual: serializeCtrlProxyRequest(ctrlProxyRequests.requestAction({
        requestId: "a-3",
        action: "long_click",
        resourceId: "com.example:id/row",
        selector: { resourceId: "com.example:id/row", testTag: "message_row_42", collectionRow: 4, collectionColumn: 0 },
      })),
      expected: '{"type":"request_action","requestId":"a-3","action":"long_click","resourceId":"com.example:id/row","selector":{"resourceId":"com.example:id/row","testTag":"message_row_42","collectionRow":4,"collectionColumn":0}}',
    },
    {
      builder: "requestClipboard",
      name: "text included for copy",
      actual: serializeCtrlProxyRequest(ctrlProxyRequests.requestClipboard({ requestId: "c-1", action: "copy", text: "hi" })),
      expected: '{"type":"request_clipboard","requestId":"c-1","action":"copy","text":"hi"}',
    },
    {
      builder: "requestClipboard",
      name: "text omitted for paste",
      actual: serializeCtrlProxyRequest(ctrlProxyRequests.requestClipboard({ requestId: "c-2", action: "paste" })),
      expected: '{"type":"request_clipboard","requestId":"c-2","action":"paste"}',
    },
    {
      builder: "requestClipboard",
      name: "empty-string text (boundary) is sent",
      actual: serializeCtrlProxyRequest(ctrlProxyRequests.requestClipboard({ requestId: "c-3", action: "copy", text: "" })),
      expected: '{"type":"request_clipboard","requestId":"c-3","action":"copy","text":""}',
    },
    {
      builder: "requestClipboard",
      name: "unicode text (boundary) is sent unescaped",
      actual: serializeCtrlProxyRequest(ctrlProxyRequests.requestClipboard({ requestId: "c-u", action: "copy", text: "café ☕ 日本語" })),
      expected: '{"type":"request_clipboard","requestId":"c-u","action":"copy","text":"café ☕ 日本語"}',
    },
    {
      builder: "requestSettingsGet",
      name: "namespace + key",
      actual: serializeCtrlProxyRequest(ctrlProxyRequests.requestSettingsGet({ requestId: "sg-1", namespace: "system", key: "font_scale" })),
      expected: '{"type":"request_settings_get","requestId":"sg-1","namespace":"system","key":"font_scale"}',
    },
    {
      builder: "requestSettingsPut",
      name: "string value",
      actual: serializeCtrlProxyRequest(ctrlProxyRequests.requestSettingsPut({ requestId: "sp-1", namespace: "secure", key: "k", value: "v", valueType: "string" })),
      expected: '{"type":"request_settings_put","requestId":"sp-1","namespace":"secure","key":"k","value":"v","valueType":"string"}',
    },
    {
      builder: "requestSettingsPut",
      name: "explicit null value is kept",
      actual: serializeCtrlProxyRequest(ctrlProxyRequests.requestSettingsPut({ requestId: "sp-2", namespace: "global", key: "k", value: null, valueType: "int" })),
      expected: '{"type":"request_settings_put","requestId":"sp-2","namespace":"global","key":"k","value":null,"valueType":"int"}',
    },
    {
      builder: "requestSettingsList",
      name: "namespace",
      actual: serializeCtrlProxyRequest(ctrlProxyRequests.requestSettingsList({ requestId: "sl-1", namespace: "global" })),
      expected: '{"type":"request_settings_list","requestId":"sl-1","namespace":"global"}',
    },
    {
      builder: "installCaCert",
      name: "certificate payload",
      actual: serializeCtrlProxyRequest(ctrlProxyRequests.installCaCert({ requestId: "ca-1", certificate: "PEMDATA" })),
      expected: '{"type":"install_ca_cert","requestId":"ca-1","certificate":"PEMDATA"}',
    },
    {
      builder: "installCaCert",
      name: "very-long certificate (boundary) is sent verbatim",
      actual: serializeCtrlProxyRequest(ctrlProxyRequests.installCaCert({ requestId: "ca-long", certificate: longCert })),
      expected: `{"type":"install_ca_cert","requestId":"ca-long","certificate":"${longCert}"}`,
    },
    {
      builder: "installCaCertFromPath",
      name: "device path",
      actual: serializeCtrlProxyRequest(ctrlProxyRequests.installCaCertFromPath({ requestId: "ca-2", devicePath: "/sdcard/x.crt" })),
      expected: '{"type":"install_ca_cert_from_path","requestId":"ca-2","devicePath":"/sdcard/x.crt"}',
    },
    {
      builder: "removeCaCert",
      name: "alias",
      actual: serializeCtrlProxyRequest(ctrlProxyRequests.removeCaCert({ requestId: "ca-3", alias: "user-alias" })),
      expected: '{"type":"remove_ca_cert","requestId":"ca-3","alias":"user-alias"}',
    },
    {
      builder: "getDeviceOwnerStatus",
      name: "requestId only",
      actual: serializeCtrlProxyRequest(ctrlProxyRequests.getDeviceOwnerStatus({ requestId: "do-1" })),
      expected: '{"type":"get_device_owner_status","requestId":"do-1"}',
    },
    {
      builder: "getPermission",
      name: "permission + requestPermission",
      actual: serializeCtrlProxyRequest(ctrlProxyRequests.getPermission({ requestId: "p-1", permission: "android.permission.CAMERA", requestPermission: true })),
      expected: '{"type":"get_permission","requestId":"p-1","permission":"android.permission.CAMERA","requestPermission":true}',
    },
    {
      builder: "requestDeviceInfo",
      name: "requestId only",
      actual: serializeCtrlProxyRequest(ctrlProxyRequests.requestDeviceInfo({ requestId: "di-1" })),
      expected: '{"type":"request_device_info","requestId":"di-1"}',
    },
    {
      builder: "getCurrentFocus",
      name: "requestId only",
      actual: serializeCtrlProxyRequest(ctrlProxyRequests.getCurrentFocus({ requestId: "cf-1" })),
      expected: '{"type":"get_current_focus","requestId":"cf-1"}',
    },
    {
      builder: "getTraversalOrder",
      name: "requestId only",
      actual: serializeCtrlProxyRequest(ctrlProxyRequests.getTraversalOrder({ requestId: "to-1" })),
      expected: '{"type":"get_traversal_order","requestId":"to-1"}',
    },
    {
      builder: "addHighlight",
      name: "id and shape both present",
      actual: serializeCtrlProxyRequest(ctrlProxyRequests.addHighlight({ requestId: "h-1", id: "hi", shape })),
      expected: `{"type":"add_highlight","requestId":"h-1","id":"hi","shape":${shapeJson}}`,
    },
    {
      builder: "addHighlight",
      name: "id and shape both absent",
      actual: serializeCtrlProxyRequest(ctrlProxyRequests.addHighlight({ requestId: "h-2" })),
      expected: '{"type":"add_highlight","requestId":"h-2"}',
    },
    {
      builder: "addHighlight",
      name: "id only drops shape without disturbing key order",
      actual: serializeCtrlProxyRequest(ctrlProxyRequests.addHighlight({ requestId: "h-3", id: "hi" })),
      expected: '{"type":"add_highlight","requestId":"h-3","id":"hi"}',
    },
    {
      builder: "addHighlight",
      name: "shape only",
      actual: serializeCtrlProxyRequest(ctrlProxyRequests.addHighlight({ requestId: "h-4", shape })),
      expected: `{"type":"add_highlight","requestId":"h-4","shape":${shapeJson}}`,
    },
    {
      builder: "listPreferenceFiles",
      name: "packageName",
      actual: serializeCtrlProxyRequest(ctrlProxyRequests.listPreferenceFiles({ requestId: "lp-1", packageName: "com.x" })),
      expected: '{"type":"list_preference_files","requestId":"lp-1","packageName":"com.x"}',
    },
    {
      builder: "getPreferences",
      name: "packageName + fileName",
      actual: serializeCtrlProxyRequest(ctrlProxyRequests.getPreferences({ requestId: "gp-1", packageName: "com.x", fileName: "prefs" })),
      expected: '{"type":"get_preferences","requestId":"gp-1","packageName":"com.x","fileName":"prefs"}',
    },
    {
      builder: "subscribeStorage",
      name: "packageName + fileName",
      actual: serializeCtrlProxyRequest(ctrlProxyRequests.subscribeStorage({ requestId: "ss-1", packageName: "com.x", fileName: "prefs" })),
      expected: '{"type":"subscribe_storage","requestId":"ss-1","packageName":"com.x","fileName":"prefs"}',
    },
    {
      builder: "unsubscribeStorage",
      name: "latent-bug shape: only subscriptionId is sent",
      actual: serializeCtrlProxyRequest(ctrlProxyRequests.unsubscribeStorage({ requestId: "us-1", subscriptionId: "com.x:prefs" })),
      expected: '{"type":"unsubscribe_storage","requestId":"us-1","subscriptionId":"com.x:prefs"}',
    },
    {
      builder: "getPreference",
      name: "packageName + fileName + key",
      actual: serializeCtrlProxyRequest(ctrlProxyRequests.getPreference({ requestId: "gpr-1", packageName: "com.x", fileName: "prefs", key: "k" })),
      expected: '{"type":"get_preference","requestId":"gpr-1","packageName":"com.x","fileName":"prefs","key":"k"}',
    },
    {
      builder: "setPreference",
      name: "string value",
      actual: serializeCtrlProxyRequest(ctrlProxyRequests.setPreference({ requestId: "setp-1", packageName: "com.x", fileName: "prefs", key: "k", value: "v", valueType: "STRING" })),
      expected: '{"type":"set_preference","requestId":"setp-1","packageName":"com.x","fileName":"prefs","key":"k","value":"v","valueType":"STRING"}',
    },
    {
      builder: "setPreference",
      name: "explicit null value is kept",
      actual: serializeCtrlProxyRequest(ctrlProxyRequests.setPreference({ requestId: "setp-2", packageName: "com.x", fileName: "prefs", key: "k", value: null, valueType: "INT" })),
      expected: '{"type":"set_preference","requestId":"setp-2","packageName":"com.x","fileName":"prefs","key":"k","value":null,"valueType":"INT"}',
    },
    {
      builder: "removePreference",
      name: "packageName + fileName + key",
      actual: serializeCtrlProxyRequest(ctrlProxyRequests.removePreference({ requestId: "rp-1", packageName: "com.x", fileName: "prefs", key: "k" })),
      expected: '{"type":"remove_preference","requestId":"rp-1","packageName":"com.x","fileName":"prefs","key":"k"}',
    },
    {
      builder: "clearPreferences",
      name: "packageName + fileName",
      actual: serializeCtrlProxyRequest(ctrlProxyRequests.clearPreferences({ requestId: "cp-1", packageName: "com.x", fileName: "prefs" })),
      expected: '{"type":"clear_preferences","requestId":"cp-1","packageName":"com.x","fileName":"prefs"}',
    },
    {
      builder: "requestGlobalAction",
      name: "action",
      actual: serializeCtrlProxyRequest(ctrlProxyRequests.requestGlobalAction({ requestId: "ga-1", action: "back" })),
      expected: '{"type":"request_global_action","requestId":"ga-1","action":"back"}',
    },
    {
      builder: "validateFrameContext",
      name: "frame context",
      actual: serializeCtrlProxyRequest(
        ctrlProxyRequests.validateFrameContext({ requestId: "fc-1", frameContext: "epoch:5" })
      ),
      expected: '{"type":"validate_frame_context","requestId":"fc-1","frameContext":"epoch:5"}',
    },
    {
      builder: "setRecompositionTracking",
      name: "enabled flag",
      actual: serializeCtrlProxyRequest(ctrlProxyRequests.setRecompositionTracking({ requestId: "rt-1", enabled: true })),
      expected: '{"type":"set_recomposition_tracking","requestId":"rt-1","enabled":true}',
    },
    {
      builder: "setAccessibilityFlags",
      name: "no requestId on the wire",
      actual: serializeCtrlProxyRequest(ctrlProxyRequests.setAccessibilityFlags({
        includeNotImportantViews: true, reportViewIds: false, retrieveInteractiveWindows: true, occlusionEnabled: false,
      })),
      expected: '{"type":"set_accessibility_flags","includeNotImportantViews":true,"reportViewIds":false,"retrieveInteractiveWindows":true,"occlusionEnabled":false}',
    },
    {
      builder: "setNetworkMockRules",
      name: "no requestId, rules array passed through",
      actual: serializeCtrlProxyRequest(ctrlProxyRequests.setNetworkMockRules({ rules: networkRules })),
      expected: '{"type":"set_network_mock_rules","rules":[{"mockId":"m1","host":"example.com","path":"/v1","method":"GET","limit":null,"remaining":null,"statusCode":200,"responseHeaders":{"content-type":"application/json"},"responseBody":"{}","contentType":"application/json"}]}',
    },
    {
      builder: "setNetworkErrorSimulation",
      name: "enabled with values",
      actual: serializeCtrlProxyRequest(ctrlProxyRequests.setNetworkErrorSimulation({ enabled: true, errorType: "timeout", limit: 3, expiresAtEpochMs: 1720000000000 })),
      expected: '{"type":"set_network_error_simulation","enabled":true,"errorType":"timeout","limit":3,"expiresAtEpochMs":1720000000000}',
    },
    {
      builder: "setNetworkErrorSimulation",
      name: "disabled normalizes omitted fields to explicit nulls",
      actual: serializeCtrlProxyRequest(ctrlProxyRequests.setNetworkErrorSimulation({ enabled: false })),
      expected: '{"type":"set_network_error_simulation","enabled":false,"errorType":null,"limit":null,"expiresAtEpochMs":null}',
    },
    {
      builder: "requestInstalledPackages",
      name: "userId present",
      actual: serializeCtrlProxyRequest(ctrlProxyRequests.requestInstalledPackages({ requestId: "ip-1", includeSystem: true, userId: 0 })),
      expected: '{"type":"request_installed_packages","requestId":"ip-1","includeSystem":true,"userId":0}',
    },
    {
      builder: "requestInstalledPackages",
      name: "omitted userId normalized to explicit null",
      actual: serializeCtrlProxyRequest(ctrlProxyRequests.requestInstalledPackages({ requestId: "ip-2", includeSystem: false })),
      expected: '{"type":"request_installed_packages","requestId":"ip-2","includeSystem":false,"userId":null}',
    },
    {
      builder: "requestInstalledPackages",
      name: "negative userId (boundary) is sent verbatim",
      actual: serializeCtrlProxyRequest(ctrlProxyRequests.requestInstalledPackages({ requestId: "ip-neg", includeSystem: false, userId: -5 })),
      expected: '{"type":"request_installed_packages","requestId":"ip-neg","includeSystem":false,"userId":-5}',
    },
    {
      builder: "requestPackageInfo",
      name: "packageName + includePermissions",
      actual: serializeCtrlProxyRequest(ctrlProxyRequests.requestPackageInfo({ requestId: "pi-1", packageName: "com.x", includePermissions: true })),
      expected: '{"type":"request_package_info","requestId":"pi-1","packageName":"com.x","includePermissions":true}',
    },
    {
      builder: "requestLaunchIntent",
      name: "packageName",
      actual: serializeCtrlProxyRequest(ctrlProxyRequests.requestLaunchIntent({ requestId: "li-1", packageName: "com.x" })),
      expected: '{"type":"request_launch_intent","requestId":"li-1","packageName":"com.x"}',
    },
    {
      builder: "startRecording",
      name: "no requestId on the wire",
      actual: serializeCtrlProxyRequest(ctrlProxyRequests.startRecording()),
      expected: '{"type":"start_recording"}',
    },
    {
      builder: "stopRecording",
      name: "no requestId on the wire",
      actual: serializeCtrlProxyRequest(ctrlProxyRequests.stopRecording()),
      expected: '{"type":"stop_recording"}',
    },
  ];

  test.each(cases)("$builder — $name", ({ actual, expected }) => {
    expect(actual).toBe(expected);
  });

  // Completeness guard: every builder in the module must have at least one wire row above, and the
  // total builder count is pinned. Ship builder #38 without a row and this fails — not a silently
  // uncovered send site. `request_two_finger_swipe` has no builder here by design (it goes through
  // the shared sendCommand path, asserted in CtrlProxyGestures.test.ts), so it is not a builder key.
  test("every ctrlProxyRequests builder has wire coverage and the count is pinned at 37", () => {
    const builderNames = Object.keys(ctrlProxyRequests);
    expect(builderNames.length).toBe(37);
    const covered = new Set(cases.map(row => row.builder));
    expect([...covered].sort()).toEqual([...builderNames].sort());
  });
});
