import { describe, expect, test } from "bun:test";
import { CtrlProxySdkCapabilities } from "../../../../src/features/observe/ios/CtrlProxySdkCapabilities";
import { parseObservationBridgeState } from "../../../../src/features/observe/ios/observationBridgeState";
import type { DelegateContext } from "../../../../src/features/observe/ios/types";
import { RequestManager } from "../../../../src/utils/RequestManager";
import { FakeOpenSocket } from "../../../fakes/FakeOpenSocket";
import { FakeTimer } from "../../../fakes/FakeTimer";

describe("parseObservationBridgeState (#5159)", () => {
  test("an available bridge carries its schema version and sorted action kinds", () => {
    expect(
      parseObservationBridgeState({
        schemaVersion: 1,
        available: true,
        supportedActions: ["tap", "back"],
      }),
    ).toEqual({ status: "available", schemaVersion: 1, supportedActions: ["back", "tap"] });
  });

  test("an unregistered bridge reports NOT_REGISTERED", () => {
    expect(
      parseObservationBridgeState({
        schemaVersion: 1,
        available: false,
        reason: "NOT_REGISTERED",
        supportedActions: [],
      }),
    ).toEqual({ status: "unavailable", reason: "NOT_REGISTERED" });
  });

  test("a reason from a newer SDK degrades to UNKNOWN, never to available", () => {
    expect(
      parseObservationBridgeState({ schemaVersion: 2, available: false, reason: "PAUSED" }),
    ).toEqual({ status: "unavailable", reason: "UNKNOWN" });
  });

  test("a missing bridge object means the SDK predates discovery", () => {
    expect(parseObservationBridgeState(undefined)).toEqual({
      status: "unavailable",
      reason: "SDK_TOO_OLD",
    });
  });

  test("a malformed bridge object is typed, not treated as available", () => {
    expect(parseObservationBridgeState({ available: "yes" })).toEqual({
      status: "unavailable",
      reason: "MALFORMED_RESPONSE",
    });
  });
});

function createProbe(reply: Record<string, unknown>, supportedCommands: Set<string> | null) {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const requestManager = new RequestManager(timer);
  const socket = new FakeOpenSocket((frame) => {
    const request: { requestId: string } = JSON.parse(frame);
    requestManager.resolve(request.requestId, { ...reply, totalTimeMs: 0 });
  });
  const context: DelegateContext = {
    timer,
    requestManager,
    getWebSocket: () => socket,
    ensureConnected: async () => true,
    isCommandSupported: () => true,
    cancelScreenshotBackoff: () => {},
  };
  return new CtrlProxySdkCapabilities({
    timer,
    getSupportedCommands: () => supportedCommands,
    isCommandSupported: () => true,
    createDelegateContext: () => context,
    syncNetworkMockRulesToDevice: () => {},
    syncNetworkErrorSimulationToDevice: () => {},
  });
}

const capabilityCommands = new Set(["get_sdk_capabilities"]);

describe("CtrlProxySdkCapabilities.getObservationBridgeState (#5159)", () => {
  test("reads the bridge state from the foreground app's capability reply", async () => {
    const probe = createProbe(
      {
        success: true,
        available: true,
        bundleId: "com.example.sdk",
        capabilities: ["hierarchy"],
        observationBridge: { schemaVersion: 1, available: true, supportedActions: ["tap"] },
      },
      capabilityCommands,
    );
    expect(await probe.getObservationBridgeState("com.example.sdk")).toEqual({
      status: "available",
      schemaVersion: 1,
      supportedActions: ["tap"],
    });
    // The reply is cached with the rest of the capabilities, so ordinary gates still work.
    expect(probe.hasSdkCapability("hierarchy", "com.example.sdk")).toBe(true);
  });

  test("another foreground app's bridge never answers for this app", async () => {
    const probe = createProbe(
      {
        success: true,
        available: true,
        bundleId: "com.example.other",
        observationBridge: { schemaVersion: 1, available: true, supportedActions: ["tap"] },
      },
      capabilityCommands,
    );
    expect(await probe.getObservationBridgeState("com.example.sdk")).toEqual({
      status: "unavailable",
      reason: "SDK_UNAVAILABLE",
    });
  });

  test("an app without the SDK reports SDK_UNAVAILABLE", async () => {
    const probe = createProbe({ success: true, available: false }, capabilityCommands);
    expect(await probe.getObservationBridgeState("com.example.sdk")).toEqual({
      status: "unavailable",
      reason: "SDK_UNAVAILABLE",
    });
  });

  test("an SDK reply without a bridge object reports SDK_TOO_OLD", async () => {
    const probe = createProbe(
      { success: true, available: true, bundleId: "com.example.sdk", capabilities: [] },
      capabilityCommands,
    );
    expect(await probe.getObservationBridgeState("com.example.sdk")).toEqual({
      status: "unavailable",
      reason: "SDK_TOO_OLD",
    });
  });

  test("a runner without get_sdk_capabilities reports SDK_TOO_OLD without probing", async () => {
    const probe = createProbe({ success: true, available: true }, new Set(["request_hierarchy"]));
    expect(await probe.getObservationBridgeState("com.example.sdk")).toEqual({
      status: "unavailable",
      reason: "SDK_TOO_OLD",
    });
  });

  test("a runner that has not connected yet reports SDK_UNAVAILABLE", async () => {
    const probe = createProbe({ success: true, available: true }, null);
    expect(await probe.getObservationBridgeState("com.example.sdk")).toEqual({
      status: "unavailable",
      reason: "SDK_UNAVAILABLE",
    });
  });
});
