import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { TapAnyElement } from "../../../src/features/action/TapAnyElement";
import { IOSCtrlProxyClient } from "../../../src/features/observe/ios";
import { PortManager } from "../../../src/utils/PortManager";
import { FakeAdbClient } from "../../fakes/FakeAdbClient";
import { FakeIOSCtrlProxy } from "../../fakes/FakeIOSCtrlProxy";
import { FakeTimer } from "../../fakes/FakeTimer";

let restore: () => void;
let tapAny: TapAnyElement;
let client: FakeIOSCtrlProxy;
let directRead: ReturnType<typeof spyOn>;

beforeEach(() => {
  PortManager.reset();
  PortManager.setPortAvailabilityCheckerForTesting({ isPortAvailable: () => true });
  client = new FakeIOSCtrlProxy();
  directRead = spyOn(client, "getAccessibilityHierarchy");
  const instance = spyOn(IOSCtrlProxyClient, "getInstance").mockImplementation(() => client as any);
  restore = () => instance.mockRestore();
  tapAny = new TapAnyElement(
    { name: "test", platform: "ios", deviceId: "test-ios-budget" },
    new FakeAdbClient(),
    { timer: new FakeTimer() },
  );
});

afterEach(() => {
  restore();
  directRead.mockRestore();
  PortManager.reset();
  PortManager.setPortAvailabilityCheckerForTesting(null);
});

test("iOS tapAny refresh uses the observe projection within the caller budget", async () => {
  const signal = new AbortController().signal;
  client.setHierarchyData({ hierarchy: { node: {} } } as any);
  const sync = spyOn(client, "requestHierarchySync");
  const capture = await tapAny["refreshViewHierarchy"](37, undefined, signal);
  expect(capture).not.toBeNull();
  expect(sync).toHaveBeenCalledWith(undefined, false, signal, 37);
  expect(directRead).not.toHaveBeenCalled();
  sync.mockRestore();
});
