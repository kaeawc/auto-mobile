import { afterAll, beforeAll, beforeEach, describe, expect, test, spyOn } from "bun:test";
import { z } from "zod/v4";
import { stripNavigationInternalParams, ToolRegistryClass } from "../../src/server/toolRegistry";
import { INTERNAL_NO_DIFF_PARAM } from "../../src/server/internalToolCall";
import { reportToolDispatched } from "../../src/utils/ToolDispatchContext";
import { FakeTimer } from "../fakes/FakeTimer";
import { NavigationGraphManager } from "../../src/features/navigation/NavigationGraphManager";
import { NavigationRepository } from "../../src/db/navigationRepository";
import { TestCoverageRepository } from "../../src/db/testCoverageRepository";
import {
  installInMemoryNavManager,
  type InMemoryNavManagerHarness,
} from "../helpers/navigationTestHarness";

describe("navigation tool call recording", () => {
  test("does not persist internal execution metadata in navigation arguments", () => {
    expect(
      stripNavigationInternalParams({
        text: "Continue",
        sessionUuid: "old-session",
        __mcpRequestDeadlineMs: 1,
        __mcpRequestTimeoutMs: 2,
        __futureInternal: true,
        _foo: "keep",
        sessionUuidX: "keep",
        session: "keep",
        __mcpSessionId: "mcp-session",
        __executionId: "execution-1",
        __executionStartTime: 123,
        [INTERNAL_NO_DIFF_PARAM]: true,
      }),
    ).toEqual({ text: "Continue", _foo: "keep", sessionUuidX: "keep", session: "keep" });
  });
});

