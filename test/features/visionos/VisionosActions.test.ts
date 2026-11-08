import { isVisionosHierarchy } from "../../../src/features/visionos/VisionosHierarchy";
import settingsHierarchy from "../../fixtures/visionos-settings/hierarchy.json";
import { readToolResponse } from "../../helpers/toolResponse";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { visionosTapOn, visionosSendKeys } from "../../../src/features/visionos/VisionosActions";
import { visionosRunners } from "../../../src/features/visionos/VisionosRunnerRegistry";
import { FakeVisionosRunnerClient } from "../../fakes/FakeVisionosRunnerClient";
import { TapOnElement } from "../../../src/features/action/TapOnElement";
import { createDeviceHierarchyCapture } from "../../../src/features/observe/DeviceHierarchyCapture";
import { FakeTimer } from "../../fakes/FakeTimer";
import { createSendKeysHandler } from "../../../src/server/interactionToolHandlers";
import type { TapOnElementOptions } from "../../../src/models";
import { matchesXctestrunPlatform } from "../../../src/ctrlProxy/IosXctestrunPlatform";

const device = { platform: "visionos", deviceId: "vision-actions", name: "Vision Pro" } as const;
let client: FakeVisionosRunnerClient;
let unregister: () => void;
beforeEach(() => {
  client = new FakeVisionosRunnerClient();
  unregister = visionosRunners.register(device.deviceId, client);
});
afterEach(() => unregister());

test.each(["B01", "orn", "field"])(
  "tapOn routes %s to an identifier, never a frame",
  async (elementId) => {
    const result = await new TapOnElement(device, null, { timer: new FakeTimer() }).execute({
      action: "tap",
      elementId,
    });
    expect(result.success).toBe(true);
    expect(client.commands).toEqual([
      { type: "request_hierarchy" },
      { type: "request_tap_element", identifier: elementId },
    ]);
  },
);

test("exact text resolves the ornament identifier", async () => {
  await visionosTapOn(device.deviceId, { action: "tap", text: "orn" });
  expect(client.commands[1]).toEqual({ type: "request_tap_element", identifier: "orn" });
});

test("DeviceHierarchyCapture reads the visionOS runner through its fake", async () => {
  const timer = new FakeTimer();
  const result = await createDeviceHierarchyCapture(device, { timer }).capture({
    freshness: "fresh",
  });
  expect(result.hierarchy.packageName).toBe("dev.automobile.probe.app");
  expect(client.commands).toEqual([{ type: "request_hierarchy" }]);
  expect(timer.getSleepHistory()).toEqual([]);
});

test("DeviceHierarchyCapture passes the capture timeout to the visionOS runner read", async () => {
  await createDeviceHierarchyCapture(device, { timer: new FakeTimer() }).capture({
    freshness: "fresh",
    timeoutMs: 1234,
  });
  expect(client.hierarchyTimeouts).toEqual([1234]);
});

test.each<TapOnElementOptions>([
  { action: "focus", elementId: "field" },
  { action: "longPress", elementId: "B01" },
  { action: "tap", text: "B01", display: "0" },
  { action: "tap", elementId: "orn", index: -1 },
])("refuses unsupported tap options before input: %j", async (options) => {
  await expect(visionosTapOn(device.deviceId, options)).rejects.toThrow();
  expect(client.commands).toEqual([]);
});

test("missing, disabled and ambiguous identifiers never dispatch a tap", async () => {
  await expect(
    visionosTapOn(device.deviceId, { action: "tap", elementId: "missing" }),
  ).rejects.toThrow("No visionOS element matched");
  const nodes = client.tree.hierarchy.node;
  if (!Array.isArray(nodes)) {
    throw new Error("Expected captured flat descendants");
  }
  const ornament = nodes.find((node) => "resource-id" in node && node["resource-id"] === "orn")!;
  ornament.enabled = "false";
  await expect(visionosTapOn(device.deviceId, { action: "tap", elementId: "orn" })).rejects.toThrow(
    "disabled",
  );
  ornament.enabled = "true";
  nodes.push({ ...ornament });
  await expect(visionosTapOn(device.deviceId, { action: "tap", elementId: "orn" })).rejects.toThrow(
    "ambiguous",
  );
  expect(client.commands.every((command) => command.type === "request_hierarchy")).toBe(true);
});

