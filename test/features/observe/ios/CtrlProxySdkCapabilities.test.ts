import { registerNetworkStateSessionCleanup } from "../../../../src/daemon/networkStateSessionCleanup";
import { FakeSessionCleanupManager } from "../../../fakes/FakeSessionCleanupManager";
import { NetworkState } from "../../../../src/utils/NetworkState";
import { logger } from "../../../../src/utils/logger";
import { getPerformanceMonitor } from "../../../../src/features/performance/PerformanceMonitor";
import { CtrlProxyHierarchyTelemetry } from "../../../../src/features/observe/ios/CtrlProxyHierarchyTelemetry";
import { HierarchyNavigationDetector } from "../../../../src/features/navigation/HierarchyNavigationDetector";
import { runWithAbortSignal } from "../../../../src/utils/AbortContext";
import { CtrlProxyNavigation } from "../../../../src/features/observe/ios/CtrlProxyNavigation";
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
import { drainUntil, drainMicrotasks } from "../../../helpers/fakeTimerStepping";

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
  return { probe, state, timer, requestManager, context };
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
  test("cached SDK availability is tri-state, app-bound and expires negative replies", async () => {
    const h = createHarness(() => ({ success: true, available: false }));
    expect(h.probe.getSdkAvailability("com.example.sdk")).toBeUndefined();
    await h.probe.requestSdkCapabilities(0);
    expect(h.probe.getSdkAvailability("com.example.sdk")).toBe(false);
    h.timer.advanceTime(5000);
    expect(h.probe.getSdkAvailability("com.example.sdk")).toBeUndefined();
    h.probe.seedForTesting("com.example.sdk", []);
    expect(h.probe.getSdkAvailability("com.example.sdk")).toBe(true);
    expect(h.probe.getSdkAvailability("com.example.other")).toBeUndefined();
    h.probe.invalidateSdkCapabilities();
    expect(h.probe.getSdkAvailability("com.example.sdk")).toBeUndefined();
    expect(h.state.attempts).toBe(1);
  });

  test.each(["abort", "deadline"] as const)(
    "the owner's %s leaves a longer-budget joiner alive",
    async (boundary) => {
      const h = createHarness(undefined, false);
      const controller = new AbortController();
      const warn = spyOn(logger, "warn").mockImplementation(() => {});
      const owner = runWithAbortSignal(
        controller.signal,
        () =>
          h.probe.ensureSdkCapability("database", undefined, {
            abortSignal: controller.signal,
            deadlineMs: h.timer.now() + 100,
          }),
        {
          getDeadlineMs: () => 100,
          textState: { dispatched: () => () => {} },
        },
      );
      const ownerResult = owner.catch((error: unknown) => error);
      await drainUntil(() => h.state.attempts === 1, { description: "owner probe" });
      const joiner = h.probe.ensureSdkCapability("highlight", undefined, {
        deadlineMs: h.timer.now() + 1000,
      });
      try {
        if (boundary === "abort") {
          controller.abort();
        } else {
          h.timer.advanceTime(100);
        }
        expect(await ownerResult).toMatchObject({
          code: boundary === "abort" ? "cancelled" : "timeout",
        });
        expect(h.requestManager.getPendingCount()).toBe(1);
        h.requestManager.resolve(h.requestManager.getPendingIds()[0]!, {
          ...available,
          totalTimeMs: 100,
        });
        expect(await joiner).toBe(true);
        expect(h.state.attempts).toBe(1);
        expect(h.timer.getPendingTimeoutCount()).toBe(0);
        expect(warn).not.toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
    },
  );

  test("a short-deadline joiner leaves its owner alive", async () => {
    const h = createHarness(undefined, false);
    const owner = h.probe.ensureSdkCapability("database");
    await drainUntil(() => h.state.attempts === 1, { description: "owner probe" });
    const joiner = h.probe
      .ensureSdkCapability("highlight", undefined, { deadlineMs: 100 })
      .catch((error: unknown) => error);
    h.timer.advanceTime(100);
    expect(await joiner).toMatchObject({ code: "timeout" });
    expect(h.requestManager.getPendingCount()).toBe(1);
    h.requestManager.resolve(h.requestManager.getPendingIds()[0]!, {
      ...available,
      totalTimeMs: 100,
    });
    expect(await owner).toBe(true);
    expect(h.timer.getPendingTimeoutCount()).toBe(0);
  });

  test.each([true, false])(
    "direct probe cancellation during connection (connected=%s) is debug-only",
    async (connected) => {
      const h = createHarness(undefined, false);
      const controller = new AbortController();
      const warn = spyOn(logger, "warn").mockImplementation(() => {});
      const debug = spyOn(logger, "debug").mockImplementation(() => {});
      h.context.ensureConnected = async () => {
        controller.abort();
        return connected;
      };
      try {
        expect(
          await h.probe.requestSdkCapabilities(0, { abortSignal: controller.signal }),
        ).toMatchObject({
          status: "unknown",
          error: { code: "cancelled" },
        });
        expect(h.state.attempts).toBe(0);
        expect(h.timer.getPendingTimeoutCount()).toBe(0);
        expect(warn).not.toHaveBeenCalled();
        expect(debug).toHaveBeenCalled();
      } finally {
        warn.mockRestore();
        debug.mockRestore();
      }
    },
  );

  test("all callers leaving cancels the shared request and permits a fresh probe", async () => {
    const h = createHarness(undefined, false);
    const first = new AbortController();
    const second = new AbortController();
    const a = h.probe
      .ensureSdkCapability("database", undefined, { abortSignal: first.signal })
      .catch((error: unknown) => error);
    const b = h.probe
      .ensureSdkCapability("highlight", undefined, { abortSignal: second.signal })
      .catch((error: unknown) => error);
    await drainUntil(() => h.state.attempts === 1, { description: "shared probe" });
    first.abort();
    expect(await a).toMatchObject({ code: "cancelled" });
    expect(h.requestManager.getPendingCount()).toBe(1);
    second.abort();
    expect(await b).toMatchObject({ code: "cancelled" });
    await drainMicrotasks(100);
    expect(h.requestManager.getPendingCount()).toBe(0);
    expect(h.timer.getPendingTimeoutCount()).toBe(0);
    const fresh = h.probe.ensureSdkCapability("database");
    await drainUntil(() => h.state.attempts === 2, { description: "fresh probe" });
    h.requestManager.resolve(h.requestManager.getPendingIds()[0]!, {
      ...available,
      totalTimeMs: 0,
    });
    expect(await fresh).toBe(true);
  });

  test("classifies a deadline expiring during connection acquisition as timeout", async () => {
    const h = createHarness(undefined, false);
    h.context.ensureConnected = async () => {
      h.timer.setCurrentTime(100);
      return true;
    };
    expect(await h.probe.requestSdkCapabilities(0, { deadlineMs: 100 })).toMatchObject({
      status: "unknown",
      error: { code: "timeout" },
    });
    expect(h.state.attempts).toBe(0);
  });

  test.each(["failure", "timeout", "deadline"] as const)(
    "release sends the simulation clear after mock-sync %s",
    async (boundary) => {
      const timer = new FakeTimer();
      const frames: Array<Record<string, unknown>> = [];
      const client = IOSCtrlProxyClient.createForTesting(
        { deviceId: "release-clear-test", platform: "ios", name: "fake" },
        8765,
        () => new FakeOpenSocket(),
        timer,
      );
      const send = spyOn(client, "sendMessage").mockImplementation((data) => {
        frames.push(JSON.parse(data));
        return true;
      });
      const ensure = spyOn(
        client.getSdkCapabilityTestHooks(),
        "ensureSdkCapability",
      ).mockImplementation(async () => {
        if (boundary === "deadline") {
          timer.setCurrentTime(100);
          return false;
        }
        throw new SdkCapabilityQueryError(
          boundary === "timeout" ? "timeout" : "not_connected",
          "probe failed",
        );
      });
      const warn = spyOn(logger, "warn").mockImplementation(() => {});
      try {
        if (boundary === "deadline") {
          // The app has no SDK and nothing was ever delivered, so there is nothing to clear.
          await expect(
            client.syncNetworkStateFromHost({ deadlineMs: 100 }),
          ).resolves.toBeUndefined();
        } else {
          await expect(client.syncNetworkStateFromHost({ deadlineMs: 100 })).rejects.toThrow(
            "probe failed",
          );
        }
        expect(frames).toContainEqual(
          expect.objectContaining({
            type: "set_network_error_simulation",
            enabled: false,
          }),
        );
        expect(warn).toHaveBeenCalledTimes(boundary === "deadline" ? 0 : 1);
      } finally {
        send.mockRestore();
        ensure.mockRestore();
        warn.mockRestore();
        await client.close();
      }
    },
  );

  test("bounds a probe by the caller deadline without starting a retry", async () => {
    const { probe, state, timer, requestManager } = createHarness(undefined, false);
    const pending = probe.ensureSdkCapability("database", undefined, {
      deadlineMs: timer.now() + 250,
    });
    let settled = false;
    const checked = pending.catch((error: unknown) => {
      settled = true;
      return error;
    });
    await drainUntil(() => requestManager.getPendingCount() === 1, {
      description: "bounded SDK probe",
    });
    timer.advanceTime(250);
    await drainUntil(() => settled, { description: "deadline settles SDK probe" });
    expect(await checked).toMatchObject({ code: "timeout", retryable: true });
    expect(state.attempts).toBe(1);
    expect(requestManager.getPendingCount()).toBe(0);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("cancels a waiter independently of its shared unbounded probe", async () => {
    const { probe, state, timer, requestManager } = createHarness(undefined, false);
    const background = probe.ensureSdkCapability("database");
    await drainUntil(() => state.attempts === 1, { description: "background SDK probe" });
    const controller = new AbortController();
    const pending = probe.ensureSdkCapability("highlight", undefined, {
      abortSignal: controller.signal,
    });
    let settled = false;
    const checked = pending.catch((error: unknown) => {
      settled = true;
      return error;
    });
    await Promise.resolve();
    controller.abort();
    await drainUntil(() => settled, { description: "cancelled SDK probe settles" });
    expect(await checked).toBeInstanceOf(SdkCapabilityQueryError);
    expect(state.attempts).toBe(1);
    expect(requestManager.getPendingCount()).toBe(1);
    requestManager.resolve(requestManager.getPendingIds()[0]!, { ...available, totalTimeMs: 0 });
    expect(await background).toBe(true);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("keeps the caller deadline while the shared probe retries on its own budget", async () => {
    const h = createHarness(undefined, false);
    let settled = false;
    const pending = h.probe
      .ensureSdkCapability("database", undefined, { deadlineMs: h.timer.now() + 20_000 })
      .catch((error: unknown) => {
        settled = true;
        return error;
      });
    await drainUntil(() => h.state.attempts === 1, {
      description: "SDK probe with explicit budget",
    });
    h.timer.advanceTime(IOS_HIERARCHY_REQUEST_TIMEOUT_MS);
    await drainMicrotasks(100);
    expect(settled).toBe(false);
    expect(h.state.attempts).toBe(2);
    h.timer.advanceTime(5000);
    await drainUntil(() => settled, { description: "explicit SDK budget expires" });
    expect(await pending).toMatchObject({ code: "timeout", retryable: true });
    expect(h.state.attempts).toBe(2);
    expect(h.timer.getPendingTimeoutCount()).toBe(0);
  });

  test("bounds connection acquisition as part of the probe deadline", async () => {
    const h = createHarness(undefined, false);
    h.context.ensureConnected = async () => await new Promise(() => {});
    let settled = false;
    const pending = h.probe
      .ensureSdkCapability("database", undefined, { deadlineMs: h.timer.now() + 250 })
      .catch((error: unknown) => {
        settled = true;
        return error;
      });
    h.timer.advanceTime(250);
    await drainUntil(() => settled, { description: "unanswered connection acquisition" });
    expect(await pending).toMatchObject({ code: "timeout", retryable: true });
    expect(h.state.attempts).toBe(0);
    expect(h.timer.getPendingTimeoutCount()).toBe(0);
  });

  test("does not dispatch a probe with an exhausted budget", async () => {
    const { probe, state, timer } = createHarness(undefined, false);
    await expect(
      probe.ensureSdkCapability("database", undefined, { deadlineMs: timer.now() }),
    ).rejects.toMatchObject({ code: "timeout" });
    expect(state.attempts).toBe(0);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

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

  test("keeps the waiter's capability when a stale successful reply is superseded", async () => {
    const h = createHarness(undefined, false);
    const pending = h.probe.ensureSdkCapability("database");
    await drainUntil(() => h.state.attempts === 1, { description: "SDK database probe" });
    h.probe.invalidateSdkCapabilities();
    h.requestManager.resolve(h.requestManager.getPendingIds()[0]!, {
      ...available,
      totalTimeMs: 0,
    });
    await expect(pending).rejects.toMatchObject({
      capability: "database",
      probeGeneration: 0,
      currentGeneration: 1,
    });
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

describe("SDK capability caller budgets", () => {
  const operations: Array<{ name: string; run: (client: IOSCtrlProxyClient) => Promise<unknown> }> =
    [
      {
        name: "SQL",
        run: (client) =>
          client.executeSQLForIos("com.example.sdk", "app.db", "select 1", { timeoutMs: 250 }),
      },
      { name: "databases", run: (client) => client.listDatabasesForIos("com.example.sdk", 250) },
      {
        name: "storage capabilities",
        run: (client) => client.getStorageCapabilitiesForIos("com.example.sdk", 250),
      },
      {
        name: "tables",
        run: (client) => client.listTablesForIos("com.example.sdk", "app.db", 250),
      },
      {
        name: "table data",
        run: (client) =>
          client.getTableDataForIos("com.example.sdk", "app.db", "items", {
            page: { limit: 50, offset: 0 },
            timeoutMs: 250,
          }),
      },
      {
        name: "table structure",
        run: (client) => client.getTableStructureForIos("com.example.sdk", "app.db", "items", 250),
      },
      {
        name: "network simulation",
        run: (client) => client.setNetworkErrorSimulation({ enabled: false }, 250),
      },
      {
        name: "highlight",
        run: (client) =>
          client.requestAddHighlight(
            "budget",
            { type: "circle", bounds: { x: 0, y: 0, width: 10, height: 10 } },
            250,
          ),
      },
    ];

  test.each(operations)("$name includes its capability gate in the timeout", async ({ run }) => {
    const h = createHarness(undefined, false);
    const client = IOSCtrlProxyClient.createForTesting(
      { deviceId: "budget-test", platform: "ios", name: "fake" },
      8765,
      () => new FakeOpenSocket(),
      h.timer,
    );
    const ensure = spyOn(
      client.getSdkCapabilityTestHooks(),
      "ensureSdkCapability",
    ).mockImplementation((capability, bundleId, options) =>
      h.probe.ensureSdkCapability(capability, bundleId, options),
    );
    let settled = false;
    const checked = run(client).catch((error: unknown) => {
      settled = true;
      return error;
    });
    try {
      await drainUntil(() => h.state.attempts === 1, { description: "caller capability gate" });
      h.timer.advanceTime(250);
      await drainUntil(() => settled, { description: "caller budget expires" });
      expect(await checked).toMatchObject({ code: "timeout", retryable: true });
      expect(h.state.attempts).toBe(1);
      expect(h.timer.getPendingTimeoutCount()).toBe(0);
    } finally {
      ensure.mockRestore();
      await client.close();
    }
  });

  test.each(["grace", "deadline", "abort"] as const)(
    "successful launch with an unanswered probe settles at %s",
    async (boundary) => {
      const h = createHarness(undefined, false);
      const client = IOSCtrlProxyClient.createForTesting(
        { deviceId: "launch-budget-test", platform: "ios", name: "fake" },
        8765,
        () => new FakeOpenSocket(),
        h.timer,
      );
      const launch = spyOn(CtrlProxyNavigation.prototype, "requestLaunchApp").mockResolvedValue({
        success: true,
        totalTimeMs: 0,
      });
      const refresh = spyOn(
        client.testHooks.sdkCapability,
        "refreshSdkCapabilitiesAndSync",
      ).mockImplementation((options) => h.probe.refreshSdkCapabilitiesAndSync(options));
      const controller = new AbortController();
      const deadline = h.timer.now() + 200;
      let settled = false;
      const pending = runWithAbortSignal(undefined, () =>
        client.requestLaunchApp(
          "com.example.sdk",
          boundary === "deadline" ? 200 : undefined,
          undefined,
          { coldBoot: false, signal: controller.signal },
        ),
      );
      void pending.then(() => {
        settled = true;
      });
      try {
        await drainUntil(() => h.state.attempts === 1, { description: "post-launch SDK probe" });
        h.timer.advanceTime(boundary === "grace" ? 1000 : 200);
        if (boundary === "abort") {
          controller.abort();
        }
        await drainUntil(() => settled, { description: "launch settles within refresh grace" });
        expect(await pending).toMatchObject({ success: true });
        expect(h.timer.now()).toBe(boundary === "grace" ? 1000 : deadline);
        expect(h.state.attempts).toBe(1);
        expect(h.requestManager.getPendingCount()).toBe(0);
        expect(h.timer.getPendingTimeoutCount()).toBe(0);
      } finally {
        refresh.mockRestore();
        launch.mockRestore();
        await client.close();
      }
    },
  );

  test("the default release cleanup bounds the real iOS capability gate at ten seconds", async () => {
    const h = createHarness(undefined, false);
    const deviceId = "release-budget-test";
    const client = IOSCtrlProxyClient.createForTesting(
      { deviceId, platform: "ios", name: "fake" },
      8765,
      () => new FakeOpenSocket(),
      h.timer,
    );
    const existing = spyOn(IOSCtrlProxyClient, "getExistingInstance").mockReturnValue(client);
    const ensure = spyOn(
      client.getSdkCapabilityTestHooks(),
      "ensureSdkCapability",
    ).mockImplementation((capability, bundleId, options) =>
      h.probe.ensureSdkCapability(capability, bundleId, options),
    );
    const state = new NetworkState({
      timer: h.timer,
      notifier: { notifyResourceUpdated: () => {} },
    });
    state.startSimulation(deviceId, "timeout", 30, null, "released-session");
    const manager = new FakeSessionCleanupManager();
    registerNetworkStateSessionCleanup(manager, { state: () => state, timer: h.timer });
    manager.release("released-session", deviceId);
    let settled = false;
    const pending = manager.pendingCleanups[0]!.cleanup.then(() => {
      settled = true;
    });
    try {
      await drainUntil(() => h.state.attempts === 1, { description: "release SDK probe" });
      h.timer.advanceTime(10_000);
      await drainUntil(() => settled, { description: "release cleanup deadline" });
      await pending;
      expect(h.state.attempts).toBe(1);
      expect(h.requestManager.getPendingCount()).toBe(0);
      expect(h.timer.getPendingTimeoutCount()).toBe(0);
      expect(state.getSimulation(deviceId)).toBeNull();
    } finally {
      existing.mockRestore();
      ensure.mockRestore();
      await client.close();
    }
  });

  test("ambient deadline and cancellation reach a network mocking probe", async () => {
    const h = createHarness(undefined, false);
    const controller = new AbortController();
    const client = IOSCtrlProxyClient.createForTesting(
      { deviceId: "ambient-budget-test", platform: "ios", name: "fake" },
      8765,
      () => new FakeOpenSocket(),
      h.timer,
    );
    const ensure = spyOn(
      client.getSdkCapabilityTestHooks(),
      "ensureSdkCapability",
    ).mockImplementation((capability, bundleId, options) =>
      h.probe.ensureSdkCapability(capability, bundleId, options),
    );
    const deadlineMs = h.timer.now() + 100;
    let settled = false;
    const pending = runWithAbortSignal(
      controller.signal,
      () => client.syncNetworkMockRulesIfAvailable(),
      {
        getDeadlineMs: () => deadlineMs,
        textState: { dispatched: () => () => {} },
      },
    ).catch((error: unknown) => {
      settled = true;
      return error;
    });
    try {
      await drainUntil(() => h.state.attempts === 1, { description: "ambient SDK probe" });
      h.timer.advanceTime(100);
      await drainUntil(() => settled, { description: "ambient deadline settles probe" });
      expect(await pending).toMatchObject({ code: "timeout" });
      expect(h.state.attempts).toBe(1);
    } finally {
      ensure.mockRestore();
      await client.close();
    }
  });
});

describe("best-effort SDK refresh diagnostics", () => {
  test.each(["connected", "foreground", "launch"] as const)(
    "%s warns with the original transport error and debugs only supersession",
    async (source) => {
      const timer = new FakeTimer();
      const client = IOSCtrlProxyClient.createForTesting(
        { deviceId: "refresh-log-test", platform: "ios", name: "fake" },
        8765,
        () => new FakeOpenSocket(),
        timer,
      );
      const failure = new Error("socket transport failed");
      const superseded = new SdkCapabilityProbeSupersededError("hierarchy", 0, 1);
      const refresh = spyOn(client.testHooks.sdkCapability, "refreshSdkCapabilitiesAndSync");
      const launch = spyOn(CtrlProxyNavigation.prototype, "requestLaunchApp").mockResolvedValue({
        success: true,
        totalTimeMs: 0,
      });
      const monitoring = spyOn(getPerformanceMonitor(), "startMonitoring").mockImplementation(
        () => {},
      );
      const warn = spyOn(logger, "warn").mockImplementation(() => {});
      const debug = spyOn(logger, "debug").mockImplementation(() => {});
      const detector = new HierarchyNavigationDetector(
        { recordHierarchyNavigation: async () => {} },
        { timer },
      );
      try {
        for (const error of [failure, superseded]) {
          warn.mockClear();
          debug.mockClear();
          refresh.mockRejectedValue(error);
          if (source === "connected") {
            client
              .getInboundMessageTestHooks()
              .processMessage({ type: "connected", supportedCommands: ["get_sdk_capabilities"] });
          } else if (source === "foreground") {
            new CtrlProxyHierarchyTelemetry({
              timer,
              deviceId: "refresh-log-test",
              sdkCapability: client.testHooks.sdkCapability,
              buildContext: { ensureBuildContext: () => {} },
              lastForegroundBundleId: null,
              getHierarchyNavigationDetector: () => detector,
            }).handleHierarchyUpdateForNavigation({
              updatedAt: timer.now(),
              packageName: "com.example.sdk",
              hierarchy: { text: "App" },
            });
          } else {
            expect(await client.requestLaunchApp("com.example.sdk")).toMatchObject({
              success: true,
            });
          }
          await drainUntil(
            () =>
              [...warn.mock.calls, ...debug.mock.calls].some(([message]) =>
                message.includes("SDK capability refresh"),
              ),
            { description: "refresh diagnostic" },
          );
          const warnings = warn.mock.calls.filter(([message]) =>
            message.includes("SDK capability refresh"),
          );
          if (error === failure) {
            expect(warnings).toHaveLength(1);
            expect(warnings[0]![1]).toBe(failure);
          } else {
            expect(warnings).toHaveLength(0);
            expect(
              debug.mock.calls.some(([message]) =>
                message.includes("SDK capability refresh superseded"),
              ),
            ).toBe(true);
          }
        }
      } finally {
        detector.reset();
        refresh.mockRestore();
        launch.mockRestore();
        monitoring.mockRestore();
        warn.mockRestore();
        debug.mockRestore();
        await client.close();
      }
    },
  );
});

test.each([
  "sent",
  "unconfirmed",
  "noCapability",
  "disabled",
  "superseded",
  "failed",
  "throw",
  "simulation-false",
] as const)("release network sync outcome %s always syncs simulation", async (outcome) => {
  const timer = new FakeTimer();
  const client = IOSCtrlProxyClient.createForTesting(
    { deviceId: "outcome-test", platform: "ios", name: "fake" },
    8765,
    () => new FakeOpenSocket(),
    timer,
  );
  const frames: string[] = [];
  const send = spyOn(client, "sendMessage").mockImplementation((data) => {
    frames.push(JSON.parse(data).type);
    return outcome !== "simulation-false";
  });
  const sync = spyOn(client, "syncNetworkMockRulesIfAvailable").mockImplementation(async () => {
    if (outcome === "throw") {
      throw new Error("probe exploded");
    }
    if (outcome === "unconfirmed") {
      return { outcome: "sent", report: { status: "unconfirmed" } };
    }
    return { outcome: outcome === "simulation-false" ? "sent" : outcome };
  });
  try {
    const pending = client.syncNetworkStateFromHost();
    // noCapability with no rules ever delivered has nothing to clear (#15179).
    if (["failed", "throw", "superseded", "simulation-false"].includes(outcome)) {
      await expect(pending).rejects.toThrow("iOS network");
    } else {
      await expect(pending).resolves.toBeUndefined();
    }
    expect(frames).toContain("set_network_error_simulation");
  } finally {
    send.mockRestore();
    sync.mockRestore();
    await client.close();
  }
});
