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
  "request_screenshot",
  "request_tap_coordinates",
  "request_swipe",
  "request_two_finger_swipe",
  "request_drag",
  "request_pinch",
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

describe("ctrlProxyProtocol — builders serialize byte-identically", () => {
  test("request_hierarchy", () => {
    expect(serializeCtrlProxyRequest(ctrlProxyRequests.requestHierarchy({ requestId: "req-1", disableAllFiltering: false })))
      .toBe('{"type":"request_hierarchy","requestId":"req-1","disableAllFiltering":false}');
    expect(serializeCtrlProxyRequest(ctrlProxyRequests.requestHierarchy({ requestId: "req-2", disableAllFiltering: true })))
      .toBe('{"type":"request_hierarchy","requestId":"req-2","disableAllFiltering":true}');
  });

  test("request_hierarchy_if_stale", () => {
    expect(serializeCtrlProxyRequest(ctrlProxyRequests.requestHierarchyIfStale({ requestId: "stale-1", sinceTimestamp: 1720000000000 })))
      .toBe('{"type":"request_hierarchy_if_stale","requestId":"stale-1","sinceTimestamp":1720000000000}');
  });

  test("request_screenshot", () => {
    expect(serializeCtrlProxyRequest(ctrlProxyRequests.requestScreenshot({ requestId: "s-1" })))
      .toBe('{"type":"request_screenshot","requestId":"s-1"}');
  });

  // `request_two_finger_swipe` has no builder here: like the other gesture commands
  // (request_swipe/tap/drag/pinch), it is emitted through the shared sendCommand()/createMessage()
  // path (#2988), and its field-level wire shape is asserted in CtrlProxyGestures.test.ts. The type
  // stays in the union + KOTLIN_SERIAL_NAMES drift check above.

  test("request_action — resourceId included when present, omitted when undefined", () => {
    expect(serializeCtrlProxyRequest(ctrlProxyRequests.requestAction({ requestId: "a-1", action: "long_click", resourceId: "res" })))
      .toBe('{"type":"request_action","requestId":"a-1","action":"long_click","resourceId":"res"}');
    expect(serializeCtrlProxyRequest(ctrlProxyRequests.requestAction({ requestId: "a-2", action: "clear_focus" })))
      .toBe('{"type":"request_action","requestId":"a-2","action":"clear_focus"}');
  });

  test("request_clipboard — text included for copy, omitted when undefined", () => {
    expect(serializeCtrlProxyRequest(ctrlProxyRequests.requestClipboard({ requestId: "c-1", action: "copy", text: "hi" })))
      .toBe('{"type":"request_clipboard","requestId":"c-1","action":"copy","text":"hi"}');
    expect(serializeCtrlProxyRequest(ctrlProxyRequests.requestClipboard({ requestId: "c-2", action: "paste" })))
      .toBe('{"type":"request_clipboard","requestId":"c-2","action":"paste"}');
  });

  test("request_settings_get", () => {
    expect(serializeCtrlProxyRequest(ctrlProxyRequests.requestSettingsGet({ requestId: "sg-1", namespace: "system", key: "font_scale" })))
      .toBe('{"type":"request_settings_get","requestId":"sg-1","namespace":"system","key":"font_scale"}');
  });

  test("request_settings_put — value string and explicit null", () => {
    expect(serializeCtrlProxyRequest(ctrlProxyRequests.requestSettingsPut({ requestId: "sp-1", namespace: "secure", key: "k", value: "v", valueType: "string" })))
      .toBe('{"type":"request_settings_put","requestId":"sp-1","namespace":"secure","key":"k","value":"v","valueType":"string"}');
    expect(serializeCtrlProxyRequest(ctrlProxyRequests.requestSettingsPut({ requestId: "sp-2", namespace: "global", key: "k", value: null, valueType: "int" })))
      .toBe('{"type":"request_settings_put","requestId":"sp-2","namespace":"global","key":"k","value":null,"valueType":"int"}');
  });

  test("request_settings_list", () => {
    expect(serializeCtrlProxyRequest(ctrlProxyRequests.requestSettingsList({ requestId: "sl-1", namespace: "global" })))
      .toBe('{"type":"request_settings_list","requestId":"sl-1","namespace":"global"}');
  });

  test("install_ca_cert", () => {
    expect(serializeCtrlProxyRequest(ctrlProxyRequests.installCaCert({ requestId: "ca-1", certificate: "PEMDATA" })))
      .toBe('{"type":"install_ca_cert","requestId":"ca-1","certificate":"PEMDATA"}');
  });

  test("install_ca_cert_from_path", () => {
    expect(serializeCtrlProxyRequest(ctrlProxyRequests.installCaCertFromPath({ requestId: "ca-2", devicePath: "/sdcard/x.crt" })))
      .toBe('{"type":"install_ca_cert_from_path","requestId":"ca-2","devicePath":"/sdcard/x.crt"}');
  });

  test("remove_ca_cert", () => {
    expect(serializeCtrlProxyRequest(ctrlProxyRequests.removeCaCert({ requestId: "ca-3", alias: "user-alias" })))
      .toBe('{"type":"remove_ca_cert","requestId":"ca-3","alias":"user-alias"}');
  });

  test("get_device_owner_status", () => {
    expect(serializeCtrlProxyRequest(ctrlProxyRequests.getDeviceOwnerStatus({ requestId: "do-1" })))
      .toBe('{"type":"get_device_owner_status","requestId":"do-1"}');
  });

  test("get_permission", () => {
    expect(serializeCtrlProxyRequest(ctrlProxyRequests.getPermission({ requestId: "p-1", permission: "android.permission.CAMERA", requestPermission: true })))
      .toBe('{"type":"get_permission","requestId":"p-1","permission":"android.permission.CAMERA","requestPermission":true}');
  });

  test("request_device_info", () => {
    expect(serializeCtrlProxyRequest(ctrlProxyRequests.requestDeviceInfo({ requestId: "di-1" })))
      .toBe('{"type":"request_device_info","requestId":"di-1"}');
  });

  test("get_current_focus", () => {
    expect(serializeCtrlProxyRequest(ctrlProxyRequests.getCurrentFocus({ requestId: "cf-1" })))
      .toBe('{"type":"get_current_focus","requestId":"cf-1"}');
  });

  test("get_traversal_order", () => {
    expect(serializeCtrlProxyRequest(ctrlProxyRequests.getTraversalOrder({ requestId: "to-1" })))
      .toBe('{"type":"get_traversal_order","requestId":"to-1"}');
  });

  test("add_highlight — id/shape included, omitted, and mixed (independent guards)", () => {
    const shape: HighlightBoxShape = { type: "box", bounds: { x: 1, y: 2, width: 3, height: 4 } };
    const shapeJson = '{"type":"box","bounds":{"x":1,"y":2,"width":3,"height":4}}';
    // both present
    expect(serializeCtrlProxyRequest(ctrlProxyRequests.addHighlight({ requestId: "h-1", id: "hi", shape })))
      .toBe(`{"type":"add_highlight","requestId":"h-1","id":"hi","shape":${shapeJson}}`);
    // both absent
    expect(serializeCtrlProxyRequest(ctrlProxyRequests.addHighlight({ requestId: "h-2" })))
      .toBe('{"type":"add_highlight","requestId":"h-2"}');
    // id only (shape undefined) — guard must drop shape without disturbing key order
    expect(serializeCtrlProxyRequest(ctrlProxyRequests.addHighlight({ requestId: "h-3", id: "hi" })))
      .toBe('{"type":"add_highlight","requestId":"h-3","id":"hi"}');
    // shape only (id undefined)
    expect(serializeCtrlProxyRequest(ctrlProxyRequests.addHighlight({ requestId: "h-4", shape })))
      .toBe(`{"type":"add_highlight","requestId":"h-4","shape":${shapeJson}}`);
  });

  test("empty strings are sent (not omitted) — matches the unconditional legacy send", () => {
    // resourceId/text are assigned unconditionally by the builder, so "" serializes as "" (only
    // `undefined` is omitted). This mirrors the pre-migration JSON.stringify send sites.
    expect(serializeCtrlProxyRequest(ctrlProxyRequests.requestAction({ requestId: "a-3", action: "x", resourceId: "" })))
      .toBe('{"type":"request_action","requestId":"a-3","action":"x","resourceId":""}');
    expect(serializeCtrlProxyRequest(ctrlProxyRequests.requestClipboard({ requestId: "c-3", action: "copy", text: "" })))
      .toBe('{"type":"request_clipboard","requestId":"c-3","action":"copy","text":""}');
  });

  test("list_preference_files", () => {
    expect(serializeCtrlProxyRequest(ctrlProxyRequests.listPreferenceFiles({ requestId: "lp-1", packageName: "com.x" })))
      .toBe('{"type":"list_preference_files","requestId":"lp-1","packageName":"com.x"}');
  });

  test("get_preferences", () => {
    expect(serializeCtrlProxyRequest(ctrlProxyRequests.getPreferences({ requestId: "gp-1", packageName: "com.x", fileName: "prefs" })))
      .toBe('{"type":"get_preferences","requestId":"gp-1","packageName":"com.x","fileName":"prefs"}');
  });

  test("subscribe_storage", () => {
    expect(serializeCtrlProxyRequest(ctrlProxyRequests.subscribeStorage({ requestId: "ss-1", packageName: "com.x", fileName: "prefs" })))
      .toBe('{"type":"subscribe_storage","requestId":"ss-1","packageName":"com.x","fileName":"prefs"}');
  });

  test("unsubscribe_storage — latent-bug shape: only subscriptionId is sent", () => {
    expect(serializeCtrlProxyRequest(ctrlProxyRequests.unsubscribeStorage({ requestId: "us-1", subscriptionId: "com.x:prefs" })))
      .toBe('{"type":"unsubscribe_storage","requestId":"us-1","subscriptionId":"com.x:prefs"}');
  });

  test("get_preference", () => {
    expect(serializeCtrlProxyRequest(ctrlProxyRequests.getPreference({ requestId: "gpr-1", packageName: "com.x", fileName: "prefs", key: "k" })))
      .toBe('{"type":"get_preference","requestId":"gpr-1","packageName":"com.x","fileName":"prefs","key":"k"}');
  });

  test("set_preference — value string and explicit null", () => {
    expect(serializeCtrlProxyRequest(ctrlProxyRequests.setPreference({ requestId: "setp-1", packageName: "com.x", fileName: "prefs", key: "k", value: "v", valueType: "STRING" })))
      .toBe('{"type":"set_preference","requestId":"setp-1","packageName":"com.x","fileName":"prefs","key":"k","value":"v","valueType":"STRING"}');
    expect(serializeCtrlProxyRequest(ctrlProxyRequests.setPreference({ requestId: "setp-2", packageName: "com.x", fileName: "prefs", key: "k", value: null, valueType: "INT" })))
      .toBe('{"type":"set_preference","requestId":"setp-2","packageName":"com.x","fileName":"prefs","key":"k","value":null,"valueType":"INT"}');
  });

  test("remove_preference", () => {
    expect(serializeCtrlProxyRequest(ctrlProxyRequests.removePreference({ requestId: "rp-1", packageName: "com.x", fileName: "prefs", key: "k" })))
      .toBe('{"type":"remove_preference","requestId":"rp-1","packageName":"com.x","fileName":"prefs","key":"k"}');
  });

  test("clear_preferences", () => {
    expect(serializeCtrlProxyRequest(ctrlProxyRequests.clearPreferences({ requestId: "cp-1", packageName: "com.x", fileName: "prefs" })))
      .toBe('{"type":"clear_preferences","requestId":"cp-1","packageName":"com.x","fileName":"prefs"}');
  });

  test("request_global_action", () => {
    expect(serializeCtrlProxyRequest(ctrlProxyRequests.requestGlobalAction({ requestId: "ga-1", action: "back" })))
      .toBe('{"type":"request_global_action","requestId":"ga-1","action":"back"}');
  });

  test("set_recomposition_tracking", () => {
    expect(serializeCtrlProxyRequest(ctrlProxyRequests.setRecompositionTracking({ requestId: "rt-1", enabled: true })))
      .toBe('{"type":"set_recomposition_tracking","requestId":"rt-1","enabled":true}');
  });

  test("set_accessibility_flags — no requestId on the wire", () => {
    expect(serializeCtrlProxyRequest(ctrlProxyRequests.setAccessibilityFlags({
      includeNotImportantViews: true, reportViewIds: false, retrieveInteractiveWindows: true,
    }))).toBe('{"type":"set_accessibility_flags","includeNotImportantViews":true,"reportViewIds":false,"retrieveInteractiveWindows":true}');
  });

  test("set_network_mock_rules — no requestId, rules array passed through", () => {
    const rules: NetworkMockRuleSync[] = [{
      mockId: "m1", host: "example.com", path: "/v1", method: "GET",
      limit: null, remaining: null, statusCode: 200,
      responseHeaders: { "content-type": "application/json" },
      responseBody: "{}", contentType: "application/json",
    }];
    expect(serializeCtrlProxyRequest(ctrlProxyRequests.setNetworkMockRules({ rules })))
      .toBe('{"type":"set_network_mock_rules","rules":[{"mockId":"m1","host":"example.com","path":"/v1","method":"GET","limit":null,"remaining":null,"statusCode":200,"responseHeaders":{"content-type":"application/json"},"responseBody":"{}","contentType":"application/json"}]}');
  });

  test("set_network_error_simulation — enabled with values, disabled with explicit nulls", () => {
    expect(serializeCtrlProxyRequest(ctrlProxyRequests.setNetworkErrorSimulation({
      enabled: true, errorType: "timeout", limit: 3, expiresAtEpochMs: 1720000000000,
    }))).toBe('{"type":"set_network_error_simulation","enabled":true,"errorType":"timeout","limit":3,"expiresAtEpochMs":1720000000000}');
    // Mirrors the reconnect sync passing sim?.errorType (undefined) → normalized to explicit null.
    expect(serializeCtrlProxyRequest(ctrlProxyRequests.setNetworkErrorSimulation({ enabled: false })))
      .toBe('{"type":"set_network_error_simulation","enabled":false,"errorType":null,"limit":null,"expiresAtEpochMs":null}');
  });

  test("request_installed_packages — userId present vs. explicit null", () => {
    expect(serializeCtrlProxyRequest(ctrlProxyRequests.requestInstalledPackages({ requestId: "ip-1", includeSystem: true, userId: 0 })))
      .toBe('{"type":"request_installed_packages","requestId":"ip-1","includeSystem":true,"userId":0}');
    expect(serializeCtrlProxyRequest(ctrlProxyRequests.requestInstalledPackages({ requestId: "ip-2", includeSystem: false })))
      .toBe('{"type":"request_installed_packages","requestId":"ip-2","includeSystem":false,"userId":null}');
  });

  test("request_package_info", () => {
    expect(serializeCtrlProxyRequest(ctrlProxyRequests.requestPackageInfo({ requestId: "pi-1", packageName: "com.x", includePermissions: true })))
      .toBe('{"type":"request_package_info","requestId":"pi-1","packageName":"com.x","includePermissions":true}');
  });

  test("request_launch_intent", () => {
    expect(serializeCtrlProxyRequest(ctrlProxyRequests.requestLaunchIntent({ requestId: "li-1", packageName: "com.x" })))
      .toBe('{"type":"request_launch_intent","requestId":"li-1","packageName":"com.x"}');
  });

  test("start_recording / stop_recording — no requestId on the wire", () => {
    expect(serializeCtrlProxyRequest(ctrlProxyRequests.startRecording())).toBe('{"type":"start_recording"}');
    expect(serializeCtrlProxyRequest(ctrlProxyRequests.stopRecording())).toBe('{"type":"stop_recording"}');
  });
});