function useSettingsHierarchy() {
  unregister();
  const tree = structuredClone(settingsHierarchy);
  if (!isVisionosHierarchy(tree)) {
    throw new Error("Expected a valid Settings hierarchy fixture");
  }
  client = new FakeVisionosRunnerClient(tree);
  unregister = visionosRunners.register(device.deviceId, client);
  return tree;
}

test.each([{ elementId: "General" }, { text: "General" }])(
  "Settings General resolves the sidebar cell: %j",
  async (selector) => {
    useSettingsHierarchy();
    await visionosTapOn(device.deviceId, { action: "tap", ...selector });
    expect(client.commands[1]).toEqual({
      type: "request_tap_element",
      identifier: "General",
      label: "General",
      elementType: 9,
    });
  },
);

test("Settings Accessibility keeps the identifier-only command", async () => {
  useSettingsHierarchy();
  await visionosTapOn(device.deviceId, { action: "tap", text: "Accessibility" });
  expect(client.commands[1]).toEqual({
    type: "request_tap_element",
    identifier: "ACCESSIBILITY",
  });
});

test("a disabled Settings twin of the General row resolves to the enabled row", async () => {
  const tree = useSettingsHierarchy();
  const nodes = tree.hierarchy.node;
  const rowIndex = nodes.findIndex(
    (node) => node["resource-id"] === "General" && node.className === "9",
  );
  nodes.splice(rowIndex, 0, { ...structuredClone(nodes[rowIndex]), enabled: "false" });
  await visionosTapOn(device.deviceId, { action: "tap", elementId: "General" });
  expect(client.commands[1]).toEqual({
    type: "request_tap_element",
    identifier: "General",
    label: "General",
    elementType: 9,
  });
});

test("a disabled twin does not turn a unique identifier into a shared one", async () => {
  const nodes = client.tree.hierarchy.node;
  if (!Array.isArray(nodes)) {
    throw new Error("Expected captured flat descendants");
  }
  const ornament = nodes.find((node) => "resource-id" in node && node["resource-id"] === "orn")!;
  nodes.unshift({ ...ornament, enabled: "false" });
  await visionosTapOn(device.deviceId, { action: "tap", elementId: "orn" });
  expect(client.commands[1]).toEqual({ type: "request_tap_element", identifier: "orn" });
});

test("identical Settings siblings report ambiguity with candidate details", async () => {
  const tree = useSettingsHierarchy();
  const row = tree.hierarchy.node.find(
    (node) => node["resource-id"] === "General" && node.className === "9",
  )!;
  tree.hierarchy.node.push(structuredClone(row));
  await expect(
    visionosTapOn(device.deviceId, { action: "tap", elementId: "General" }),
  ).rejects.toThrow(
    /ambiguous.*className=9.*text="General".*bounds=.*className=9.*index.*distinct text\/elementId/,
  );
  expect(client.commands).toEqual([{ type: "request_hierarchy" }]);
});

test("index selects from the stable ranked Settings candidates", async () => {
  useSettingsHierarchy();
  await visionosTapOn(device.deviceId, { action: "tap", elementId: "General", index: 1 });
  expect(client.commands[1]).toEqual({
    type: "request_tap_element",
    identifier: "General",
    label: "",
    elementType: 21,
  });
});

