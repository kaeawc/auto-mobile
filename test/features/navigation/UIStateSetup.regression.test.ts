import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { DefaultUIStateSetup } from "../../../src/features/navigation/DefaultUIStateSetup";
import { ToolRegistry } from "../../../src/server/toolRegistry";
import type { ObserveResult, BootedDevice } from "../../../src/models";
import type { NavigationEdge } from "../../../src/utils/interfaces/NavigationGraph";
import { createStructuredToolResponse } from "../../../src/utils/toolUtils";
import { FakeAdbClient } from "../../fakes/FakeAdbClient";
import { FakeTimer } from "../../fakes/FakeTimer";
import { NavigateTo } from "../../../src/features/navigation/NavigateTo";
import { FakeNavigationGraphManager } from "../../fakes/FakeNavigationGraphManager";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";

const demos: { structuredContent: ObserveResult } = JSON.parse(
  readFileSync(
    new URL("../../fixtures/ios/ios-demos-observe-full-sdk-nodes-injected.json", import.meta.url),
    "utf8",
  ),
);
const settings: ObserveResult = JSON.parse(
  readFileSync(
    new URL(
      "../../fixtures/observe-output/ios-keyboard-tabbar/observe-keyboard-up.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const device: BootedDevice = { deviceId: "setup-device", name: "Setup", platform: "ios" };

function edge(text: string): NavigationEdge {
  return { from: "Demos", to: "Startup", timestamp: 0, uiState: { selectedElements: [{ text }] } };
}

function setup(after = demos.structuredContent) {
  let observations = 0;
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  return new DefaultUIStateSetup(
    device,
    new FakeAdbClient(),
    () => ({
      execute: async () => (++observations >= 3 ? after : demos.structuredContent),
    }),
    timer,
  );
}

describe("UI-state setup only taps exact selectable controls", () => {
  afterEach(() => {
    ToolRegistry.clearTools();
  });

  for (const text of ["Heavy", "Heavy Computation"]) {
    test(`does not tap ${text}: substring or exact non-selectable button`, async () => {
      const taps: unknown[] = [];
      ToolRegistry.register("tapOn", "Fake tap", {}, async (args) => {
        taps.push(args.selector);
        return createStructuredToolResponse({ success: true });
      });
      expect(await setup().setupUIState(edge(text), "ios")).toEqual([]);
      expect(taps).toEqual([]);
    });
  }

  test("a current-screen unselected tab remains replayable", async () => {
    const taps: unknown[] = [];
    ToolRegistry.register("tapOn", "Fake tap", {}, async (args) => {
      taps.push(args.selector);
      expect(args.deviceId).toBe(device.deviceId);
      return createStructuredToolResponse({ success: true });
    });
    expect(await setup().setupUIState(edge("Discover"), "ios")).toEqual([
      'tapOn({"text":"Discover"})',
    ]);
    expect(taps).toEqual([{ text: "Discover" }]);
  });

  test("a setup tap changing screens aborts before any later selection", async () => {
    const taps: unknown[] = [];
    ToolRegistry.register("tapOn", "Fake tap", {}, async (args) => {
      taps.push(args.selector);
      return createStructuredToolResponse({ success: true });
    });
    const required: NavigationEdge = {
      ...edge("Discover"),
      uiState: { selectedElements: [{ text: "Discover" }, { text: "Files" }] },
    };
    await expect(setup(settings).setupUIState(required, "ios")).rejects.toThrow("changed screen");
    expect(taps).toEqual([{ text: "Discover" }]);
  });

  test("an already-selected tab does not issue a setup tap", async () => {
    let taps = 0;
    ToolRegistry.register("tapOn", "Fake tap", {}, async () => {
      taps++;
      return createStructuredToolResponse({ success: true });
    });
    expect(await setup().setupUIState(edge("Demos"), "ios")).toEqual([]);
    expect(taps).toBe(0);
  });

  test("navigateTo aborts a screen-changing setup even if its screen tracker still reports the source", async () => {
    const taps: unknown[] = [];
    ToolRegistry.register("tapOn", "Fake tap", {}, async (args) => {
      taps.push(args.selector);
      return createStructuredToolResponse({ success: true });
    });
    const graph = new FakeNavigationGraphManager();
    graph.setCurrentScreenValue("Demos");
    graph.setPathResult({
      found: true,
      startScreen: "Demos",
      targetScreen: "Startup",
      path: [
        {
          ...edge("Discover"),
          interaction: {
            toolName: "tapOn",
            args: { selector: { elementId: "startup" } },
            timestamp: 0,
          },
        },
      ],
    });
    let observations = 0;
    const findPath = spyOn(graph, "findPath");
    try {
      const nav = new NavigateTo(
        device,
        new FakeAdbClientFactory(),
        setup(settings),
        { waitForScreen: async () => true },
        graph,
        new FakeTimer(),
        undefined,
        undefined,
        () => ({
          execute: async () => {
            observations++;
            return {};
          },
        }),
      );
      const result = await nav.execute({ targetScreen: "Startup", platform: "ios" });
      expect(result.success).toBe(false);
      expect(result.error).toContain("changed screen");
      expect(taps).toEqual([{ text: "Discover" }]);
      expect(findPath).toHaveBeenCalledTimes(1);
      expect(observations).toBe(0);
    } finally {
      findPath.mockRestore();
    }
  });
});
