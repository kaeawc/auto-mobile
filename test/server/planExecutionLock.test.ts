import { AndroidAvdProvenanceCache } from "../../src/utils/AndroidAvdProvenanceCache";
import { installHermeticServerFixture } from "../helpers/hermeticServerFixture";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { McpTestFixture } from "../fixtures/mcpTestFixture";
import { FakePlanExecutionLock } from "../fakes/FakePlanExecutionLock";
import { FakeAvdManager } from "../fakes/FakeAvdManager";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { ToolRegistry } from "../../src/server/toolRegistry";
import type { ToolSelectionSessionManager } from "../../src/features/toolSelection/selectionSessionResolver";
import {
  ExecutionTrackerPlanExecutionLock,
  type PlanExecutionLockScopeProvider,
} from "../../src/server/PlanExecutionLock";
import { ExecutionTracker } from "../../src/server/executionTracker";
import type { PlanExecutionLockScope } from "../../src/utils/ServerConfig";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import {
  resetDeviceToolsDependencies,
  setDeviceToolsDependencies,
} from "../../src/server/deviceTools";
import { z } from "zod/v4";

class FakePlanExecutionLockScopeProvider implements PlanExecutionLockScopeProvider {
  constructor(private scope: PlanExecutionLockScope) {}

  getScope(): PlanExecutionLockScope {
    return this.scope;
  }

  setScope(scope: PlanExecutionLockScope): void {
    this.scope = scope;
  }
}

describe("Plan execution lock", () => {
  let fixture: McpTestFixture;
  let fakeDeviceUtils: FakeDeviceUtils;
  let fakePlanExecutionLock: FakePlanExecutionLock;

  beforeAll(async () => {
    // Set up FakeDeviceUtils to avoid real ADB commands
    fakeDeviceUtils = new FakeDeviceUtils();
    // Configure with empty device list since we're testing plan lock, not device functionality
    fakeDeviceUtils.setBootedDevices("android", []);

    setDeviceToolsDependencies({
      deviceManagerFactory: () => fakeDeviceUtils,
      // listDeviceImages resolves AVD provenance; never touch the real SDK here.
      avdManagerFactory: () => new FakeAvdManager(),
    });

    fakePlanExecutionLock = new FakePlanExecutionLock({
      blocked: false,
      scope: "session",
    });

    fixture = new McpTestFixture({
      planExecutionLock: fakePlanExecutionLock,
    });
    await fixture.setup();
  });

  afterAll(async () => {
    // Reset dependencies to avoid test pollution
    if (fixture) {
      await fixture.teardown();
    }
    AndroidAvdProvenanceCache.resetForTests();
    resetDeviceToolsDependencies();
  });

  test("rejects MCP tool calls when a plan is executing", async () => {
    fakePlanExecutionLock.setDecision({
      blocked: true,
      scope: "session",
      reason: "plan execution in progress",
    });

    const { client } = fixture.getContext();
    await expect(
      client.request(
        {
          method: "tools/call",
          params: {
            name: "listDeviceImages",
            arguments: { platform: "android" },
          },
        },
        z.any(),
      ),
    ).rejects.toThrow("plan execution in progress");
  });

  test("allows MCP tool calls when no plan is executing", async () => {
    fakePlanExecutionLock.setDecision({
      blocked: false,
      scope: "session",
    });

    const { client } = fixture.getContext();
    const result = await client.request(
      {
        method: "tools/call",
        params: {
          name: "listDeviceImages",
          arguments: { platform: "android" },
        },
      },
      z.any(),
    );

    expect(result).toHaveProperty("content");
  });

  test("scopes blocking to session or global", () => {
    const tracker = new ExecutionTracker();
    const scopeProvider = new FakePlanExecutionLockScopeProvider("session");
    const lock = new ExecutionTrackerPlanExecutionLock(tracker, scopeProvider);

    const execution = tracker.startExecution("executePlan", undefined, "session-a");
    try {
      const sessionDecision = lock.evaluate({
        toolName: "tapOn",
        sessionUuid: "session-a",
      });
      expect(sessionDecision.blocked).toBe(true);
      expect(sessionDecision.scope).toBe("session");

      const otherSessionDecision = lock.evaluate({
        toolName: "tapOn",
        sessionUuid: "session-b",
      });
      expect(otherSessionDecision.blocked).toBe(false);

      scopeProvider.setScope("global");
      const globalDecision = lock.evaluate({
        toolName: "tapOn",
        sessionUuid: "session-b",
      });
      expect(globalDecision.blocked).toBe(true);
      expect(globalDecision.scope).toBe("global");
    } finally {
      tracker.endExecution(execution.id);
    }
  });

  test.each(["session", "global"] as const)(
    "allows only read-only observation during a plan in %s scope",
    (scope) => {
      const tracker = new ExecutionTracker(new FakeTimer(), new FakeIdGenerator());
      const lock = new ExecutionTrackerPlanExecutionLock(
        tracker,
        new FakePlanExecutionLockScopeProvider(scope),
      );
      const execution = tracker.startExecution("executePlan", undefined, "session-a:phone");
      try {
        expect(lock.evaluate({ toolName: "observe", sessionUuid: "session-a:phone" })).toEqual({
          blocked: false,
          scope,
        });
        for (const toolName of ["tapOn", "executePlan", "startTestRecording", "recordSteps"]) {
          expect(lock.evaluate({ toolName, sessionUuid: "session-a:phone" })).toEqual({
            blocked: true,
            scope,
            reason: "plan execution in progress",
          });
        }
        expect(lock.evaluate({ toolName: "tapOn", sessionUuid: "unrelated-session" }).blocked).toBe(
          scope === "global",
        );
      } finally {
        tracker.endExecution(execution.id);
      }
      expect(lock.evaluate({ toolName: "tapOn", sessionUuid: "session-a:phone" }).blocked).toBe(
        false,
      );
    },
  );
});

