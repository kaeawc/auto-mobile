import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { NavigationRepository } from "../../../src/db/navigationRepository";
import { TestCoverageRepository } from "../../../src/db/testCoverageRepository";
import { INTERNAL_TOOL_PARAM_NAMES } from "../../../src/daemon/wire/constants";
import { stripNavigationToolParams } from "../../../src/models/navigationToolParams";
import { NavigationGraphManager } from "../../../src/features/navigation/NavigationGraphManager";
import { edgeReplayKey } from "../../../src/db/edgeReplayKey";
import { RealObserveScreen } from "../../../src/features/observe/ObserveScreen";
import { ToolRegistry } from "../../../src/server/toolRegistry";
import type { ObserveResult } from "../../../src/models";
import { FakeTimer } from "../../fakes/FakeTimer";
import {
  installInMemoryNavManager,
  type InMemoryNavManagerHarness,
} from "../../helpers/navigationTestHarness";

const APP = "com.example.recording";
const args = { selector: { elementId: "demo_index_back" }, action: "tap" };
const routed = {
  ...args,
  platform: "android",
  deviceId: "emulator-5600",
  device: "phone",
  sessionUuid: "session",
};
const capture: { structuredContent: ObserveResult } = JSON.parse(
  readFileSync(
    new URL("../../fixtures/ios/ios-demos-observe-full-sdk-nodes-injected.json", import.meta.url),
    "utf8",
  ),
);

describe("navigation recording source state and routing", () => {
  let harness: InMemoryNavManagerHarness;
  let manager: NavigationGraphManager;
  let repository: NavigationRepository;
  let timer: FakeTimer;

  beforeAll(async () => {
    harness = await installInMemoryNavManager();
  });
  beforeEach(async () => {
    repository = new NavigationRepository(harness.db);
    await repository.clearAppGraph(APP);
    timer = new FakeTimer();
    timer.setCurrentTime(100_000);
    manager = NavigationGraphManager.createForTesting(repository, {
      testCoverageRepository: new TestCoverageRepository(harness.db),
      timer,
    });
    NavigationGraphManager.setInstanceForTesting(manager);
    await navigate("Home");
  });
  afterAll(async () => {
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
      timestamp: timer.now(),
      sequenceNumber: 0,
    });
  }

  function record(recordedArgs = args) {
    // Exercise the actual default registry recorder without invoking a device handler.
    const recorder = ToolRegistry.getCollaboratorsForTesting().navigationToolCallRecorder;
    const cache = spyOn(RealObserveScreen, "getRecentCachedResult").mockReturnValue(
      capture.structuredContent,
    );
    try {
      const handle = recorder.record("tapOn", recordedArgs, undefined, undefined, {
        recordsNavigation: true,
      });
      if (!handle) {
        throw new Error("Expected navigation recording handle");
      }
      return handle;
    } finally {
      cache.mockRestore();
    }
  }

  test("drops start-screen selections when target search dispatches on another screen", async () => {
    const call = record();
    timer.advanceTime(5000);
    await navigate("DemoIndex");
    call.markDispatched?.();
    await navigate("DemoStartup");
    const edges = await manager.getEdgesFrom("DemoIndex");
    expect(edges).toHaveLength(1);
    expect(edges[0].interaction?.toolName).toBe("tapOn");
    expect(edges[0].uiState).toBeUndefined();
  });

  for (const knownApp of [false, true]) {
    test(`unknown start screen preserves selections on dispatch, known app=${knownApp}`, async () => {
      manager = NavigationGraphManager.createForTesting(repository, {
        testCoverageRepository: new TestCoverageRepository(harness.db),
        timer,
      });
      if (knownApp) {
        await manager.setCurrentApp(APP);
      }
      const uiState = { selectedElements: [{ text: "Demos" }] };
      const call = manager.recordToolCall("tapOn", args, uiState);
      await navigate("DemoIndex");
      call.markDispatched?.();
      await navigate("DemoStartup");
      const edges = await manager.getEdgesFrom("DemoIndex");
      expect(edges[0].uiState).toEqual(uiState);
    });
  }

  test("same-screen dispatch preserves selections even with a later report after navigation", async () => {
    const call = record();
    call.markDispatched?.();
    const event = navigate("DemoStartup");
    call.markDispatched?.();
    await event;
    const edges = await manager.getEdgesFrom("Home");
    expect(edges[0].uiState?.selectedElements.map((element) => element.text)).toContain("Demos");
  });

  test("recorder and manager store routed and manual traversals as one transition", async () => {
    record(routed).markDispatched?.();
    await navigate("DemoIndex");
    await navigate("Home");
    manager.recordToolCall("tapOn", args).markDispatched?.();
    await navigate("DemoIndex");
    const traversals = (await repository.getEdges(APP)).filter((row) => row.tool_name === "tapOn");
    expect(traversals).toHaveLength(2);
    expect(traversals.map((row) => JSON.parse(row.tool_args!))).toEqual([args, args]);
    expect(await repository.getEdgesFrom(APP, "Home")).toHaveLength(1);
    expect((await repository.getStats(APP)).toolEdgeCount).toBe(1);
    expect((await manager.getEdgesFrom("Home"))[0].interaction?.args).toEqual(args);
  });

  test("old routed DB rows collapse in reads, counts, adjacency, and replay identity", async () => {
    const older = await repository.createEdge(APP, "Home", "DemoIndex", {
      tool: { toolName: "tapOn", toolArgs: args },
      timestamp: 200,
    });
    const newest = await repository.createEdge(APP, "Home", "DemoIndex", {
      tool: { toolName: "tapOn", toolArgs: routed },
      timestamp: 100,
    });
    expect(newest.id).toBeGreaterThan(older.id);
    expect(await repository.getDistinctEdges(APP)).toEqual([newest]);
    expect(await repository.getEdgesFrom(APP, "Home")).toEqual([newest]);
    expect(await repository.getEdgesTo(APP, "DemoIndex")).toEqual([newest]);
    expect(await repository.getEdgeTargetsFrom(APP, "Home")).toHaveLength(1);
    expect((await repository.getStats(APP)).edgeCount).toBe(1);
    expect((await manager.getEdgesFrom("Home"))[0].interaction?.args).toEqual(args);
    const edge = { from: "Home", to: "DemoIndex", interaction: { toolName: "tapOn", args } };
    expect(edgeReplayKey(edge)).toBe(
      edgeReplayKey({ ...edge, interaction: { toolName: "tapOn", args: routed } }),
    );
  });

  test("stripNavigationToolParams drops every canonical internal param by prefix", () => {
    const internal = Object.fromEntries(INTERNAL_TOOL_PARAM_NAMES.map((name) => [name, 1]));
    expect(stripNavigationToolParams({ ...internal, text: "x" })).toEqual({ text: "x" });
  });

  test("normalization preserves action arguments, inputs, and distinct actions", async () => {
    expect(stripNavigationToolParams(routed)).toEqual(args);
    expect(routed.deviceId).toBe("emulator-5600");
    await repository.createEdge(APP, "Home", "DemoIndex", {
      tool: { toolName: "tapOn", toolArgs: args },
      timestamp: 1,
    });
    await repository.createEdge(APP, "Home", "DemoIndex", {
      tool: { toolName: "tapOn", toolArgs: { ...args, action: "longPress" } },
      timestamp: 2,
    });
    expect(await repository.getDistinctEdges(APP)).toHaveLength(2);
  });
});
