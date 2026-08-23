import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  DefaultUIStateSetup,
  type ObserveScreenLike,
} from "../../../src/features/navigation/DefaultUIStateSetup";
import { RealObserveScreen } from "../../../src/features/observe/ObserveScreen";
import { FakeAdbClient } from "../../fakes/FakeAdbClient";
import { FakeTimer } from "../../fakes/FakeTimer";
import type { AdbClient } from "../../../src/utils/android-cmdline-tools/AdbClient";
import type { BootedDevice } from "../../../src/models";
import type { ObserveResult } from "../../../src/models/ObserveResult";
import type { NavigationEdge } from "../../../src/features/navigation/NavigationGraphManager";
import { ToolRegistry } from "../../../src/server/toolRegistry";
import { createStructuredToolResponse } from "../../../src/utils/toolUtils";
import { INTERNAL_NO_DIFF_PARAM } from "../../../src/server/internalToolCall";
import type { ModalState, ScrollPosition } from "../../../src/utils/interfaces/NavigationGraph";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android";

const device: BootedDevice = {
  deviceId: "test-device",
  name: "Test Device",
  platform: "android",
};

function makeSetup(observeScreenProvider?: () => ObserveScreenLike): DefaultUIStateSetup {
  const fakeAdb = new FakeAdbClient() as unknown as AdbClient;
  // Auto-advancing fake timer so the internal `sleep()` delays resolve
  // immediately — keeps these unit tests fast (<100ms) and non-flaky.
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  return new DefaultUIStateSetup(device, fakeAdb, observeScreenProvider, timer);
}