describe("Plan execution lock through session routing", () => {
  const toolName = "planLockRoutingProbe";
  const tracker = new ExecutionTracker(new FakeTimer(), new FakeIdGenerator());
  const lock = new ExecutionTrackerPlanExecutionLock(
    tracker,
    new FakePlanExecutionLockScopeProvider("session"),
  );
  const sessions: ToolSelectionSessionManager = {
    getDeviceLabels: (sessionUuid) =>
      sessionUuid === "plan-base" || sessionUuid === "other-base"
        ? { phone: `${sessionUuid}:phone`, tablet: `${sessionUuid}:tablet` }
        : undefined,
  };
  let explicitFixture: McpTestFixture;
  let routingFixture: McpTestFixture;
  let restorePipeline: () => void;
  let originalRepository: Parameters<typeof ToolRegistry.setToolCallRepositoryForTesting>[0];

  beforeAll(async () => {
    originalRepository = ToolRegistry["toolCallRepository"];
    ToolRegistry.setToolCallRepositoryForTesting({ recordToolCall: async () => {} });
    // Reuse the pipeline seam: resolve no device and bypass DB-backed finalization.
    restorePipeline = ToolRegistry.setPipelineOverridesForTesting({
      executionTargetResolver: {
        resolveExecutionTarget: async ({ args }) => ({
          args,
          baseSessionUuid: args.sessionUuid,
          sessionUuid: args.sessionUuid,
          device: undefined,
          internalCall: false,
          shouldResolveDevice: false,
        }),
      },
      afterToolCall: {
        handle: async ({ response }) => ({ durationMs: 0, finalizedResponse: response }),
      },
    });
    const response = () => ({ content: [{ type: "text" as const, text: "probe executed" }] });
    ToolRegistry.registerDeviceAware(
      toolName,
      "Plan lock routing probe",
      z.object({ device: z.string().optional(), sessionUuid: z.string().optional() }),
      async () => response(),
      { nonDeviceHandler: async () => response() },
    );
    explicitFixture = new McpTestFixture({
      planExecutionLock: lock,
      toolSelectionSessionManager: sessions,
    });
    routingFixture = new McpTestFixture({
      planExecutionLock: lock,
      toolSelectionSessionManager: sessions,
      sessionContext: { initialSessionToolBinding: "plan-base" },
    });
    await explicitFixture.setup();
    await routingFixture.setup();
  });

  afterAll(async () => {
    await explicitFixture.teardown();
    await routingFixture.teardown();
    ToolRegistry.unregister(toolName);
    restorePipeline();
    ToolRegistry.setToolCallRepositoryForTesting(originalRepository);
  });

  test.each([
    {
      name: "gates the derived device label with an explicit base UUID",
      route: "explicit",
      args: { sessionUuid: "plan-base", device: "phone" },
      activeUuid: "plan-base:phone",
      blocked: true,
    },
    {
      name: "gates the derived device label with only a routing base UUID",
      route: "routing",
      args: { device: "phone" },
      activeUuid: "plan-base:phone",
      blocked: true,
    },
    {
      name: "allows a sibling device label",
      route: "routing",
      args: { device: "tablet" },
      activeUuid: "plan-base:phone",
      blocked: false,
    },
    {
      name: "allows the same device label in a different session",
      route: "explicit",
      args: { sessionUuid: "other-base", device: "phone" },
      activeUuid: "plan-base:phone",
      blocked: false,
    },
    {
      name: "does not gate a derived label against an active base UUID",
      route: "routing",
      args: { device: "phone" },
      activeUuid: "plan-base",
      blocked: false,
    },
    {
      name: "gates a matching explicit UUID without a device label",
      route: "explicit",
      args: { sessionUuid: "provided-session" },
      activeUuid: "provided-session",
      blocked: true,
    },
    {
      name: "allows a different explicit UUID without a device label",
      route: "explicit",
      args: { sessionUuid: "provided-session" },
      activeUuid: "other-session",
      blocked: false,
    },
    {
      name: "gates a matching routing UUID without a device label",
      route: "routing",
      args: {},
      activeUuid: "plan-base",
      blocked: true,
    },
    {
      name: "allows a different routing UUID without a device label",
      route: "routing",
      args: {},
      activeUuid: "other-session",
      blocked: false,
    },
  ])("$name", async ({ route, args, activeUuid, blocked }) => {
    const execution = tracker.startExecution("executePlan", undefined, activeUuid);
    try {
      const fixture = route === "explicit" ? explicitFixture : routingFixture;
      const request = fixture
        .getContext()
        .client.request(
          { method: "tools/call", params: { name: toolName, arguments: args } },
          z.any(),
        );
      if (blocked) {
        await expect(request).rejects.toThrow("plan execution in progress");
      } else {
        expect(await request).toMatchObject({
          content: [{ type: "text", text: "probe executed" }],
        });
      }
    } finally {
      tracker.endExecution(execution.id);
    }
  });
});

// App-resource registration starts device discovery independently of deviceTools.
let restoreHermeticServer: () => void;
beforeAll(() => {
  restoreHermeticServer = installHermeticServerFixture();
});
afterAll(() => restoreHermeticServer());