test.each(["clickable-first", "clickable-second", "identified", "disabled"])(
  "ranked index %#: %s",
  async (identifier) => {
    const tree = useSettingsHierarchy();
    const row = tree.hierarchy.node.find(
      (node) => node["resource-id"] === "General" && node.className === "9",
    )!;
    const candidate = { ...row, text: "ranked", enabled: "true", clickable: "true" };
    tree.hierarchy.node.unshift(
      { ...candidate, "resource-id": "disabled", enabled: "false" },
      { ...candidate, "resource-id": "identified", clickable: "false" },
      { ...candidate, "resource-id": "clickable-first" },
      { ...candidate, "resource-id": "clickable-second" },
    );
    const index = ["clickable-first", "clickable-second", "identified", "disabled"].indexOf(
      identifier,
    );
    const tap = visionosTapOn(device.deviceId, { action: "tap", text: "ranked", index });
    if (identifier === "disabled") {
      await expect(tap).rejects.toThrow("disabled");
      expect(client.commands).toEqual([{ type: "request_hierarchy" }]);
    } else {
      await tap;
      expect(client.commands[1]).toEqual({ type: "request_tap_element", identifier });
    }
  },
);

test("a text-only Settings target reports the missing identifier", async () => {
  useSettingsHierarchy();
  await expect(
    visionosTapOn(device.deviceId, { action: "tap", text: "General", index: 1 }),
  ).rejects.toThrow("no accessibility identifier");
});

test("registered sendKeys handler types through visionOS rather than the iOS client", async () => {
  const response = await createSendKeysHandler({
    sendKeysFactory: () => {
      throw new Error("iOS path ran");
    },
  })(device, { commands: [{ action: "type", text: "hello", operation: "insert", mode: "auto" }] });
  expect(readToolResponse(response).isError).not.toBe(true);
  expect(client.commands).toEqual([{ type: "request_append_text", text: "hello" }]);
});

test("validates the entire typing batch before any input", async () => {
  await expect(
    visionosSendKeys(device.deviceId, [
      { action: "type", text: "hello" },
      { action: "type", text: "replacement", operation: "replace" },
    ]),
  ).rejects.toThrow("append");
  await expect(
    visionosSendKeys(device.deviceId, [{ action: "type", text: "hello" }], { elementId: "field" }),
  ).rejects.toThrow("focused field");
  expect(client.commands).toEqual([]);
});

test.each(["\u0008", "ab\u007f", ""])(
  "rejects append text containing a delete key before any input (%#)",
  async (text) => {
    await expect(
      visionosSendKeys(device.deviceId, [
        { action: "type", text: "hello" },
        { action: "type", text },
      ]),
    ).rejects.toThrow("delete key");
    expect(client.commands).toEqual([]);
  },
);

test("typing reports runner errors and cancellation causes no input", async () => {
  await expect(
    visionosSendKeys(device.deviceId, [{ action: "type", text: "hello" }], undefined, {
      signal: AbortSignal.abort(),
    }),
  ).rejects.toThrow();
  expect(client.commands).toEqual([]);
  // Keep the fake connected and return a command-level refusal, like an unfocused field.
  client.request = async () => {
    throw new Error("no focused text input");
  };
  expect(
    await visionosSendKeys(device.deviceId, [{ action: "type", text: "hello" }]),
  ).toMatchObject({ success: false, completedCommands: 0, failedIndex: 0 });
});

test("artifact selection keeps iOS, tvOS and visionOS runners separate", () => {
  expect(
    matchesXctestrunPlatform(
      "AutoMobileVisionTest_xrsimulator26.5-arm64.xctestrun",
      "visionSimulator",
    ),
  ).toBe(true);
  expect(matchesXctestrunPlatform("AutoMobileVisionTest_xrsimulator26.5-arm64.xctestrun")).toBe(
    false,
  );
  expect(
    matchesXctestrunPlatform("AutoMobileTest_iphonesimulator26.5-arm64.xctestrun", "simulator"),
  ).toBe(true);
  expect(
    matchesXctestrunPlatform(
      "AutoMobileTVTest_appletvsimulator26.5-arm64.xctestrun",
      "tvSimulator",
    ),
  ).toBe(true);
  expect(
    matchesXctestrunPlatform(
      "AutoMobileTVTest_appletvsimulator26.5-arm64.xctestrun",
      "visionSimulator",
    ),
  ).toBe(false);
});
