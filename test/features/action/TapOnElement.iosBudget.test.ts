import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { TapOnElement } from "../../../src/features/action/TapOnElement";
import { IOSCtrlProxyClient } from "../../../src/features/observe/ios";
import { PortManager } from "../../../src/utils/PortManager";
import { FakeAdbClient } from "../../fakes/FakeAdbClient";
import { FakeIOSCtrlProxy } from "../../fakes/FakeIOSCtrlProxy";
import { FakeTimer } from "../../fakes/FakeTimer";

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
  restore();
  read.mockRestore();
  PortManager.reset();
  PortManager.setPortAvailabilityCheckerForTesting(null);
});

test("iOS hierarchy refresh forwards the caller's remaining budget and signal", async () => {
  const signal = new AbortController().signal;
  await tap["refreshViewHierarchy"](37, undefined, signal);
  expect(client.getHierarchyRequestTimeouts()).toEqual([37]);
  expect(read.mock.calls[0]?.[5]).toBe(signal);
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