describe("navigation recorder handler outcomes", () => {
  let harness: InMemoryNavManagerHarness;
  let registry: ToolRegistryClass;
  let timer: FakeTimer;
  let restore: () => void;

  beforeAll(async () => {
    harness = await installInMemoryNavManager();
    timer = new FakeTimer();
    harness.manager = NavigationGraphManager.createForTesting(
      new NavigationRepository(harness.db),
      new TestCoverageRepository(undefined, harness.db),
      timer,
    );
    NavigationGraphManager.setInstanceForTesting(harness.manager);
    registry = new ToolRegistryClass(timer);
    restore = registry.setPipelineOverridesForTesting({
      executionTargetResolver: {
        resolveExecutionTarget: async () => ({
          shouldResolveDevice: true,
          device: { deviceId: "fake", platform: "android" },
        }),
      },
      // Exercise the handler through the audit seam without real device auditing.
      auditRunner: {
        run: async (input) => input.handler(input.device, input.args, input.progress, input.signal),
      },
      afterToolCall: {
        handle: async (input) => ({ finalizedResponse: input.response, durationMs: 0 }),
      },
      planLifecycleManager: { afterExecution: async () => {} },
    });
    // Pay the one-time cold-start cost of the first recorded tool call and navigation write
    // (~5 ms, far more on a loaded runner) outside the per-test budget. beforeEach clears the
    // graph, so nothing from this throwaway call is visible to a test.
    registry.registerDeviceAware("tapOn", "fake", z.object({}), async () => {
      throw new Error("warmup");
    });
    await registry
      .getTool("tapOn")!
      .handler({ text: "warmup" })
      .catch(() => {});
    timer.setCurrentTime(1_000_000);
    await navigate("Splash");
    timer.setCurrentTime(1_011_000);
    await navigate("Home");
    await harness.manager.getEdgesFrom("Splash");
    await harness.manager.getStats();
  });
  beforeEach(async () => {
    await harness.manager.clearAllGraphs();
    timer.setCurrentTime(1_000_000);
    await navigate("Splash");
    timer.setCurrentTime(1_010_000);
  });
  afterAll(async () => {
    restore();
    await harness.dispose();
  });

  async function navigate(destination: string): Promise<void> {
    await harness.manager.recordNavigationEvent({
      applicationId: "com.x",
      destination,
      source: "sdk",
      arguments: {},
      metadata: {},
      timestamp: timer.now(),
      sequenceNumber: 0,
    });
  }
  async function expectUnattributedAdvance(): Promise<void> {
    timer.setCurrentTime(1_011_000);
    await navigate("Home");
    expect((await harness.manager.getEdgesFrom("Splash"))[0].interaction).toBeUndefined();
    expect((await harness.manager.getStats()).toolCallHistorySize).toBe(0);
  }

  test("failed tap throwing element not found cannot label Splash -> Home", async () => {
    registry.registerDeviceAware("tapOn", "fake", z.object({}), async () => {
      throw new Error("element not found");
    });
    await expect(registry.getTool("tapOn")!.handler({ text: "Does not exist" })).rejects.toThrow(
      "element not found",
    );
    await expectUnattributedAdvance();
  });

  test.each([
    { success: false },
    { isError: true, content: [{ type: "text", text: "element not found" }] },
    { structuredContent: { success: false } },
    { content: [{ type: "text", text: '{"success":false}' }] },
  ])("failed result %j cannot label an unrelated transition", async (response) => {
    registry.registerDeviceAware("tapOn", "fake", z.object({}), async () => response);
    await registry.getTool("tapOn")!.handler({ text: "Does not exist" });
    await expectUnattributedAdvance();
  });

  test("audit-runner rejection withdraws the recorded call", async () => {
    const restoreAudit = registry.setPipelineOverridesForTesting({
      auditRunner: {
        run: async () => {
          throw new Error("audit failed");
        },
      },
    });
    registry.registerDeviceAware("tapOn", "fake", z.object({}), async () => ({ success: true }));
    try {
      await expect(registry.getTool("tapOn")!.handler({ text: "Next" })).rejects.toThrow(
        "audit failed",
      );
      await expectUnattributedAdvance();
    } finally {
      restoreAudit();
    }
  });

  test("abort withdraws immediately even while the handler is still running", async () => {
    const controller = new AbortController();
    const completion = Promise.withResolvers<{ success: boolean }>();
    const started = Promise.withResolvers<void>();
    registry.registerDeviceAware("tapOn", "fake", z.object({}), async () => {
      started.resolve();
      return completion.promise;
    });
    const pending = registry
      .getTool("tapOn")!
      .handler({ text: "Next" }, undefined, controller.signal);
    await started.promise;
    controller.abort();
    try {
      await expectUnattributedAdvance();
    } finally {
      completion.resolve({ success: true });
      await pending;
    }
  });

  test("success stays eligible after settlement and ignores later aborts", async () => {
    const controller = new AbortController();
    registry.registerDeviceAware("tapOn", "fake", z.object({}), async () => ({ success: true }));
    await registry.getTool("tapOn")!.handler({ text: "Next" }, undefined, controller.signal);
    controller.abort();
    expect((await harness.manager.getStats()).toolCallHistorySize).toBe(1);
    await navigate("Home");
    expect((await harness.manager.getEdgesFrom("Splash"))[0].interaction?.args).toEqual({
      text: "Next",
    });
  });

  describe("dispatch reporting (#10196)", () => {
    // The tool starts at 1_010_000 and spends 3 s finding its target before the tap.
    function slowTap(reportDispatch: boolean): () => Promise<{ success: boolean }> {
      return async () => {
        timer.setCurrentTime(1_013_000);
        if (reportDispatch) {
          reportToolDispatched();
        }
        timer.setCurrentTime(1_013_300);
        await navigate("Home");
        return { success: true };
      };
    }

    test("a tool that reports its dispatch is attributed from it, not from its start", async () => {
      registry.registerDeviceAware("tapOn", "fake", z.object({}), slowTap(true));

      await registry.getTool("tapOn")!.handler({ text: "Continue" });

      expect((await harness.manager.getEdgesFrom("Splash"))[0].interaction?.args).toEqual({
        text: "Continue",
      });
    });

    test("a tool that reports nothing is still measured from its start", async () => {
      registry.registerDeviceAware("tapOn", "fake", z.object({}), slowTap(false));

      await registry.getTool("tapOn")!.handler({ text: "Continue" });

      expect((await harness.manager.getEdgesFrom("Splash"))[0].interaction).toBeUndefined();
    });

    test("a failed tool that reported its dispatch is still withdrawn", async () => {
      registry.registerDeviceAware("tapOn", "fake", z.object({}), async () => {
        reportToolDispatched();
        return { success: false };
      });

      await registry.getTool("tapOn")!.handler({ text: "Continue" });

      await expectUnattributedAdvance();
    });
  });

  describe("app lifecycle tools forget the app's screen (#10193)", () => {
    test.each([
      ["terminateApp", { appId: "com.x" }],
      ["crashApp", { appId: "com.x" }],
      ["uninstallApp", { appId: "com.x" }],
      ["launchApp", { appId: "com.x", coldBoot: true }],
      ["launchApp", { appId: "com.x", clearAppData: true }],
      // installApp names an artifact, not the app: installing over a running app restarts it.
      ["installApp", { artifactPath: "/tmp/app.apk" }],
    ])("%s %j leaves the next transition without an edge", async (tool, args) => {
      registry.registerDeviceAware(tool, "fake", z.object({}), async () => ({ success: true }));
      await registry.getTool(tool)!.handler(args);

      timer.setCurrentTime(1_011_000);
      await navigate("Home");

      expect(await harness.manager.getEdgesFrom("Splash")).toEqual([]);
    });

    test.each([
      ["launchApp", { appId: "com.x" }],
      ["appLifecycle", { appId: "com.x", action: "killBackgrounded" }],
    ])("%s %j keeps the remembered screen", async (tool, args) => {
      registry.registerDeviceAware(tool, "fake", z.object({}), async () => ({ success: true }));
      await registry.getTool(tool)!.handler(args);

      timer.setCurrentTime(1_011_000);
      await navigate("Home");

      expect((await harness.manager.getEdgesFrom("Splash")).map((edge) => edge.to)).toEqual([
        "Home",
      ]);
    });
  });

  test("navigation while a handler is running keeps its tap attribution", async () => {
    const completion = Promise.withResolvers<{ success: boolean }>();
    const started = Promise.withResolvers<void>();
    registry.registerDeviceAware("tapOn", "fake", z.object({}), async () => {
      started.resolve();
      return completion.promise;
    });
    const pending = registry.getTool("tapOn")!.handler({ text: "Next" });
    await started.promise;
    try {
      await navigate("Home");
      expect((await harness.manager.getEdgesFrom("Splash"))[0].interaction?.args).toEqual({
        text: "Next",
      });
      expect((await harness.manager.getStats()).toolCallHistorySize).toBe(0);
    } finally {
      completion.resolve({ success: true });
      await pending;
    }
  });
});

