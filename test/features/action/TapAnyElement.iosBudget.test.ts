import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { TapAnyElement } from "../../../src/features/action/TapAnyElement";
import { PortManager } from "../../../src/utils/PortManager";
import { FakeAdbClient } from "../../fakes/FakeAdbClient";
import { FakeIOSCtrlProxy } from "../../fakes/FakeIOSCtrlProxy";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeHierarchyCapture } from "../../fakes/FakeHierarchyCapture";
import { serverConfig } from "../../../src/utils/ServerConfig";
import type { CtrlProxyHierarchy } from "../../../src/features/observe/ios/types";
import { spyOnIosClientFactory } from "../../helpers/iosCtrlProxyClientSpies";

let restore: () => void;
let tapAny: TapAnyElement;
let client: FakeIOSCtrlProxy;
let directRead: ReturnType<typeof spyOn>;

beforeEach(() => {
  PortManager.reset();
  PortManager.setPortAvailabilityCheckerForTesting({ isPortAvailable: () => true });
  client = new FakeIOSCtrlProxy();
  directRead = spyOn(client, "getAccessibilityHierarchy");
  const instance = spyOnIosClientFactory(() => client);
  restore = () => instance.mockRestore();
  tapAny = new TapAnyElement(
    { name: "test", platform: "ios", deviceId: "test-ios-budget" },
    new FakeAdbClient(),
    { timer: new FakeTimer() },
  );
});

afterEach(() => {
  serverConfig.setRawElementSearchEnabled(false);
  restore();
  directRead.mockRestore();
  PortManager.reset();
  PortManager.setPortAvailabilityCheckerForTesting(null);
});
test("fresh tapAny selector capture requests raw hierarchy when enabled", async () => {
  serverConfig.setRawElementSearchEnabled(true);
  const capture = new FakeHierarchyCapture(() => ({ hierarchy: { node: {} } }), "ios");
  tapAny = new TapAnyElement(
    { name: "test", platform: "ios", deviceId: "test-ios-budget" },
    new FakeAdbClient(),
    { timer: new FakeTimer(), hierarchyCapture: capture },
  );
  await tapAny.testHooks.refreshViewHierarchy(37);
  expect(capture.requests[0]?.searchRaw).toBe(true);
});

test("iOS tapAny refresh uses the observe projection within the caller budget", async () => {
  const signal = new AbortController().signal;
  client.setHierarchyData({ updatedAt: 0, packageName: "com.test", hierarchy: {} });
  const sync = spyOn(client, "requestHierarchySync");
  const capture = await tapAny.testHooks.refreshViewHierarchy(37, undefined, signal);
  expect(capture).not.toBeNull();
  expect(sync).toHaveBeenCalledWith(undefined, false, signal, { timeoutMs: 37 });
  expect(directRead).not.toHaveBeenCalled();
  sync.mockRestore();
});
test("iOS tapAny search refresh converts raw resource IDs before normalization", async () => {
  const raw: CtrlProxyHierarchy = {
    updatedAt: 0,
    packageName: "com.test",
    hierarchy: { resourceId: "late-id", bounds: { left: 0, top: 0, right: 40, bottom: 40 } },
  };
  const converted = {
    hierarchy: {
      node: { "resource-id": "late-id", bounds: { left: 0, top: 0, right: 40, bottom: 40 } },
    },
  };
  const sync = spyOn(client, "requestHierarchySync").mockResolvedValue({ hierarchy: raw });
  const convert = spyOn(client, "convertToViewHierarchyResult").mockReturnValue(converted);
  const hierarchy = await tapAny.testHooks.readFreshHierarchy(37);
  expect(convert).toHaveBeenCalledWith(raw);
  expect(hierarchy?.hierarchy?.node).toMatchObject({ "resource-id": "late-id" });
  sync.mockRestore();
  convert.mockRestore();
});
