/**
 * Byte-for-byte contract tests for the typed Android control-proxy request layer.
 *
 * Kotlin descriptor fixture parity is guarded by AndroidWireContract.contract.test.ts.
 * Each builder must serialize to the exact JSON the device's Kotlin sealed hierarchy
 * (`android/protocol/.../WebSocketRequest.kt`) expects — the strings asserted here mirror the
 * pre-migration hand-built `JSON.stringify(...)` send sites, so a drift in field name, order,
 * optionality, or null-vs-omitted handling fails a test rather than silently breaking the wire.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { HighlightShape } from "../../../../src/models/VisualHighlight";
import type { NetworkMockRuleSync } from "../../../../src/server/networkMockRules";
import {
  SAVED_PROTOTYPE_ERROR_CODES,
  isSavedPrototypeErrorCode,
  ctrlProxyRequests,
  serializeCtrlProxyRequest,
  KNOWN_REQUEST_TYPES,
  ANDROID_CAPABILITY_GATED_COMMANDS,
  ANDROID_CAPABILITY_REQUEST_TYPES,
  type CtrlProxyRequest,
  normalizeCtrlProxyMilliseconds,
} from "../../../../src/features/observe/android/ctrlProxyProtocol";

// Kotlin's serializer-generated contract; loaded once for all builder rows.
const wireContract = JSON.parse(
  readFileSync(
    join(import.meta.dir, "../../../fixtures/android-contract/android-wire-contract.json"),
    "utf8",
  ),
) as { requests: { serialName: string; fields: { name: string; hasDefault: boolean }[] }[] };

describe("IME commit budget serialization", () => {
  test("includes the optional budget and preserves legacy omission", () => {
    const request: CtrlProxyRequest = {
      type: "request_commit_text",
      requestId: "commit-1",
      text: "long text",
      timeoutMs: 14_500,
    };
    expect(serializeCtrlProxyRequest(request)).toBe(
      '{"type":"request_commit_text","requestId":"commit-1","text":"long text","timeoutMs":14500}',
    );
    expect(
      serializeCtrlProxyRequest({
        type: "request_commit_text",
        requestId: "commit-1",
        text: "long text",
      }),
    ).toBe('{"type":"request_commit_text","requestId":"commit-1","text":"long text"}');
  });
});

test("clearField serializes as a protocol delivery without a text sentinel", () => {
  expect(
    serializeCtrlProxyRequest({
      type: "request_commit_text",
      requestId: "clear-1",
      text: "",
      delivery: "clearField",
    }),
  ).toBe('{"type":"request_commit_text","requestId":"clear-1","text":"","delivery":"clearField"}');
});

describe("Android millisecond serialization", () => {
  const gestures = (value: number): CtrlProxyRequest[] => [
    { type: "request_tap_coordinates", requestId: "ms", x: 1.5, y: 2.5, duration: value },
    { type: "request_swipe", requestId: "ms", x1: 1.5, y1: 2.5, x2: 3.5, y2: 4.5, duration: value },
    {
      type: "request_two_finger_swipe",
      requestId: "ms",
      x1: 1.5,
      y1: 2.5,
      x2: 3.5,
      y2: 4.5,
      duration: value,
      offset: 80,
    },
    {
      type: "request_drag",
      requestId: "ms",
      x1: 1.5,
      y1: 2.5,
      x2: 3.5,
      y2: 4.5,
      pressDurationMs: value,
      dragDurationMs: value,
      holdDurationMs: value,
    },
    {
      type: "request_pinch",
      requestId: "ms",
      centerX: 1.5,
      centerY: 2.5,
      distanceStart: 3.5,
      distanceEnd: 4.5,
      rotationDegrees: 15.5,
      duration: value,
    },
  ];
  test.each([
    [250.5, 251, 251],
    [250.49, 250, 250],
    [250, 250, 250],
    [0.1, 1, 1],
    [0, 1, 0],
  ] as const)(
    "%s milliseconds serializes as %s for strokes and %s for drag",
    (value, strokeExpected, dragExpected) => {
      for (const request of gestures(value)) {
        const normalized = { ...request };
        for (const field of [
          "duration",
          "pressDurationMs",
          "dragDurationMs",
          "holdDurationMs",
        ] as const) {
          if (field in normalized) {
            Object.assign(normalized, {
              [field]: request.type === "request_drag" ? dragExpected : strokeExpected,
            });
          }
        }
        expect(serializeCtrlProxyRequest(request)).toBe(JSON.stringify(normalized));
      }
    },
  );
  test("normalizes double-tap strokes while preserving the doubleTap flag", () => {
    expect(
      normalizeCtrlProxyMilliseconds("request_tap_coordinates", { doubleTap: true, duration: 0 }),
    ).toEqual({ doubleTap: true, duration: 1 });
    expect(
      normalizeCtrlProxyMilliseconds("request_tap_coordinates", {
        doubleTap: true,
        duration: 49.6,
      }),
    ).toEqual({ doubleTap: true, duration: 50 });
  });

  test("preserves absent fields, drops undefined on serialization and rounds legacy drag durations", () => {
    const params = { x1: 1.5, holdTime: 250.5, duration: 0.1, holdDurationMs: undefined };
    expect(JSON.stringify(normalizeCtrlProxyMilliseconds("request_drag", params))).toBe(
      '{"x1":1.5,"holdTime":251,"duration":1}',
    );
    expect(normalizeCtrlProxyMilliseconds("request_drag", {})).toEqual({});
    expect(normalizeCtrlProxyMilliseconds("request_drag", { holdTime: 0, duration: 0 })).toEqual({
      holdTime: 0,
      duration: 0,
    });
    expect(params.holdTime).toBe(250.5);
    expect(
      normalizeCtrlProxyMilliseconds("request_set_text", { text: "250.5", duration: 250.5 }),
    ).toEqual({ text: "250.5", duration: 250.5 });
  });
  test("rounds hierarchy intervals while preserving timestamps and explicit null", () => {
    expect(serializeCtrlProxyRequest({ type: "set_hierarchy_interval", intervalMs: 250.5 })).toBe(
      '{"type":"set_hierarchy_interval","intervalMs":251}',
    );
    expect(serializeCtrlProxyRequest({ type: "set_hierarchy_interval", intervalMs: null })).toBe(
      '{"type":"set_hierarchy_interval","intervalMs":null}',
    );
    expect(serializeCtrlProxyRequest({ type: "set_hierarchy_interval", intervalMs: 0 })).toBe(
      '{"type":"set_hierarchy_interval","intervalMs":0}',
    );
    const timestamp: CtrlProxyRequest = {
      type: "request_hierarchy_if_stale",
      requestId: "ms",
      sinceTimestamp: 250.5,
    };
    expect(serializeCtrlProxyRequest(timestamp)).toBe(JSON.stringify(timestamp));
  });
});

test("Keystore discovery is an optional advertised Android capability", () => {
  expect(ANDROID_CAPABILITY_REQUEST_TYPES).toContain("discover_keystore");
  expect(ANDROID_CAPABILITY_GATED_COMMANDS.has("discover_keystore")).toBe(true);
});

describe("ctrlProxyProtocol — discriminator uniqueness", () => {
  test("no duplicate discriminators", () => {
    expect(new Set(KNOWN_REQUEST_TYPES).size).toBe(KNOWN_REQUEST_TYPES.length);
  });
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
  const shape: HighlightShape = { type: "circle", bounds: { x: 1, y: 2, width: 3, height: 4 } };
  const shapeJson = '{"type":"circle","bounds":{"x":1,"y":2,"width":3,"height":4}}';
  const longCert = "A".repeat(4096);
  const networkRules: NetworkMockRuleSync[] = [
    {
      mockId: "m1",
      host: "example.com",
      path: "/v1",
      method: "GET",
      limit: null,
      remaining: null,
      statusCode: 200,
      responseHeaders: { "content-type": "application/json" },
      responseBody: "{}",
      contentType: "application/json",
    },
  ];

  interface BuilderCase {
    builder: keyof typeof ctrlProxyRequests;
    name: string;
    actual: string;
    expected: string;
  }

  const prototypeSpec = {
    id: "panel",
    window: { placement: { type: "fullscreen" as const }, opacity: 90 },
    root: { type: "text" as const, text: "Hello" },
  };
  const cases: BuilderCase[] = [
    {
      builder: "showPrototype",
      name: "nested typed spec (shared Kotlin literal)",
      actual: serializeCtrlProxyRequest(
        ctrlProxyRequests.showPrototype({ requestId: "r1", spec: prototypeSpec }),
      ),
      expected:
        '{"type":"show_prototype","requestId":"r1","spec":{"id":"panel","window":{"placement":{"type":"fullscreen"},"opacity":90},"root":{"type":"text","text":"Hello"}}}',
    },
    {
      builder: "showPrototype",
      name: "explicit displayId (shared Kotlin literal)",
      actual: serializeCtrlProxyRequest(
        ctrlProxyRequests.showPrototype({ requestId: "r1", spec: prototypeSpec, displayId: 2 }),
      ),
      expected:
        '{"type":"show_prototype","requestId":"r1","spec":{"id":"panel","window":{"placement":{"type":"fullscreen"},"opacity":90},"root":{"type":"text","text":"Hello"}},"displayId":2}',
    },
    {
      builder: "showPrototype",
      name: "reset (shared Kotlin literal)",
      actual: serializeCtrlProxyRequest(
        ctrlProxyRequests.showPrototype({ requestId: "r2", spec: prototypeSpec, reset: true }),
      ),
      expected:
        '{"type":"show_prototype","requestId":"r2","spec":{"id":"panel","window":{"placement":{"type":"fullscreen"},"opacity":90},"root":{"type":"text","text":"Hello"}},"reset":true}',
    },
    {
      builder: "showPrototype",
      name: "reset false sends nothing",
      actual: serializeCtrlProxyRequest(
        ctrlProxyRequests.showPrototype({ requestId: "r1", spec: prototypeSpec, reset: false }),
      ),
      expected:
        '{"type":"show_prototype","requestId":"r1","spec":{"id":"panel","window":{"placement":{"type":"fullscreen"},"opacity":90},"root":{"type":"text","text":"Hello"}}}',
    },
    {
      builder: "dismissPrototype",
      name: "one prototype (shared Kotlin literal)",
      actual: serializeCtrlProxyRequest(
        ctrlProxyRequests.dismissPrototype({ requestId: "r4", id: "panel" }),
      ),
      expected: '{"type":"dismiss_prototype","requestId":"r4","id":"panel"}',
    },
    {
      builder: "dismissPrototype",
      name: "all prototypes (shared Kotlin literal)",
      actual: serializeCtrlProxyRequest(
        ctrlProxyRequests.dismissPrototype({ requestId: "r5", all: true }),
      ),
      expected: '{"type":"dismiss_prototype","requestId":"r5","all":true}',
    },
    {
      builder: "inspectPrototypes",
      name: "inspect (shared Kotlin literal)",
      actual: serializeCtrlProxyRequest(ctrlProxyRequests.inspectPrototypes({ requestId: "r8" })),
      expected: '{"type":"inspect_prototypes","requestId":"r8"}',
    },
    {
      builder: "savePrototype",
      name: "save omitted icon",
      actual: serializeCtrlProxyRequest(
        ctrlProxyRequests.savePrototype({
          requestId: "r10",
          spec: prototypeSpec,
          label: "Panel",
          icon: undefined,
        }),
      ),
      expected:
        '{"type":"save_prototype","requestId":"r10","spec":{"id":"panel","window":{"placement":{"type":"fullscreen"},"opacity":90},"root":{"type":"text","text":"Hello"}},"label":"Panel"}',
    },
    {
      builder: "savePrototype",
      name: "save with icon",
      actual: serializeCtrlProxyRequest(
        ctrlProxyRequests.savePrototype({
          requestId: "r10",
          spec: prototypeSpec,
          label: "Panel",
          icon: "hero",
        }),
      ),
      expected:
        '{"type":"save_prototype","requestId":"r10","spec":{"id":"panel","window":{"placement":{"type":"fullscreen"},"opacity":90},"root":{"type":"text","text":"Hello"}},"label":"Panel","icon":"hero"}',
    },
    {
      builder: "listSavedPrototypes",
      name: "list saved",
      actual: serializeCtrlProxyRequest(
        ctrlProxyRequests.listSavedPrototypes({ requestId: "r11" }),
      ),
      expected: '{"type":"list_saved_prototypes","requestId":"r11"}',
    },
    {
      builder: "pinSavedPrototype",
      name: "saved id and icon",
      actual: serializeCtrlProxyRequest(
        ctrlProxyRequests.pinSavedPrototype({ requestId: "pin", id: "panel", icon: "hero" }),
      ),
      expected: '{"type":"pin_saved_prototype","requestId":"pin","id":"panel","icon":"hero"}',
    },
    {
      builder: "deleteSavedPrototype",
      name: "delete saved",
      actual: serializeCtrlProxyRequest(
        ctrlProxyRequests.deleteSavedPrototype({ requestId: "r12", id: "panel" }),
      ),
      expected: '{"type":"delete_saved_prototype","requestId":"r12","id":"panel"}',
    },
    {
      builder: "patchPrototype",
      name: "patch (shared Kotlin literal)",
      actual: serializeCtrlProxyRequest(
        ctrlProxyRequests.patchPrototype({
          requestId: "r9",
          id: "orders",
          baseRevision: 12,
          ops: [{ op: "replace", path: "/data/cartCount", value: 2 }],
        }),
      ),
      expected:
        '{"type":"patch_prototype","requestId":"r9","id":"orders","baseRevision":12,"ops":[{"op":"replace","path":"/data/cartCount","value":2}]}',
    },
    {
      builder: "putPrototypeAsset",
      name: "upload (shared Kotlin literal)",
      actual: serializeCtrlProxyRequest(
        ctrlProxyRequests.putPrototypeAsset({
          requestId: "r6",
          id: "hero",
          mimeType: "image/png",
          dataBase64: "iVBORw0KGgo=",
        }),
      ),
      expected:
        '{"type":"put_prototype_asset","requestId":"r6","id":"hero","mimeType":"image/png","dataBase64":"iVBORw0KGgo="}',
    },
    {
      builder: "removePrototypeAsset",
      name: "removal (shared Kotlin literal)",
      actual: serializeCtrlProxyRequest(
        ctrlProxyRequests.removePrototypeAsset({ requestId: "r7", id: "hero" }),
      ),
      expected: '{"type":"remove_prototype_asset","requestId":"r7","id":"hero"}',
    },

    {
      builder: "requestHierarchy",
      name: "disableAllFiltering false",
      actual: serializeCtrlProxyRequest(
        ctrlProxyRequests.requestHierarchy({ requestId: "req-1", disableAllFiltering: false }),
      ),
      expected: '{"type":"request_hierarchy","requestId":"req-1","disableAllFiltering":false}',
    },
    {
      builder: "requestHierarchy",
      name: "disableAllFiltering true",
      actual: serializeCtrlProxyRequest(
        ctrlProxyRequests.requestHierarchy({ requestId: "req-2", disableAllFiltering: true }),
      ),
      expected: '{"type":"request_hierarchy","requestId":"req-2","disableAllFiltering":true}',
    },
    {
      builder: "requestHierarchyIfStale",
      name: "positive sinceTimestamp",
      actual: serializeCtrlProxyRequest(
        ctrlProxyRequests.requestHierarchyIfStale({
          requestId: "stale-1",
          sinceTimestamp: 1720000000000,
        }),
      ),
      expected:
        '{"type":"request_hierarchy_if_stale","requestId":"stale-1","sinceTimestamp":1720000000000}',
    },
    {
      builder: "requestHierarchyIfStale",
      name: "negative sinceTimestamp (boundary) is sent verbatim",
      actual: serializeCtrlProxyRequest(
        ctrlProxyRequests.requestHierarchyIfStale({ requestId: "stale-neg", sinceTimestamp: -1 }),
      ),
      expected: '{"type":"request_hierarchy_if_stale","requestId":"stale-neg","sinceTimestamp":-1}',
    },
    {
      builder: "setHierarchyInterval",
      name: "numeric interval",
      actual: serializeCtrlProxyRequest(
        ctrlProxyRequests.setHierarchyInterval({ intervalMs: 500 }),
      ),
      expected: '{"type":"set_hierarchy_interval","intervalMs":500}',
    },
    {
      builder: "setHierarchyInterval",
      name: "explicit null interval is kept (not omitted)",
      actual: serializeCtrlProxyRequest(
        ctrlProxyRequests.setHierarchyInterval({ intervalMs: null }),
      ),
      expected: '{"type":"set_hierarchy_interval","intervalMs":null}',
    },
    {
      builder: "setHierarchyInterval",
      name: "non-finite interval (boundary) serializes to null per JSON.stringify",
      actual: serializeCtrlProxyRequest(
        ctrlProxyRequests.setHierarchyInterval({ intervalMs: Number.POSITIVE_INFINITY }),
      ),
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
      actual: serializeCtrlProxyRequest(
        ctrlProxyRequests.requestAction({
          requestId: "a-1",
          action: "long_click",
          resourceId: "res",
        }),
      ),
      expected:
        '{"type":"request_action","requestId":"a-1","action":"long_click","resourceId":"res"}',
    },
    {
      builder: "requestAction",
      name: "resourceId omitted when undefined",
      actual: serializeCtrlProxyRequest(
        ctrlProxyRequests.requestAction({ requestId: "a-2", action: "clear_focus" }),
      ),
      expected: '{"type":"request_action","requestId":"a-2","action":"clear_focus"}',
    },
    {
      builder: "requestAction",
      name: "empty-string resourceId (boundary) is sent, not omitted",
      actual: serializeCtrlProxyRequest(
        ctrlProxyRequests.requestAction({ requestId: "a-empty", action: "x", resourceId: "" }),
      ),
      expected: '{"type":"request_action","requestId":"a-empty","action":"x","resourceId":""}',
    },
    {
      builder: "requestAction",
      name: "stable node selector carried alongside the legacy resource id",
      actual: serializeCtrlProxyRequest(
        ctrlProxyRequests.requestAction({
          requestId: "a-3",
          action: "long_click",
          resourceId: "com.example:id/row",
          selector: {
            resourceId: "com.example:id/row",
            testTag: "message_row_42",
            collectionRow: 4,
            collectionColumn: 0,
          },
        }),
      ),
      expected:
        '{"type":"request_action","requestId":"a-3","action":"long_click","resourceId":"com.example:id/row","selector":{"resourceId":"com.example:id/row","testTag":"message_row_42","collectionRow":4,"collectionColumn":0}}',
    },
    {
      builder: "requestActivateAccessibilityLink",
      name: "semantic link activation retains exact text, occurrence, and stable owner selector",
      actual: serializeCtrlProxyRequest(
        ctrlProxyRequests.requestActivateAccessibilityLink({
          requestId: "link-1",
          text: "Terms of Service",
          occurrence: 1,
          selector: { resourceId: "com.example:id/legal" },
        }),
      ),
      expected:
        '{"type":"request_activate_accessibility_link","requestId":"link-1","text":"Terms of Service","occurrence":1,"selector":{"resourceId":"com.example:id/legal"}}',
    },
    {
      builder: "requestActivateAccessibilityLink",
      name: "semantic link activation carries a Compose test-tag owner selector",
      actual: serializeCtrlProxyRequest(
        ctrlProxyRequests.requestActivateAccessibilityLink({
          requestId: "link-2",
          text: "Privacy Policy",
          occurrence: 0,
          selector: { testTag: "legal-copy" },
        }),
      ),
      expected:
        '{"type":"request_activate_accessibility_link","requestId":"link-2","text":"Privacy Policy","occurrence":0,"selector":{"testTag":"legal-copy"}}',
    },
    {
      builder: "requestClipboard",
      name: "text included for copy",
      actual: serializeCtrlProxyRequest(
        ctrlProxyRequests.requestClipboard({ requestId: "c-1", action: "copy", text: "hi" }),
      ),
      expected: '{"type":"request_clipboard","requestId":"c-1","action":"copy","text":"hi"}',
    },
    {
      builder: "requestClipboard",
      name: "text omitted for paste",
      actual: serializeCtrlProxyRequest(
        ctrlProxyRequests.requestClipboard({ requestId: "c-2", action: "paste" }),
      ),
      expected: '{"type":"request_clipboard","requestId":"c-2","action":"paste"}',
    },
    {
      builder: "requestClipboard",
      name: "empty-string text (boundary) is sent",
      actual: serializeCtrlProxyRequest(
        ctrlProxyRequests.requestClipboard({ requestId: "c-3", action: "copy", text: "" }),
      ),
      expected: '{"type":"request_clipboard","requestId":"c-3","action":"copy","text":""}',
    },
    {
      builder: "requestClipboard",
      name: "unicode text (boundary) is sent unescaped",
      actual: serializeCtrlProxyRequest(
        ctrlProxyRequests.requestClipboard({
          requestId: "c-u",
          action: "copy",
          text: "café ☕ 日本語",
        }),
      ),
      expected:
        '{"type":"request_clipboard","requestId":"c-u","action":"copy","text":"café ☕ 日本語"}',
    },
    {
      builder: "requestSettingsGet",
      name: "namespace + key",
      actual: serializeCtrlProxyRequest(
        ctrlProxyRequests.requestSettingsGet({
          requestId: "sg-1",
          namespace: "system",
          key: "font_scale",
        }),
      ),
      expected:
        '{"type":"request_settings_get","requestId":"sg-1","namespace":"system","key":"font_scale"}',
    },
    {
      builder: "requestSettingsPut",
      name: "string value",
      actual: serializeCtrlProxyRequest(
        ctrlProxyRequests.requestSettingsPut({
          requestId: "sp-1",
          namespace: "secure",
          key: "k",
          value: "v",
          valueType: "string",
        }),
      ),
      expected:
        '{"type":"request_settings_put","requestId":"sp-1","namespace":"secure","key":"k","value":"v","valueType":"string"}',
    },
    {
      builder: "requestSettingsPut",
      name: "explicit null value is kept",
      actual: serializeCtrlProxyRequest(
        ctrlProxyRequests.requestSettingsPut({
          requestId: "sp-2",
          namespace: "global",
          key: "k",
          value: null,
          valueType: "int",
        }),
      ),
      expected:
        '{"type":"request_settings_put","requestId":"sp-2","namespace":"global","key":"k","value":null,"valueType":"int"}',
    },
    {
      builder: "requestSettingsList",
      name: "namespace",
      actual: serializeCtrlProxyRequest(
        ctrlProxyRequests.requestSettingsList({ requestId: "sl-1", namespace: "global" }),
      ),
      expected: '{"type":"request_settings_list","requestId":"sl-1","namespace":"global"}',
    },
    {
      builder: "installCaCert",
      name: "certificate payload",
      actual: serializeCtrlProxyRequest(
        ctrlProxyRequests.installCaCert({ requestId: "ca-1", certificate: "PEMDATA" }),
      ),
      expected: '{"type":"install_ca_cert","requestId":"ca-1","certificate":"PEMDATA"}',
    },
    {
      builder: "installCaCert",
      name: "very-long certificate (boundary) is sent verbatim",
      actual: serializeCtrlProxyRequest(
        ctrlProxyRequests.installCaCert({ requestId: "ca-long", certificate: longCert }),
      ),
      expected: `{"type":"install_ca_cert","requestId":"ca-long","certificate":"${longCert}"}`,
    },
    {
      builder: "installCaCertFromPath",
      name: "device path",
      actual: serializeCtrlProxyRequest(
        ctrlProxyRequests.installCaCertFromPath({ requestId: "ca-2", devicePath: "/sdcard/x.crt" }),
      ),
      expected:
        '{"type":"install_ca_cert_from_path","requestId":"ca-2","devicePath":"/sdcard/x.crt"}',
    },
    {
      builder: "removeCaCert",
      name: "alias",
      actual: serializeCtrlProxyRequest(
        ctrlProxyRequests.removeCaCert({ requestId: "ca-3", alias: "user-alias" }),
      ),
      expected: '{"type":"remove_ca_cert","requestId":"ca-3","alias":"user-alias"}',
    },
    {
      builder: "getDeviceOwnerStatus",
      name: "requestId only",
      actual: serializeCtrlProxyRequest(
        ctrlProxyRequests.getDeviceOwnerStatus({ requestId: "do-1" }),
      ),
      expected: '{"type":"get_device_owner_status","requestId":"do-1"}',
    },
    {
      builder: "getPermission",
      name: "permission + requestPermission",
      actual: serializeCtrlProxyRequest(
        ctrlProxyRequests.getPermission({
          requestId: "p-1",
          permission: "android.permission.CAMERA",
          requestPermission: true,
        }),
      ),
      expected:
        '{"type":"get_permission","requestId":"p-1","permission":"android.permission.CAMERA","requestPermission":true}',
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
      actual: serializeCtrlProxyRequest(
        ctrlProxyRequests.addHighlight({ requestId: "h-1", id: "hi", shape }),
      ),
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
      actual: serializeCtrlProxyRequest(
        ctrlProxyRequests.addHighlight({ requestId: "h-3", id: "hi" }),
      ),
      expected: '{"type":"add_highlight","requestId":"h-3","id":"hi"}',
    },
    {
      builder: "addHighlight",
      name: "shape only",
      actual: serializeCtrlProxyRequest(
        ctrlProxyRequests.addHighlight({ requestId: "h-4", shape }),
      ),
      expected: `{"type":"add_highlight","requestId":"h-4","shape":${shapeJson}}`,
    },
    {
      builder: "listPreferenceFiles",
      name: "packageName",
      actual: serializeCtrlProxyRequest(
        ctrlProxyRequests.listPreferenceFiles({ requestId: "lp-1", packageName: "com.x" }),
      ),
      expected: '{"type":"list_preference_files","requestId":"lp-1","packageName":"com.x"}',
    },
    {
      builder: "getPreferences",
      name: "packageName + fileName",
      actual: serializeCtrlProxyRequest(
        ctrlProxyRequests.getPreferences({
          requestId: "gp-1",
          packageName: "com.x",
          fileName: "prefs",
        }),
      ),
      expected:
        '{"type":"get_preferences","requestId":"gp-1","packageName":"com.x","fileName":"prefs"}',
    },
    {
      builder: "discoverKeystore",
      name: "app-owned metadata capability discovery",
      actual: serializeCtrlProxyRequest(
        ctrlProxyRequests.discoverKeystore({ requestId: "ks-1", packageName: "com.x" }),
      ),
      expected: '{"type":"discover_keystore","requestId":"ks-1","packageName":"com.x"}',
    },
    {
      builder: "getSdkCapabilities",
      name: "SDK capability and capture-policy snapshot",
      actual: serializeCtrlProxyRequest(
        ctrlProxyRequests.getSdkCapabilities({ requestId: "sc-1", packageName: "com.x" }),
      ),
      expected: '{"type":"get_sdk_capabilities","requestId":"sc-1","packageName":"com.x"}',
    },
    {
      builder: "getSdkCapabilities",
      name: "SDK capability snapshot for another Android user",
      actual: serializeCtrlProxyRequest(
        ctrlProxyRequests.getSdkCapabilities({
          requestId: "sc-2",
          packageName: "com.x",
          userId: 10,
        }),
      ),
      expected:
        '{"type":"get_sdk_capabilities","requestId":"sc-2","packageName":"com.x","userId":10}',
    },
    {
      builder: "listDataStores",
      name: "packageName + adapterName",
      actual: serializeCtrlProxyRequest(
        ctrlProxyRequests.listDataStores({
          requestId: "lds-1",
          packageName: "com.x",
          adapterName: "settings",
        }),
      ),
      expected:
        '{"type":"list_data_stores","requestId":"lds-1","packageName":"com.x","adapterName":"settings"}',
    },
    {
      builder: "getDataStore",
      name: "packageName + adapterName + storeName",
      actual: serializeCtrlProxyRequest(
        ctrlProxyRequests.getDataStore({
          requestId: "gds-1",
          packageName: "com.x",
          adapterName: "settings",
          storeName: "user",
        }),
      ),
      expected:
        '{"type":"get_data_store","requestId":"gds-1","packageName":"com.x","adapterName":"settings","storeName":"user"}',
    },
    {
      builder: "subscribeStorage",
      name: "packageName + fileName",
      actual: serializeCtrlProxyRequest(
        ctrlProxyRequests.subscribeStorage({
          requestId: "ss-1",
          packageName: "com.x",
          fileName: "prefs",
        }),
      ),
      expected:
        '{"type":"subscribe_storage","requestId":"ss-1","packageName":"com.x","fileName":"prefs"}',
    },
    {
      builder: "unsubscribeStorage",
      name: "latent-bug shape: only subscriptionId is sent",
      actual: serializeCtrlProxyRequest(
        ctrlProxyRequests.unsubscribeStorage({ requestId: "us-1", subscriptionId: "com.x:prefs" }),
      ),
      expected: '{"type":"unsubscribe_storage","requestId":"us-1","subscriptionId":"com.x:prefs"}',
    },
    {
      builder: "getPreference",
      name: "packageName + fileName + key",
      actual: serializeCtrlProxyRequest(
        ctrlProxyRequests.getPreference({
          requestId: "gpr-1",
          packageName: "com.x",
          fileName: "prefs",
          key: "k",
        }),
      ),
      expected:
        '{"type":"get_preference","requestId":"gpr-1","packageName":"com.x","fileName":"prefs","key":"k"}',
    },
    {
      builder: "setPreference",
      name: "string value",
      actual: serializeCtrlProxyRequest(
        ctrlProxyRequests.setPreference({
          requestId: "setp-1",
          packageName: "com.x",
          fileName: "prefs",
          key: "k",
          value: "v",
          valueType: "STRING",
        }),
      ),
      expected:
        '{"type":"set_preference","requestId":"setp-1","packageName":"com.x","fileName":"prefs","key":"k","value":"v","valueType":"STRING"}',
    },
    {
      builder: "setPreference",
      name: "explicit null value is kept",
      actual: serializeCtrlProxyRequest(
        ctrlProxyRequests.setPreference({
          requestId: "setp-2",
          packageName: "com.x",
          fileName: "prefs",
          key: "k",
          value: null,
          valueType: "INT",
        }),
      ),
      expected:
        '{"type":"set_preference","requestId":"setp-2","packageName":"com.x","fileName":"prefs","key":"k","value":null,"valueType":"INT"}',
    },
    {
      builder: "removePreference",
      name: "packageName + fileName + key",
      actual: serializeCtrlProxyRequest(
        ctrlProxyRequests.removePreference({
          requestId: "rp-1",
          packageName: "com.x",
          fileName: "prefs",
          key: "k",
        }),
      ),
      expected:
        '{"type":"remove_preference","requestId":"rp-1","packageName":"com.x","fileName":"prefs","key":"k"}',
    },
    {
      builder: "clearPreferences",
      name: "packageName + fileName",
      actual: serializeCtrlProxyRequest(
        ctrlProxyRequests.clearPreferences({
          requestId: "cp-1",
          packageName: "com.x",
          fileName: "prefs",
        }),
      ),
      expected:
        '{"type":"clear_preferences","requestId":"cp-1","packageName":"com.x","fileName":"prefs"}',
    },
    {
      builder: "requestGlobalAction",
      name: "action",
      actual: serializeCtrlProxyRequest(
        ctrlProxyRequests.requestGlobalAction({ requestId: "ga-1", action: "back" }),
      ),
      expected: '{"type":"request_global_action","requestId":"ga-1","action":"back"}',
    },
    {
      builder: "validateFrameContext",
      name: "frame context",
      actual: serializeCtrlProxyRequest(
        ctrlProxyRequests.validateFrameContext({ requestId: "fc-1", frameContext: "epoch:5" }),
      ),
      expected: '{"type":"validate_frame_context","requestId":"fc-1","frameContext":"epoch:5"}',
    },
    {
      builder: "setRecompositionTracking",
      name: "enabled flag",
      actual: serializeCtrlProxyRequest(
        ctrlProxyRequests.setRecompositionTracking({ requestId: "rt-1", enabled: true }),
      ),
      expected: '{"type":"set_recomposition_tracking","requestId":"rt-1","enabled":true}',
    },
    {
      builder: "setAccessibilityFlags",
      name: "no requestId on the wire",
      actual: serializeCtrlProxyRequest(
        ctrlProxyRequests.setAccessibilityFlags({
          includeNotImportantViews: true,
          reportViewIds: false,
          retrieveInteractiveWindows: true,
          occlusionEnabled: false,
        }),
      ),
      expected:
        '{"type":"set_accessibility_flags","includeNotImportantViews":true,"reportViewIds":false,"retrieveInteractiveWindows":true,"occlusionEnabled":false}',
    },
    {
      builder: "setNetworkMockRules",
      name: "no requestId, rules array passed through",
      actual: serializeCtrlProxyRequest(
        ctrlProxyRequests.setNetworkMockRules({ rules: networkRules }),
      ),
      expected:
        '{"type":"set_network_mock_rules","rules":[{"mockId":"m1","host":"example.com","path":"/v1","method":"GET","limit":null,"remaining":null,"statusCode":200,"responseHeaders":{"content-type":"application/json"},"responseBody":"{}","contentType":"application/json"}]}',
    },
    {
      builder: "setNetworkErrorSimulation",
      name: "enabled with values",
      actual: serializeCtrlProxyRequest(
        ctrlProxyRequests.setNetworkErrorSimulation({
          enabled: true,
          errorType: "timeout",
          limit: 3,
          expiresAtEpochMs: 1720000000000,
          remainingMs: 30000,
        }),
      ),
      expected:
        '{"type":"set_network_error_simulation","enabled":true,"errorType":"timeout","limit":3,"expiresAtEpochMs":1720000000000,"remainingMs":30000}',
    },
    {
      builder: "setNetworkErrorSimulation",
      name: "disabled normalizes omitted fields to explicit nulls",
      actual: serializeCtrlProxyRequest(
        ctrlProxyRequests.setNetworkErrorSimulation({ enabled: false }),
      ),
      expected:
        '{"type":"set_network_error_simulation","enabled":false,"errorType":null,"limit":null,"expiresAtEpochMs":null,"remainingMs":null}',
    },
    {
      builder: "requestInstalledPackages",
      name: "userId present",
      actual: serializeCtrlProxyRequest(
        ctrlProxyRequests.requestInstalledPackages({
          requestId: "ip-1",
          includeSystem: true,
          userId: 0,
        }),
      ),
      expected:
        '{"type":"request_installed_packages","requestId":"ip-1","includeSystem":true,"userId":0}',
    },
    {
      builder: "requestInstalledPackages",
      name: "omitted userId normalized to explicit null",
      actual: serializeCtrlProxyRequest(
        ctrlProxyRequests.requestInstalledPackages({ requestId: "ip-2", includeSystem: false }),
      ),
      expected:
        '{"type":"request_installed_packages","requestId":"ip-2","includeSystem":false,"userId":null}',
    },
    {
      builder: "requestInstalledPackages",
      name: "negative userId (boundary) is sent verbatim",
      actual: serializeCtrlProxyRequest(
        ctrlProxyRequests.requestInstalledPackages({
          requestId: "ip-neg",
          includeSystem: false,
          userId: -5,
        }),
      ),
      expected:
        '{"type":"request_installed_packages","requestId":"ip-neg","includeSystem":false,"userId":-5}',
    },
    {
      builder: "requestPackageInfo",
      name: "packageName + includePermissions",
      actual: serializeCtrlProxyRequest(
        ctrlProxyRequests.requestPackageInfo({
          requestId: "pi-1",
          packageName: "com.x",
          includePermissions: true,
        }),
      ),
      expected:
        '{"type":"request_package_info","requestId":"pi-1","packageName":"com.x","includePermissions":true}',
    },
    {
      builder: "requestLaunchIntent",
      name: "packageName",
      actual: serializeCtrlProxyRequest(
        ctrlProxyRequests.requestLaunchIntent({ requestId: "li-1", packageName: "com.x" }),
      ),
      expected: '{"type":"request_launch_intent","requestId":"li-1","packageName":"com.x"}',
    },
    {
      builder: "startRecording",
      name: "no requestId on the wire",
      actual: serializeCtrlProxyRequest(ctrlProxyRequests.startRecording()),
      expected: '{"type":"start_recording"}',
    },
    {
      builder: "requestClickFocusedInput",
      name: "selectorless click",
      actual: serializeCtrlProxyRequest(
        ctrlProxyRequests.requestClickFocusedInput({ requestId: "fc-1" }),
      ),
      expected: '{"type":"request_click_focused_input","requestId":"fc-1"}',
    },
    {
      builder: "stopRecording",
      name: "no requestId on the wire",
      actual: serializeCtrlProxyRequest(ctrlProxyRequests.stopRecording()),
      expected: '{"type":"stop_recording"}',
    },
  ];

  test("every builder frame uses Kotlin fields and supplies all device-required fields", () => {
    for (const { expected } of cases) {
      const frame = JSON.parse(expected) as Record<string, unknown> & { type: string };
      const contract = wireContract.requests.find(({ serialName }) => serialName === frame.type);
      expect(contract).toBeDefined();
      const fields = new Set(contract!.fields.map(({ name }) => name));
      for (const name of Object.keys(frame)) {
        if (name !== "type") {
          expect(fields.has(name)).toBe(true);
        }
      }
      for (const { name, hasDefault } of contract!.fields) {
        if (!hasDefault) {
          expect(name in frame).toBe(true);
        }
      }
    }
  });

  test.each(cases)("$builder — $name", ({ actual, expected }) => {
    expect(actual).toBe(expected);
  });

  // Completeness guard: every builder in the module must have at least one wire row above, and the
  // total builder count is pinned. Ship builder #45 without a row and this fails — not a silently
  // uncovered send site. `request_two_finger_swipe` has no builder here by design (it goes through
  // the shared sendCommand path, asserted in CtrlProxyGestures.test.ts), so it is not a builder key.
  test("every ctrlProxyRequests builder has wire coverage and the count is pinned at 53", () => {
    const builderNames = Object.keys(ctrlProxyRequests);
    expect(builderNames.length).toBe(53);
    const covered = new Set(cases.map((row) => row.builder));
    expect([...covered].sort()).toEqual([...builderNames].sort());
  });
});

describe("prototype builders enforce either/or types", () => {
  const spec = {
    id: "panel",
    window: { placement: { type: "fullscreen" as const }, opacity: 90 },
    root: { type: "text" as const, text: "Hello" },
  };
  const invalidBuilders = () => {
    // @ts-expect-error update_prototype was removed; a same-id show replaces in place
    ctrlProxyRequests.updatePrototype({ requestId: "r", id: "panel", spec });
    // @ts-expect-error dismiss requires exactly one target
    ctrlProxyRequests.dismissPrototype({ requestId: "r" });
    // @ts-expect-error dismiss cannot combine id and all
    ctrlProxyRequests.dismissPrototype({ requestId: "r", id: "panel", all: true });
    // @ts-expect-error all must be true
    ctrlProxyRequests.dismissPrototype({ requestId: "r", all: false });
  };
  void invalidBuilders;
});

test("IME trace opt-in serializes after the timeout", () => {
  expect(
    serializeCtrlProxyRequest({
      type: "request_commit_text",
      requestId: "trace-1",
      text: "value",
      timeoutMs: 1500,
      trace: true,
    }),
  ).toBe(
    '{"type":"request_commit_text","requestId":"trace-1","text":"value","timeoutMs":1500,"trace":true}',
  );
});

// android/protocol/src/main/kotlin/dev/jasonpearson/automobile/protocol/WebSocketResponse.kt:
// SavedPrototypeErrorCode @SerialName values, in declaration order.
test("saved prototype error codes match Kotlin", () => {
  const kotlinCodes = [
    "pin_unsupported",
    "device_locked",
    "pin_failed",
    "invalid_id",
    "invalid_label",
    "spec_too_large",
    "invalid_spec",
    "invalid_asset_id",
    "duplicate_asset_id",
    "unsupported_mime_type",
    "empty_asset",
    "asset_too_large",
    "count_limit",
    "total_limit",
    "missing_asset",
    "saved_count_limit",
    "storage_failure",
    "unsupported_existing",
    "not_found",
    "unsupported_format",
    "internal_error",
  ];
  expect(SAVED_PROTOTYPE_ERROR_CODES).toEqual(kotlinCodes);
  for (const code of kotlinCodes) {
    expect(isSavedPrototypeErrorCode(code)).toBe(true);
  }
  for (const code of ["future", null, 1, undefined]) {
    expect(isSavedPrototypeErrorCode(code)).toBe(false);
  }
});

test("pin builder omits absent icon and participates in supported requests", () => {
  expect(
    serializeCtrlProxyRequest(
      ctrlProxyRequests.pinSavedPrototype({ requestId: "pin", id: "panel" }),
    ),
  ).toBe('{"type":"pin_saved_prototype","requestId":"pin","id":"panel"}');
  expect(
    serializeCtrlProxyRequest(
      ctrlProxyRequests.pinSavedPrototype({ requestId: "pin", id: "panel", icon: "hero" }),
    ),
  ).toBe('{"type":"pin_saved_prototype","requestId":"pin","id":"panel","icon":"hero"}');
  expect(KNOWN_REQUEST_TYPES).toContain("pin_saved_prototype");
});