describe("DefaultUIStateSetup", () => {
  // Regression for the AdbClientFactory injection refactor (#2754): the default
  // observe path used to be `new RealObserveScreen(this.device, this.adb)` with a
  // resolved AdbClient. After ObserveScreen became factory-only, that call would
  // throw `adbFactory.create is not a function` inside the constructor, get
  // swallowed by getCurrentUIState's catch, and silently skip required UI setup.
  test("default observe provider builds a RealObserveScreen bound to the injected device and adb", () => {
    const fakeAdb = new FakeAdbClient() as unknown as AdbClient;
    const timer = new FakeTimer();
    const setup = new DefaultUIStateSetup(device, fakeAdb, undefined, timer);
    const provider = (setup as unknown as { observeScreenProvider: () => ObserveScreenLike })
      .observeScreenProvider;

    let observeScreen: ObserveScreenLike | undefined;
    expect(() => {
      observeScreen = provider();
    }).not.toThrow();

    // Assert the concrete type and its binding rather than merely "has an execute
    // method" (a bare stub would pass that). The default provider must wire the
    // injected device and the resolved AdbClient into the real observe path.
    expect(observeScreen).toBeInstanceOf(RealObserveScreen);
    const internals = observeScreen as unknown as { device: BootedDevice; adb: AdbClient };
    expect(internals.device).toBe(device);
    expect(internals.adb).toBe(fakeAdb);
  });

  test("setupUIState consults the observe provider when the edge requires UI state", async () => {
    let calls = 0;
    const provider = (): ObserveScreenLike => {
      calls++;
      // No viewHierarchy => getCurrentUIState returns undefined and setup proceeds
      // without taps. The point is that the provider was reached, i.e. observation
      // was not silently skipped by a construction failure.
      return { execute: async () => ({ viewHierarchy: null }) as unknown as ObserveResult };
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
      return { execute: async () => ({ viewHierarchy: null }) as unknown as ObserveResult };
    });

    const edge = { uiState: {} } as unknown as NavigationEdge;
    const actions = await setup.setupUIState(edge, "android");

    expect(actions).toEqual([]);
    expect(calls).toBe(0);
  });

  describe("selected-element setup", () => {
    afterEach(() => {
      ToolRegistry.clearTools();
    });

    function setupWithNoSelections(): DefaultUIStateSetup {
      const setup = makeSetup();
      (
        setup as unknown as {
          getCurrentUIState: () => Promise<{ modalStack: ModalState[]; selectedElements: [] }>;
        }
      ).getCurrentUIState = async () => ({ modalStack: [], selectedElements: [] });
      return setup;
    }

    test("routes a missing content-description-only selection through tapOn's text selector", async () => {
      let capturedArgs: Record<string, unknown> | undefined;
      ToolRegistry.register("tapOn", "tapOn", {}, async (args) => {
        capturedArgs = args;
        return createStructuredToolResponse({ success: true });
      });
      const setup = setupWithNoSelections();

      const actions = await setup.setupUIState(
        {
          uiState: { selectedElements: [{ contentDesc: "Open settings" }] },
        } as NavigationEdge,
        "android",
      );

      expect(capturedArgs?.selector).toEqual({ text: "Open settings" });
      expect(actions).toEqual(['tapOn({"contentDesc":"Open settings"})']);
    });

    test("does not report a selected-element tap when its internal tool response fails", async () => {
      ToolRegistry.register("tapOn", "tapOn", {}, async () =>
        createStructuredToolResponse({ success: false, error: "element is disabled" }),
      );
      const setup = setupWithNoSelections();

      const actions = await setup.setupUIState(
        {
          uiState: { selectedElements: [{ text: "Settings" }] },
        } as NavigationEdge,
        "android",
      );

      expect(actions).toEqual([]);
    });
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
      ToolRegistry.register("swipeOn", "swipeOn", {}, async () =>
        createStructuredToolResponse({
          success: true,
          found,
          message: found ? "Swiped up and found element" : "Swiped up",
          observation: {},
          scrollIterations: 1,
        }),
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

  // Regression for issue #3106: the bottomsheet branch of `dismissTopModal`
  // resolved `ToolRegistry.getTool("swipe")`, but no tool is registered under
  // that name — the interaction tool is `swipeOn`. So the swipe-down dismissal
  // was dead code that silently fell through to the back-button fallback. These
  // tests pin that the branch resolves and invokes the registered `swipeOn`
  // handler with the correct arg shape so a wrong tool name regresses loudly.
  describe("dismissTopModal bottomsheet swipe-down (#3106)", () => {
    afterEach(() => {
      ToolRegistry.clearTools();
    });

    // A null hierarchy makes getCurrentUIState() return undefined, so the
    // post-swipe dismissal check (`!currentState?.modalStack?.some(...)`) treats
    // the sheet as gone — the swipe branch resolves as dismissed without ever
    // reaching the back-button fallback.
    const nullObserve = (): ObserveScreenLike => ({
      execute: async () => ({ viewHierarchy: null }) as unknown as ObserveResult,
    });

    const bottomSheet: ModalState = { type: "bottomsheet", layer: 1, windowId: 42 };

    test("invokes the registered `swipeOn` handler (not `swipe`) with direction down", async () => {
      let swipeOnCalls = 0;
      let capturedArgs: Record<string, unknown> | undefined;
      ToolRegistry.register("swipeOn", "swipeOn", {}, async (args: any) => {
        swipeOnCalls++;
        capturedArgs = args;
        return createStructuredToolResponse({ success: true });
      });

      const setup = makeSetup(nullObserve);
      const dismissed = await (
        setup as unknown as {
          dismissTopModal: (modal: ModalState, platform: string) => Promise<boolean>;
        }
      ).dismissTopModal(bottomSheet, "android");

      expect(dismissed).toBe(true);
      expect(swipeOnCalls).toBe(1);
      expect(capturedArgs).toBeDefined();
      expect(capturedArgs!.direction).toBe("down");
      expect(capturedArgs!.platform).toBe("android");
      // Must force a full-screen swipe: with the default (autoTarget true) and no
      // lookFor/container, swipeOn targets a scrollable child and would scroll the
      // sheet's inner list instead of dragging the sheet down to dismiss it.
      expect(capturedArgs!.autoTarget).toBe(false);
      // The old dead-code path passed a bogus `action: "swipe"` shape that the
      // `swipeOn` schema does not accept — the fixed call must not carry it.
      expect(capturedArgs!.action).toBeUndefined();
      // Marked internal (#3087) so navigation setup neither diffs/strips its
      // observation nor advances the agent-facing diff baseline.
      expect(capturedArgs![INTERNAL_NO_DIFF_PARAM]).toBe(true);
    });

    // Build a minimal view hierarchy that UIStateExtractor classifies as a
    // `bottomsheet` modal with the given windowId: a flat node whose `class`
    // contains "sheet" (classifyModalType) and an explicit `window-id`
    // (getWindowId). No `windows` array => collectModalStack runs on the
    // top-level hierarchy traversal.
    const bottomSheetHierarchy = (windowId: number): ObserveResult =>
      ({
        viewHierarchy: {
          hierarchy: { class: "BottomSheetDialog", "window-id": String(windowId) },
        },
      }) as unknown as ObserveResult;

    test("falls through to the back button when the swipe leaves the bottom sheet present (#3125)", async () => {
      ToolRegistry.register("swipeOn", "swipeOn", {}, async () =>
        createStructuredToolResponse({ success: true }),
      );
      ToolRegistry.register("pressButton", "pressButton", {}, async () => {
        throw new Error("Android modal recovery must not use the global tool registry");
      });

      // Stateful observe provider: the first post-swipe observation still
      // contains the bottomsheet's windowId (swipe did NOT dismiss it), forcing
      // the code past the swipe dismissal check into the back-button fallback;
      // the second (post-back) observation has a null hierarchy => the sheet is
      // gone, so the back-button path reports dismissal.
      let observeCalls = 0;
      const statefulObserve = (): ObserveScreenLike => ({
        execute: async () => {
          observeCalls++;
          return observeCalls === 1
            ? bottomSheetHierarchy(42)
            : ({ viewHierarchy: null } as unknown as ObserveResult);
        },
      });

      const ctrlProxySpy = spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue({
        requestGlobalAction: async () => ({ success: false, error: "unavailable" }),
      } as never);
      const setup = makeSetup(statefulObserve);
      let dismissed: boolean;
      try {
        dismissed = await (
          setup as unknown as {
            dismissTopModal: (modal: ModalState, platform: string) => Promise<boolean>;
          }
        ).dismissTopModal(bottomSheet, "android");
      } finally {
        ctrlProxySpy.mockRestore();
      }

      expect(dismissed).toBe(true);
      // The swipe ran but did not dismiss (windowId still present on observe #1),
      // so both post-swipe and post-back observations were consulted.
      expect(observeCalls).toBe(2);
      // Android recovery uses the setup instance's injected dependencies rather
      // than the global interaction registry.
      const fakeAdb = (setup as unknown as { adb: FakeAdbClient }).adb;
      expect(fakeAdb.getAllCommands()).toEqual(["shell input keyevent 4"]);
    });

    test("does not mistakenly resolve a tool registered under the old name `swipe`", async () => {
      let legacySwipeCalls = 0;
      // Register ONLY the wrong name. With the bug this would be the tool the
      // branch resolves; after the fix it must be ignored (no swipeOn present →
      // the branch skips straight to the back-button fallback).
      ToolRegistry.register("swipe", "swipe", {}, async () => {
        legacySwipeCalls++;
        return createStructuredToolResponse({ success: true });
      });

      const setup = makeSetup(nullObserve);
      await (
        setup as unknown as {
          dismissTopModal: (modal: ModalState, platform: string) => Promise<boolean>;
        }
      ).dismissTopModal(bottomSheet, "android");

      expect(legacySwipeCalls).toBe(0);
    });

    test("uses iOS pressButton recovery without Android shell fallbacks", async () => {
      const iosDevice: BootedDevice = { ...device, deviceId: "ios-device", platform: "ios" };
      const fakeAdb = new FakeAdbClient();
      const timer = new FakeTimer();
      timer.enableAutoAdvance();
      const setup = new DefaultUIStateSetup(iosDevice, fakeAdb, nullObserve, timer);
      let backArgs: Record<string, unknown> | undefined;
      ToolRegistry.register(
        "pressButton",
        "pressButton",
        {},
        async (args: Record<string, unknown>) => {
          backArgs = args;
          return createStructuredToolResponse({ success: true });
        },
      );

      const dismissed = await (
        setup as unknown as {
          dismissTopModal: (modal: ModalState, platform: string) => Promise<boolean>;
        }
      ).dismissTopModal({ type: "popup", layer: 1, windowId: 42 }, "ios");

      expect(dismissed).toBe(true);
      expect(backArgs).toMatchObject({
        button: "back",
        platform: "ios",
        [INTERNAL_NO_DIFF_PARAM]: true,
      });
      expect(fakeAdb.getAllCommands()).toEqual([]);
    });

    test("preserves Android's coordinate outside-tap recovery for popups", async () => {
      const setup = makeSetup(nullObserve);

      const dismissed = await (
        setup as unknown as {
          dismissTopModal: (modal: ModalState, platform: string) => Promise<boolean>;
        }
      ).dismissTopModal({ type: "popup", layer: 1, windowId: 42 }, "android");

      expect(dismissed).toBe(true);
      const fakeAdb = (setup as unknown as { adb: FakeAdbClient }).adb;
      expect(fakeAdb.wasCommandExecuted("shell input tap 50 50")).toBe(true);
    });
  });
});