describe("navigation recorder caller arguments", () => {
  let harness: InMemoryNavManagerHarness;
  let registry: ToolRegistryClass;
  let record: ReturnType<typeof spyOn<InMemoryNavManagerHarness["manager"], "recordToolCall">>;
  let restorePipelineOverrides: (() => void) | undefined;

  beforeAll(async () => {
    harness = await installInMemoryNavManager();
    registry = new ToolRegistryClass(new FakeTimer());
    record = spyOn(harness.manager, "recordToolCall");
    restorePipelineOverrides = registry.setPipelineOverridesForTesting({
      executionTargetResolver: {
        resolveExecutionTarget: async () => ({
          shouldResolveDevice: true,
          device: { deviceId: "fake", platform: "android" },
        }),
      },
      afterToolCall: {
        handle: async (input) => ({ finalizedResponse: input.response, durationMs: 0 }),
      },
      planLifecycleManager: { afterExecution: async () => {} },
    });
    registry.registerDeviceAware("tapOn", "fake", z.object({}), async () => ({ success: true }));
  });

  afterAll(async () => {
    record?.mockRestore();
    restorePipelineOverrides?.();
    await harness?.dispose();
  });

  test("recordToolCall receives only replayable caller arguments", async () => {
    await registry.getTool("tapOn")!.handler({
      text: "Continue",
      sessionUuid: "old",
      __mcpRequestTimeoutMs: 2,
      __mcpRequestDeadlineMs: 1,
      __futureInternal: true,
      _foo: "keep",
      sessionUuidX: "keep",
      session: "keep",
    });
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0][1]).toEqual({
      text: "Continue",
      _foo: "keep",
      sessionUuidX: "keep",
      session: "keep",
    });
  });

  test("recordToolCall carries the device the tool call runs on", async () => {
    record.mockClear();
    await registry.getTool("tapOn")!.handler({ text: "Continue" });
    expect(record.mock.calls[0][3]).toBe("fake");
  });
});
