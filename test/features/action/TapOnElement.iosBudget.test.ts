import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { TapOnElement } from "../../../src/features/action/TapOnElement";
import { IOSCtrlProxyClient } from "../../../src/features/observe/ios";
import { PortManager } from "../../../src/utils/PortManager";
import { FakeAdbClient } from "../../fakes/FakeAdbClient";
import { FakeIOSCtrlProxy } from "../../fakes/FakeIOSCtrlProxy";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeHierarchyCapture } from "../../fakes/FakeHierarchyCapture";
import { serverConfig } from "../../../src/utils/ServerConfig";

let restore: () => void;
let tap: TapOnElement;
let client: FakeIOSCtrlProxy;
let read: ReturnType<typeof spyOn>;

beforeEach(() => {
  PortManager.reset();
  PortManager.setPortAvailabilityCheckerForTesting({ isPortAvailable: () => true });
  client = new FakeIOSCtrlProxy();
  read = spyOn(client, "getAccessibilityHierarchy");
  const instance = spyOn(IOSCtrlProxyClient, "getInstance").mockImplementation(() => client as any);
  restore = () => instance.mockRestore();
  tap = new TapOnElement(
    { name: "test", platform: "ios", deviceId: "test-ios-budget" },
    new FakeAdbClient(),
    { timer: new FakeTimer() },
  );
});

afterEach(() => {
  serverConfig.setRawElementSearchEnabled(false);
  restore();
  read.mockRestore();
  PortManager.reset();
  PortManager.setPortAvailabilityCheckerForTesting(null);
});
test("fresh tap selector capture requests raw hierarchy when enabled", async () => {
  serverConfig.setRawElementSearchEnabled(true);
  const capture = new FakeHierarchyCapture(() => ({ hierarchy: { node: {} } }), "ios");
  (tap as any).hierarchyCapture = capture;
  await tap["refreshViewHierarchy"](37);
  expect(capture.requests[0]?.searchRaw).toBe(true);
});

test("iOS hierarchy refresh forwards the caller's remaining budget and signal", async () => {
  const signal = new AbortController().signal;
  const sync = spyOn(client, "requestHierarchySync").mockResolvedValue({
    hierarchy: { hierarchy: { node: {} } },
  } as any);
  await tap["refreshViewHierarchy"](37, undefined, signal);
  expect(sync).toHaveBeenCalledWith(undefined, false, signal, 37);
  expect(read).not.toHaveBeenCalled();
  sync.mockRestore();
});
test("iOS search refresh converts raw resource IDs and test tags before normalization", async () => {
  const raw = {
    hierarchy: {
      resourceId: "late-id",
      testTag: "late-tag",
      text: "Late",
      bounds: { left: 10, top: 10, right: 40, bottom: 40 },
    },
  };
  const converted = {
    hierarchy: {
      node: {
        "resource-id": "late-id",
        "test-tag": "late-tag",
        text: "Late",
        bounds: { left: 10, top: 10, right: 40, bottom: 40 },
      },
    },
  };
  const sync = spyOn(client, "requestHierarchySync").mockResolvedValue({ hierarchy: raw } as any);
  const convert = spyOn(client, "convertToViewHierarchyResult").mockReturnValue(converted as any);
  const hierarchy = await tap["readFreshHierarchy"](37);
  expect(convert).toHaveBeenCalledWith(raw);
  expect(hierarchy?.hierarchy?.node).toMatchObject({
    "resource-id": "late-id",
    "test-tag": "late-tag",
  });
  sync.mockRestore();
  convert.mockRestore();
});

test.each([0, -10])("an expired budget %s starts no hierarchy request", async (budget) => {
  expect(await tap["refreshViewHierarchy"](budget)).toBeNull();
  expect(client.getHierarchyRequestTimeouts()).toEqual([]);
  expect(read).not.toHaveBeenCalled();
});

test("an aborted refresh rethrows cancellation without starting a request", async () => {
  const controller = new AbortController();
  const reason = new Error("cancelled refresh");
  controller.abort(reason);
  await expect(tap["refreshViewHierarchy"](37, undefined, controller.signal)).rejects.toThrow(
    "Operation cancelled",
  );
  expect(client.getHierarchyRequestTimeouts()).toEqual([]);
});
