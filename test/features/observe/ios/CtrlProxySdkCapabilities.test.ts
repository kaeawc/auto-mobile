import { describe, expect, spyOn, test } from "bun:test";
import { IOSCtrlProxyClient } from "../../../../src/features/observe/ios/IOSCtrlProxyClient";
import { SdkCapabilityProbeSupersededError } from "../../../../src/features/observe/ios/SdkCapabilityProbeSupersededError";
import { SdkCapabilityQueryError } from "../../../../src/features/observe/ios/SdkCapabilityQueryError";
import { CtrlProxySdkCapabilities } from "../../../../src/features/observe/ios/CtrlProxySdkCapabilities";
import { IOS_HIERARCHY_REQUEST_TIMEOUT_MS } from "../../../../src/features/observe/ios/CtrlProxyHierarchy";
import { ActionableError } from "../../../../src/models/ActionableError";
import { typedRefusalFields } from "../../../../src/models/typedRefusalFields";
import type { DelegateContext } from "../../../../src/features/observe/ios/types";
import { RequestManager } from "../../../../src/utils/RequestManager";
import { FakeOpenSocket } from "../../../fakes/FakeOpenSocket";
import { FakeTimer } from "../../../fakes/FakeTimer";
import { drainUntil } from "../../../helpers/fakeTimerStepping";

interface ProbeReply {
  success: boolean;
  available?: boolean;
  bundleId?: string;
  capabilities?: string[];
  error?: string;
}

function createHarness(
  onRequest?: (attempt: number) => ProbeReply | undefined,
  autoAdvance = true,
) {
  const timer = new FakeTimer();
  if (autoAdvance) {
    timer.enableAutoAdvance();
  }
  const requestManager = new RequestManager(timer);
  const state = {
    connected: true,
    supported: true,
    attempts: 0,
    sendError: false,
    responseError: "",
  };
  const socket = new FakeOpenSocket((frame) => {
    state.attempts++;
    if (state.sendError) {
      throw new Error("WebSocket not connected");
    }
    const request: { requestId: string } = JSON.parse(frame);
    const reply = onRequest?.(state.attempts);
    if (state.responseError) {
      requestManager.resolveError(request.requestId, state.responseError);
      return;
    }
    if (reply) {
      requestManager.resolve(request.requestId, { ...reply, totalTimeMs: 0 });
    }
  });
  const context: DelegateContext = {
    timer,
    requestManager,
    getWebSocket: () => socket,
    ensureConnected: async () => state.connected,
    isCommandSupported: () => state.supported,
    cancelScreenshotBackoff: () => {},
  };
  const probe = new CtrlProxySdkCapabilities({
    timer,
    getSupportedCommands: () => new Set(["get_sdk_capabilities"]),
    isCommandSupported: () => state.supported,
    createDelegateContext: () => context,
    syncNetworkMockRulesToDevice: () => {},
    syncNetworkErrorSimulationToDevice: () => {},
  });
  return { probe, state, timer, requestManager };
}

const available: ProbeReply = {
  success: true,
  available: true,
  bundleId: "com.example.sdk",
  capabilities: ["database", "highlight", "network_mocking", "magic_tap"],
};
const timeoutFailure = {
  code: "timeout",
  retryable: true,
  message: `SDK capability query timed out after ${IOS_HIERARCHY_REQUEST_TIMEOUT_MS} ms`,
};

