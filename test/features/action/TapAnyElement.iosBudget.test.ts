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
  const sharedRead = spyOn((tapAny as any).viewHierarchy, "getiOSViewHierarchy").mockResolvedValue({
    hierarchy: { node: {} },
  });

  await tapAny["refreshViewHierarchy"](37, undefined, signal);

  expect(sharedRead).toHaveBeenCalledWith(undefined, false, 0, 37, signal);
  expect(directRead).not.toHaveBeenCalled();
  sharedRead.mockRestore();
});
