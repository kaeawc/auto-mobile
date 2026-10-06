import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { z } from "zod/v4";
import { NavigationRepository } from "../../../src/db/navigationRepository";
import { TestCoverageRepository } from "../../../src/db/testCoverageRepository";
import { NavigateTo } from "../../../src/features/navigation/NavigateTo";
import { NavigationGraphManager } from "../../../src/features/navigation/NavigationGraphManager";
import { RealObserveScreen } from "../../../src/features/observe/ObserveScreen";
import type { BootedDevice } from "../../../src/models";
import { ToolRegistry } from "../../../src/server/toolRegistry";
import { reportToolDispatched } from "../../../src/utils/ToolDispatchContext";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeTimer } from "../../fakes/FakeTimer";
import {
  installInMemoryNavManager,
  type InMemoryNavManagerHarness,
} from "../../helpers/navigationTestHarness";

const APP = "com.example.navigate-recording";
const device: BootedDevice = { platform: "android", deviceId: "emulator-5600" };
const backArgs = { selector: { elementId: "demo_index_back" }, action: "tap" };
const demosArgs = { selector: { text: "Demos" } };

describe("NavigateTo replay through navigation recording", () => {
  let harness: InMemoryNavManagerHarness;
  let repository: NavigationRepository;
  let manager: NavigationGraphManager;
  let timer: FakeTimer;
  let restorePipeline: () => void;
  let restoreCaches: () => void;
  let dispatchedArgs: Record<string, unknown>[];

  beforeAll(async () => {
    harness = await installInMemoryNavManager();
    repository = new NavigationRepository(harness.db);
    const cache = spyOn(RealObserveScreen, "getRecentCachedResult").mockReturnValue(undefined);
    const deviceCache = spyOn(RealObserveScreen, "getRecentCachedResultForDevice").mockReturnValue(
      undefined,
    );
    restoreCaches = () => {
      cache.mockRestore();
      deviceCache.mockRestore();
    };
    restorePipeline = ToolRegistry.setPipelineOverridesForTesting({
      executionTargetResolver: {
        resolveExecutionTarget: async () => ({
          shouldResolveDevice: true,
          device,
          internalCall: true,
        }),
      },
      auditRunner: {
        run: async (input) => input.handler(input.device, input.args, input.progress, input.signal),
      },
      afterToolCall: {
        handle: async (input) => ({ finalizedResponse: input.response, durationMs: 0 }),
      },
      planLifecycleManager: { afterExecution: async () => {} },
    });
    ToolRegistry.registerDeviceAware(
      "tapOn",
      "In-memory navigation tap",
      z.object({
        selector: z.object({ elementId: z.string().optional(), text: z.string().optional() }),
        action: z.string().optional(),
      }),
      async (_device, args) => {
        dispatchedArgs.push(args);
        reportToolDispatched();
        await navigate(
          args.selector.elementId === "demo_index_back"
            ? "HomeDestination"
            : "DemoIndexDestination",
        );
        return { success: true };
      },
    );
  });

  beforeEach(async () => {
    await repository.clearAppGraph(APP);
    timer = new FakeTimer();
    timer.setCurrentTime(100_000);
    manager = NavigationGraphManager.createForTesting(
      repository,
      new TestCoverageRepository(undefined, harness.db),
      timer,
    );
    NavigationGraphManager.setInstanceForTesting(manager);
    dispatchedArgs = [];
    await navigate("HomeDestination");
  });

  afterAll(async () => {
    ToolRegistry.unregister("tapOn");
    restorePipeline();
    restoreCaches();
    await harness.dispose();
  });

  async function navigate(destination: string): Promise<void> {
    timer.advanceTime(100);
    await manager.recordNavigationEvent({
      applicationId: APP,
      destination,
      source: "sdk",
      arguments: {},
      metadata: {},
      deviceId: device.deviceId,
      timestamp: timer.now(),
      sequenceNumber: 0,
    });
  }

  async function tap(args: Record<string, unknown>): Promise<void> {
    await ToolRegistry.getTool("tapOn")!.handler(args);
  }

  test("replaying a recorded back tap adds a traversal without adding a transition or routing args", async () => {
    await tap(demosArgs);
    await tap(backArgs);
    await tap(demosArgs);
    const before = await repository.getStats(APP);
    const traversalCount = (await repository.getEdges(APP)).length;
    const navigation = new NavigateTo(
      device,
      new FakeAdbClientFactory(),
      { setupUIState: async () => [], setupScrollPosition: async () => null },
      { waitForScreen: async (screen) => manager.getCurrentScreen() === screen },
      manager,
      timer,
    );

    const result = await navigation.execute({ targetScreen: "HomeDestination" });

    expect(result.success).toBe(true);
    expect(result.stepsExecuted).toBe(1);
    expect(dispatchedArgs.at(-1)).toMatchObject({
      ...backArgs,
      platform: device.platform,
      deviceId: device.deviceId,
    });
    expect((await repository.getStats(APP)).edgeCount).toBe(before.edgeCount);
    const rows = await repository.getEdges(APP);
    expect(rows).toHaveLength(traversalCount + 1);
    const backRows = rows.filter((row) => row.from_screen === "DemoIndexDestination");
    expect(backRows).toHaveLength(2);
    for (const row of rows) {
      const stored = JSON.parse(row.tool_args!);
      for (const key of ["platform", "deviceId", "device", "sessionUuid"]) {
        expect(stored).not.toHaveProperty(key);
      }
    }
    expect(backRows.map((row) => JSON.parse(row.tool_args!))).toEqual([backArgs, backArgs]);
    expect(await manager.getEdgesFrom("DemoIndexDestination")).toHaveLength(1);
    const summary = await manager.exportGraphSummary();
    expect(summary.edges.find((edge) => edge.from === "DemoIndexDestination")?.traversalCount).toBe(
      2,
    );
  });

  test("different non-routing action args remain distinct transitions", async () => {
    await tap(demosArgs);
    await tap(backArgs);
    await tap(demosArgs);
    await tap({ ...backArgs, action: "longPress" });

    const edges = await manager.getEdgesFrom("DemoIndexDestination");
    expect(edges).toHaveLength(2);
    expect(edges.map((edge) => edge.interaction?.args.action).sort()).toEqual(["longPress", "tap"]);
  });
});
