import { afterEach, describe, expect, test } from "bun:test";
import { ToolRegistry } from "../../../src/server/toolRegistry";
import { INTERNAL_NO_DIFF_PARAM } from "../../../src/server/internalToolCall";
import { DefaultUIStateSetup } from "../../../src/features/navigation/DefaultUIStateSetup";
import { NavigateTo } from "../../../src/features/navigation/NavigateTo";
import { createStructuredToolResponse } from "../../../src/utils/toolUtils";
import type { BootedDevice } from "../../../src/models";
import type { AdbClient } from "../../../src/utils/android-cmdline-tools/AdbClient";
import type { ScrollPosition } from "../../../src/utils/interfaces/NavigationGraph";
import type { NavigationGraphService } from "../../../src/features/navigation/NavigationGraphManager";
import type { UIStateSetup } from "../../../src/features/navigation/interfaces/UIStateSetup";
import type { ScreenTransitionWaiter } from "../../../src/features/navigation/interfaces/ScreenTransitionWaiter";

/**
 * Guard for issue #3087: the navigation/setup paths call the *wrapped*
 * `tool.handler` (which runs `finalizeToolResponse`) on behalf of an internal
 * caller. Under `--actions-diff-observe` those calls must not diff/strip their
 * observation and — the actual bug — must not advance the agent-facing diff
 * baseline. Every such site now routes its args through `markInternalToolCall`,
 * which sets `INTERNAL_NO_DIFF_PARAM`; the wrapped handler reads that at entry and
 * passes `internal: true` to finalize (already end-to-end proven for PlanExecutor
 * in test/plan/planExecutorInternalNoDiffE2E.test.ts).
 *
 * These tests register the target tool as a plain (unwrapped) registry tool so
 * the handler receives exactly the args the navigation code passed, and assert
 * the internal marker is present — the necessary-and-sufficient new guarantee for
 * each call site — while also proving the caller's own result reads still work and
 * shared nav-graph args are never mutated.
 */
describe("navigation internal no-diff marking (#3087)", () => {
  afterEach(() => {
    ToolRegistry.clearTools();
  });

  describe("DefaultUIStateSetup.setupScrollPosition", () => {
    const device: BootedDevice = { name: "Pixel", deviceId: "emulator-5554", platform: "android" };
    const dummyAdb = {} as AdbClient;

    const scrollPosition: ScrollPosition = {
      targetElement: { text: "Settings" },
      direction: "down",
    };

    test("marks the swipeOn replay internal and still reads `found` off the full result", async () => {
      let capturedArgs: Record<string, unknown> | undefined;
      ToolRegistry.clearTools();
      // Plain-register so the handler sees the exact args navigation passed.
      ToolRegistry.register("swipeOn", "swipeOn", {}, async (args: any) => {
        capturedArgs = args;
        // A successful scroll: `found: true` must be readable off the full result
        // (proves the internal path is not stripped for the caller's own read).
        return createStructuredToolResponse({ success: true, found: true });
      });

      const setup = new DefaultUIStateSetup(device, dummyAdb);
      const action = await setup.setupScrollPosition(scrollPosition, "android");

      expect(capturedArgs).toBeDefined();
      expect(capturedArgs![INTERNAL_NO_DIFF_PARAM]).toBe(true);
      // `found` read still works → the success branch fires and returns the action.
      expect(action).not.toBeNull();
    });
  });

  describe("NavigateTo tool-call replay", () => {
    const device: BootedDevice = { name: "Pixel", deviceId: "emulator-5554", platform: "android" };

    function makeFakes(interactionArgs: Record<string, any>) {
      const edge = {
        from: "Home",
        to: "Detail",
        edgeType: "tool" as const,
        timestamp: 0,
        interaction: { toolName: "tapOn", args: interactionArgs, timestamp: 0 },
      };
      const navManager = {
        getCurrentScreen: () => "Home",
        getNode: async () => ({
          screenName: "Home",
          firstSeenAt: 0,
          lastSeenAt: 0,
          visitCount: 1,
          backStackDepth: 0,
        }),
        findPath: async () => ({
          found: true,
          path: [edge],
          startScreen: "Home",
          targetScreen: "Detail",
        }),
        getKnownScreens: async () => ["Home", "Detail"],
      } as unknown as NavigationGraphService;
      const uiStateSetup: UIStateSetup = {
        setupUIState: async () => [],
        setupScrollPosition: async () => null,
      };
      const screenWaiter: ScreenTransitionWaiter = {
        waitForScreen: async () => true,
      };
      return { edge, navManager, uiStateSetup, screenWaiter };
    }

    test("marks the replayed tool call internal without mutating the stored edge args", async () => {
      const interactionArgs: Record<string, any> = {
        action: "tap",
        text: "Open",
        platform: "android",
      };
      const before = JSON.stringify(interactionArgs);
      const { navManager, uiStateSetup, screenWaiter } = makeFakes(interactionArgs);

      let capturedArgs: Record<string, unknown> | undefined;
      ToolRegistry.clearTools();
      ToolRegistry.register("tapOn", "tapOn", {}, async (args: any) => {
        capturedArgs = args;
        return createStructuredToolResponse({ success: true });
      });

      const navigateTo = new NavigateTo(device, undefined, uiStateSetup, screenWaiter, navManager);
      const result = await navigateTo.execute({ targetScreen: "Detail", platform: "android" });

      expect(result.success).toBe(true);
      expect(capturedArgs).toBeDefined();
      expect(capturedArgs![INTERNAL_NO_DIFF_PARAM]).toBe(true);
      // Original args (the shared nav-graph edge) must not be tainted with the marker.
      expect(interactionArgs[INTERNAL_NO_DIFF_PARAM]).toBeUndefined();
      expect(JSON.stringify(interactionArgs)).toBe(before);
    });
  });
});