describe("SDK capability transport uncertainty", () => {
  test("returns capabilities and unavailable as distinct successful probe outcomes", async () => {
    const positive = createHarness(() => available);
    expect(await positive.probe.requestSdkCapabilities(0)).toMatchObject({
      status: "capabilities",
      capabilities: { bundleId: available.bundleId, capabilities: new Set(available.capabilities) },
    });
    const negative = createHarness(() => ({ success: true, available: false }));
    expect(await negative.probe.requestSdkCapabilities(0)).toEqual({ status: "unavailable" });
  });

  test("keeps generic runner error responses unknown", async () => {
    const { probe, state } = createHarness();
    state.responseError = "Runner could not query SDK";
    await expect(probe.ensureSdkCapability("database")).rejects.toMatchObject({
      code: "sdk_capability_query_failed",
      retryable: true,
    });
    state.responseError = "";
    state.connected = false;
    await expect(probe.ensureSdkCapability("database")).rejects.toMatchObject({
      code: "not_connected",
    });
  });

  test("keeps explicit older-runner unknown-command responses unavailable", async () => {
    const h = createHarness(() => {
      h.state.supported = false;
      h.state.responseError = "Unknown command type: get_sdk_capabilities";
      return undefined;
    });
    expect(await h.probe.ensureSdkCapability("database")).toBe(false);
    expect(h.state.attempts).toBe(1);
  });

  test("does not retry an invalidated generation after timeout", async () => {
    const { probe, state, timer, requestManager } = createHarness(undefined, false);
    const pending = probe.ensureSdkCapability("database");
    await drainUntil(() => requestManager.getPendingCount() === 1, { description: "SDK probe" });
    probe.invalidateSdkCapabilities();
    timer.advanceTime(IOS_HIERARCHY_REQUEST_TIMEOUT_MS);
    await expect(pending).rejects.toBeInstanceOf(SdkCapabilityProbeSupersededError);
    expect(state.attempts).toBe(1);
  });

  test("shares an immediate fresh query after disconnect without negative caching", async () => {
    const { probe, state } = createHarness(() => available);
    state.connected = false;
    await expect(probe.ensureSdkCapability("database")).rejects.toMatchObject({
      code: "not_connected",
    });
    state.connected = true;
    expect(await probe.ensureSdkCapability("database")).toBe(true);
    expect(state.attempts).toBe(1);
  });

  test("returns a tri-state unknown containing a typed transport error", async () => {
    const { probe, state } = createHarness();
    state.connected = false;
    const result = await probe.requestSdkCapabilities(0);
    expect(result).toMatchObject({
      status: "unknown",
      error: { code: "not_connected", retryable: true },
    });
    if (result && "error" in result) {
      expect(result.error).toBeInstanceOf(ActionableError);
      expect(typedRefusalFields(result.error)).toEqual({ code: "not_connected", retryable: true });
    }
  });

  test("uses the hierarchy timeout and retries exactly once on timeout", async () => {
    const { probe, state, timer } = createHarness();
    await expect(probe.requireSdkCapability("database")).rejects.toMatchObject(timeoutFailure);
    expect(state.attempts).toBe(2);
    expect(timer.now()).toBe(2 * IOS_HIERARCHY_REQUEST_TIMEOUT_MS);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("accepts a reply after the old one-second deadline", async () => {
    const { probe, timer, requestManager } = createHarness(undefined, false);
    const pending = probe.ensureSdkCapability("database");
    await drainUntil(() => requestManager.getPendingCount() === 1, { description: "SDK probe" });
    timer.advanceTime(1300);
    const requestId = requestManager.getPendingIds()[0]!;
    requestManager.resolve(requestId, { ...available, totalTimeMs: 1300 });
    expect(await pending).toBe(true);
  });

  test("recovers on the one timeout retry", async () => {
    const { probe, state, timer } = createHarness((attempt) =>
      attempt === 2 ? available : undefined,
    );
    expect(await probe.ensureSdkCapability("database")).toBe(true);
    expect(state.attempts).toBe(2);
    expect(timer.now()).toBe(IOS_HIERARCHY_REQUEST_TIMEOUT_MS);
  });

  test.each(["database", "network_mocking", "highlight", "magic_tap"] as const)(
    "%s gates propagate a retryable disconnection instead of SDK absence",
    async (capability) => {
      const { probe, state } = createHarness();
      state.connected = false;
      const failure = {
        code: "not_connected",
        retryable: true,
        message: "SDK capability query not connected to CtrlProxy",
      };
      await expect(probe.ensureSdkCapability(capability)).rejects.toMatchObject(failure);
      await expect(probe.requireSdkCapability(capability)).rejects.toMatchObject(failure);
      await expect(probe.sdkCapabilityGate(capability)).rejects.toMatchObject(failure);
      expect(state.attempts).toBe(0);
    },
  );

  test("does not negatively cache transport failures", async () => {
    const { probe, state } = createHarness((attempt) => (attempt >= 3 ? available : undefined));
    await expect(probe.ensureSdkCapability("database")).rejects.toMatchObject(timeoutFailure);
    expect(await probe.ensureSdkCapability("database")).toBe(true);
    expect(state.attempts).toBe(3);
  });

  test("wraps socket send failures as typed retryable errors without retrying", async () => {
    const { probe, state, timer } = createHarness();
    state.sendError = true;
    await expect(probe.requireSdkCapability("database")).rejects.toMatchObject({
      code: "not_connected",
      retryable: true,
    });
    expect(state.attempts).toBe(1);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("does not turn an unsuccessful or malformed reply into SDK absence", async () => {
    for (const reply of [
      { success: false, error: "SDK query failed" },
      { success: true, available: true },
    ]) {
      const { probe, state } = createHarness(() => reply);
      await expect(probe.requireSdkCapability("database")).rejects.toMatchObject({
        code: "sdk_capability_query_failed",
        retryable: true,
      });
      expect(state.attempts).toBe(1);
    }
  });

  test("retains the five-second negative cache for confirmed absence", async () => {
    const { probe, state, timer } = createHarness(() => ({ success: true, available: false }));
    expect(await probe.ensureSdkCapability("database")).toBe(false);
    await expect(probe.requireSdkCapability("database")).rejects.toThrow(
      "does not expose the AutoMobile SDK capability database",
    );
    timer.advanceTime(4999);
    expect(await probe.ensureSdkCapability("database")).toBe(false);
    expect(state.attempts).toBe(1);
    timer.advanceTime(1);
    expect(await probe.ensureSdkCapability("database")).toBe(false);
    expect(state.attempts).toBe(2);
  });

  test("retains definitive absence for a successful reply missing a capability", async () => {
    const { probe } = createHarness(() => ({ ...available, capabilities: [] }));
    expect(await probe.sdkCapabilityGate("database")).toMatchObject({
      success: false,
      error: "The foreground iOS app does not expose the AutoMobile SDK capability database.",
    });
  });

  test("retains unavailable for unsupported commands from an older runner", async () => {
    const { probe, state } = createHarness();
    state.supported = false;
    expect(await probe.requestSdkCapabilities(0)).toMatchObject({ status: "unavailable" });
    expect(await probe.ensureSdkCapability("database")).toBe(false);
    expect(state.attempts).toBe(0);
  });

  test("shares both timeout attempts across concurrent waiters", async () => {
    const { probe, state } = createHarness();
    const database = probe.ensureSdkCapability("database");
    const highlight = probe.ensureSdkCapability("highlight");
    const results = await Promise.allSettled([database, highlight]);
    for (const result of results) {
      expect(result.status).toBe("rejected");
      if (result.status === "rejected") {
        expect(result.reason).toMatchObject(timeoutFailure);
      }
    }
    expect(state.attempts).toBe(2);
  });
});

describe("SDK capability caller propagation", () => {
  const operations: Array<{
    name: string;
    run: (client: IOSCtrlProxyClient) => Promise<unknown>;
  }> = [
    { name: "database", run: (client) => client.listDatabasesForIos("com.example.sdk") },
    {
      name: "SQL",
      run: (client) => client.executeSQLForIos("com.example.sdk", "app.db", "select 1"),
    },
    {
      name: "storage capabilities",
      run: (client) => client.getStorageCapabilitiesForIos("com.example.sdk"),
    },
    { name: "tables", run: (client) => client.listTablesForIos("com.example.sdk", "app.db") },
    {
      name: "table data",
      run: (client) => client.getTableDataForIos("com.example.sdk", "app.db", "items"),
    },
    {
      name: "table structure",
      run: (client) => client.getTableStructureForIos("com.example.sdk", "app.db", "items"),
    },
    { name: "network mocking", run: (client) => client.syncNetworkMockRulesIfAvailable() },
    {
      name: "network error simulation",
      run: (client) => client.setNetworkErrorSimulation({ enabled: false }),
    },
    {
      name: "highlight",
      run: (client) =>
        client.requestAddHighlight("probe", {
          type: "circle",
          bounds: { x: 0, y: 0, width: 10, height: 10 },
        }),
    },
  ];

  test.each(operations)("$name preserves the typed retryable error", async ({ run }) => {
    const timer = new FakeTimer();
    const client = IOSCtrlProxyClient.createForTesting(
      { deviceId: "sdk-probe-test", platform: "ios", name: "fake" },
      8765,
      () => new FakeOpenSocket(),
      timer,
    );
    const failure = new SdkCapabilityQueryError("timeout", timeoutFailure.message);
    const ensure = spyOn(
      client.getSdkCapabilityTestHooks(),
      "ensureSdkCapability",
    ).mockRejectedValue(failure);
    try {
      await expect(run(client)).rejects.toBe(failure);
      expect(typedRefusalFields(failure)).toEqual({ code: "timeout", retryable: true });
    } finally {
      ensure.mockRestore();
      await client.close();
    }
  });
});
