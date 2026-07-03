import { afterEach, describe, expect, test } from "bun:test";
import { DefaultUIStateSetup, type ObserveScreenLike } from "../../../src/features/navigation/DefaultUIStateSetup";
import { FakeAdbClient } from "../../fakes/FakeAdbClient";
import type { AdbClient } from "../../../src/utils/android-cmdline-tools/AdbClient";
import type { BootedDevice } from "../../../src/models";
import type { ObserveResult } from "../../../src/models/ObserveResult";
import type { NavigationEdge } from "../../../src/features/navigation/NavigationGraphManager";
import { ToolRegistry } from "../../../src/server/toolRegistry";
import { createStructuredToolResponse } from "../../../src/utils/toolUtils";
import type { ScrollPosition } from "../../../src/utils/interfaces/NavigationGraph";

const device: BootedDevice = {
  deviceId: "test-device",
  name: "Test Device",
  platform: "android",
};

function makeSetup(
  observeScreenProvider?: () => ObserveScreenLike
): DefaultUIStateSetup {
  const fakeAdb = new FakeAdbClient() as unknown as AdbClient;
  return new DefaultUIStateSetup(device, fakeAdb, observeScreenProvider);
}

describe("DefaultUIStateSetup", () => {
  // Regression for the AdbClientFactory injection refactor (#2754): the default
  // observe path used to be `new RealObserveScreen(this.device, this.adb)` with a
  // resolved AdbClient. After ObserveScreen became factory-only, that call would
  // throw `adbFactory.create is not a function` inside the constructor, get
  // swallowed by getCurrentUIState's catch, and silently skip required UI setup.
  test("default observe provider constructs from a resolved AdbClient without throwing", () => {
    const setup = makeSetup();
    const provider = (setup as unknown as { observeScreenProvider: () => ObserveScreenLike }).observeScreenProvider;

    let observeScreen: ObserveScreenLike | undefined;
    expect(() => { observeScreen = provider(); }).not.toThrow();
    expect(typeof observeScreen!.execute).toBe("function");
  });

  test("setupUIState consults the observe provider when the edge requires UI state", async () => {
    let calls = 0;
    const provider = (): ObserveScreenLike => {
      calls++;
      // No viewHierarchy => getCurrentUIState returns undefined and setup proceeds
      // without taps. The point is that the provider was reached, i.e. observation
      // was not silently skipped by a construction failure.
      return { execute: async () => ({ viewHierarchy: null } as unknown as ObserveResult) };
    };

    const setup = makeSetup(provider);
    const edge = {
      uiState: { modalStack: [{ type: "dialog" }] },
    } as unknown as NavigationEdge;

    const actions = await setup.setupUIState(edge, "android");

    expect(calls).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(actions)).toBe(true);
  });

  test("setupUIState short-circuits with no observation when the edge has no UI-state requirements", async () => {
    let calls = 0;
    const setup = makeSetup(() => {
      calls++;
      return { execute: async () => ({ viewHierarchy: null } as unknown as ObserveResult) };
    });

    const edge = { uiState: {} } as unknown as NavigationEdge;
    const actions = await setup.setupUIState(edge, "android");

    expect(actions).toEqual([]);
    expect(calls).toBe(0);
  });

  // Regression for issue #2897 (sibling of the toolRegistry scroll-position fix):
  // `swipeOn`'s handler returns an MCP envelope from createStructuredToolResponse,
  // which hoists only `success`/`error` to the top level — `found` lives under
  // `structuredContent`. setupScrollPosition read `result?.found` off the envelope,
  // so it was always undefined: the success branch was dead and setup returned null
  // (logging "could not find") even when the scroll succeeded.
  describe("setupScrollPosition envelope read (#2897)", () => {
    afterEach(() => {
      ToolRegistry.clearTools();
    });

    const scrollPosition: ScrollPosition = {
      targetElement: { text: "Target", resourceId: "com.example:id/target" },
      direction: "up",
    };

    function registerSwipeOn(found: boolean): void {
      ToolRegistry.register(
        "swipeOn",
        "swipeOn",
        {},
        async () => createStructuredToolResponse({
          success: true,
          found,
          message: found ? "Swiped up and found element" : "Swiped up",
          observation: {},
          scrollIterations: 1,
        })
      );
    }

    test("returns the swipeOn marker action when the element is found (found lives in structuredContent)", async () => {
      registerSwipeOn(true);
      const setup = makeSetup();

      const action = await setup.setupScrollPosition(scrollPosition, "android");

      expect(action).not.toBeNull();
      expect(action).toContain("swipeOn(lookFor:");
    });

    test("returns null when the element is not found", async () => {
      registerSwipeOn(false);
      const setup = makeSetup();

      const action = await setup.setupScrollPosition(scrollPosition, "android");

      expect(action).toBeNull();
    });
  });
});
