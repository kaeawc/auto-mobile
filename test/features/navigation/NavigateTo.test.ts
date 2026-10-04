import { expect, describe, test, beforeEach, afterEach, spyOn } from "bun:test";
import { NavigateTo } from "../../../src/features/navigation/NavigateTo";
import { SmartNavigationHelper } from "../../../src/features/navigation/SmartNavigationHelper";
import type { ScreenTransitionWaiter } from "../../../src/features/navigation/interfaces/ScreenTransitionWaiter";
import type { UIStateSetup } from "../../../src/features/navigation/interfaces/UIStateSetup";
import type { NavigationEdge } from "../../../src/utils/interfaces/NavigationGraph";
import { ToolRegistry } from "../../../src/server/toolRegistry";
import { BootedDevice } from "../../../src/models";
import { z } from "zod/v4";
import { FakeNavigationGraphManager } from "../../fakes/FakeNavigationGraphManager";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeTimer } from "../../fakes/FakeTimer";
import { defaultTimer } from "../../../src/utils/SystemTimer";
import { INTERNAL_NO_DIFF_PARAM } from "../../../src/server/internalToolCall";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android";

describe("NavigateTo", () => {
  let navigateTo: NavigateTo;
  let device: BootedDevice;
  let toolCallLog: Array<{ toolName: string; args: Record<string, any> }>;
  let fakeGraph: FakeNavigationGraphManager;
  let fakeAdbFactory: FakeAdbClientFactory;

  // Map of text -> screen to simulate navigation when tools are called
  let navigationMap: Map<string, string>;
  let shouldUseBackButtonSpy: ReturnType<typeof spyOn> | null;

  beforeEach(async () => {
    fakeGraph = new FakeNavigationGraphManager();
    ToolRegistry.clearTools();

    // Create fake device
    device = {
      deviceId: "test-device-123",
      platform: "android",
      source: "local",
    } as BootedDevice;

    // Create FakeAdbClientFactory to avoid real ADB calls
    fakeAdbFactory = new FakeAdbClientFactory();

    // Track tool calls
    toolCallLog = [];
    navigationMap = new Map();
    shouldUseBackButtonSpy = null;

    // Register fake tapOn tool that simulates navigation
    ToolRegistry.register(
      "tapOn",
      "Fake tap tool",
      z.object({
        id: z.string().optional(),
        text: z.string().optional(),
        action: z.string(),
        platform: z.string(),
      }),
      async (args) => {
        toolCallLog.push({ toolName: "tapOn", args });

        // Simulate navigation by recording a navigation event
        const targetScreen = navigationMap.get(args.text);
        if (targetScreen) {
          await fakeGraph.recordNavigationEvent({
            destination: targetScreen,
            source: "TEST",
            arguments: {},
            metadata: {},
            timestamp: Date.now(),
            sequenceNumber: 0,
          });
        }

        return { success: true };
      },
    );

    // Set up navigation graph with test data
    await fakeGraph.setCurrentApp("com.test.app");
  });

  afterEach(() => {
    ToolRegistry.clearTools();
    shouldUseBackButtonSpy?.mockRestore();
  });

  describe("execute", () => {
    for (const [hasBudget, sessionUuid] of [
      [true, "current-session"],
      [false, "current-session"],
      [false, undefined],
    ] as const) {
      test(`replays legacy edges with current request metadata (budget: ${hasBudget}, session: ${sessionUuid})`, async () => {
        const args = {
          text: "Settings",
          action: "tap",
          sessionUuid: "old-session",
          __mcpRequestTimeoutMs: 2,
          __mcpRequestDeadlineMs: 1,
          __futureInternal: true,
          _foo: "keep",
          sessionUuidX: "keep",
          session: "keep",
        };
        fakeGraph.recordToolCall("tapOn", args);
        for (const [destination, timestamp] of [
          ["HomeScreen", 100],
          ["SettingsScreen", 200],
          ["HomeScreen", 300],
        ] as const) {
          await fakeGraph.recordNavigationEvent({ destination, timestamp });
        }
        navigationMap.set("Settings", "SettingsScreen");
        navigateTo = new NavigateTo(
          device,
          fakeAdbFactory,
          { setupUIState: async () => [], setupScrollPosition: async () => null },
          { waitForScreen: async () => true },
          fakeGraph,
          new FakeTimer(),
        );
        const call = spyOn(ToolRegistry, "callInternal");
        try {
          const result = await navigateTo.execute({
            targetScreen: "SettingsScreen",
            platform: "android",
            ...(sessionUuid ? { sessionUuid } : {}),
            ...(hasBudget ? { __mcpRequestTimeoutMs: 500, __mcpRequestDeadlineMs: 1500 } : {}),
          });
          expect(result.success).toBe(true);
          const replay = call.mock.calls[0][1];
          expect(replay).toMatchObject({
            _foo: "keep",
            sessionUuidX: "keep",
            session: "keep",
            ...(sessionUuid ? { sessionUuid } : {}),
          });
          expect(replay.sessionUuid).toBe(sessionUuid);
          expect(Object.hasOwn(replay, "sessionUuid")).toBe(sessionUuid !== undefined);
          expect(replay.__futureInternal).toBeUndefined();
          expect(Object.hasOwn(replay, "__mcpRequestTimeoutMs")).toBe(hasBudget);
          expect(Object.hasOwn(replay, "__mcpRequestDeadlineMs")).toBe(hasBudget);
          expect(replay.__mcpRequestTimeoutMs).toBe(hasBudget ? 500 : undefined);
          expect(replay.__mcpRequestDeadlineMs).toBe(hasBudget ? 1500 : undefined);
          expect(JSON.stringify(result.path)).not.toContain("__");
          expect(JSON.stringify(result.path)).not.toContain("old-session");
          expect(args.sessionUuid).toBe("old-session");
        } finally {
          call.mockRestore();
        }
      });
    }

    test("creates the default UI-state setup after resolving an options session", async () => {
      navigateTo = new NavigateTo(device, fakeAdbFactory, null, null, fakeGraph);

      await navigateTo.execute({
        targetScreen: "HomeScreen",
        platform: "android",
        sessionUuid: "options-session",
      });

      const uiStateSetup = (
        navigateTo as unknown as {
          uiStateSetup: { sessionUuid?: string } | null;
        }
      ).uiStateSetup;
      expect(uiStateSetup?.sessionUuid).toBe("options-session");
    });

    test("should return error when no current screen", async () => {
      // Inject fakeGraph via constructor
      navigateTo = new NavigateTo(device, fakeAdbFactory, null, null, fakeGraph);

      const result = await navigateTo.execute({
        targetScreen: "TargetScreen",
        platform: "android",
      });

      expect(result.success).toBe(false);
      expect(result.error!).toContain("Cannot determine current screen");
      expect(result.stepsExecuted).toBe(0);
    });

    test("should return success when already on target screen", async () => {
      await fakeGraph.recordNavigationEvent({
        destination: "HomeScreen",
        source: "TEST",
        arguments: {},
        metadata: {},
        timestamp: Date.now(),
        sequenceNumber: 0,
      });

      // Inject fakeGraph via constructor
      navigateTo = new NavigateTo(device, fakeAdbFactory, null, null, fakeGraph);

      const result = await navigateTo.execute({
        targetScreen: "HomeScreen",
        platform: "android",
      });

      expect(result.success).toBe(true);
      expect(result.message).toBe("Already on target screen");
      expect(result.stepsExecuted).toBe(0);
    });

    test("should return error when no path exists", async () => {
      await fakeGraph.recordNavigationEvent({
        destination: "HomeScreen",
        source: "TEST",
        arguments: {},
        metadata: {},
        timestamp: Date.now(),
        sequenceNumber: 0,
      });

      // Inject fakeGraph via constructor
      navigateTo = new NavigateTo(device, fakeAdbFactory, null, null, fakeGraph);

      const result = await navigateTo.execute({
        targetScreen: "UnknownScreen",
        platform: "android",
      });

      expect(result.success).toBe(false);
      expect(result.error!).toContain("No known path");
      expect(result.error!).toContain("HomeScreen");
      expect(result.error!).toContain("UnknownScreen");
    });

    test("should execute tool call when path exists", async () => {
      const now = Date.now();

      // Set up navigation map so fake tool triggers navigation
      navigationMap.set("Settings", "SettingsScreen");

      // Record tool call before navigation (to correlate)
      fakeGraph.recordToolCall("tapOn", { text: "Settings", action: "tap", platform: "android" });

      // Record navigation: Home -> Settings
      await fakeGraph.recordNavigationEvent({
        destination: "HomeScreen",
        source: "TEST",
        arguments: {},
        metadata: {},
        timestamp: now,
        sequenceNumber: 0,
      });
      await fakeGraph.recordNavigationEvent({
        destination: "SettingsScreen",
        source: "TEST",
        arguments: {},
        metadata: {},
        timestamp: now + 100,
        sequenceNumber: 1,
      });

      // Go back to Home to test navigation
      await fakeGraph.recordNavigationEvent({
        destination: "HomeScreen",
        source: "TEST",
        arguments: {},
        metadata: {},
        timestamp: now + 200,
        sequenceNumber: 2,
      });

      // Inject fakeGraph via constructor
      navigateTo = new NavigateTo(device, fakeAdbFactory, null, null, fakeGraph);

      await navigateTo.execute({
        targetScreen: "SettingsScreen",
        platform: "android",
      });

      // Should have attempted to execute the tool call
      expect(toolCallLog).toHaveLength(1);
      expect(toolCallLog[0].toolName).toBe("tapOn");
      expect(toolCallLog[0].args.text).toBe("Settings");
    });

    test("should include path in successful navigation result", async () => {
      const now = Date.now();

      // Set up navigation map so fake tool triggers navigation
      navigationMap.set("Profile", "ProfileScreen");

      fakeGraph.recordToolCall("tapOn", { text: "Profile", action: "tap", platform: "android" });
      await fakeGraph.recordNavigationEvent({
        destination: "HomeScreen",
        source: "TEST",
        arguments: {},
        metadata: {},
        timestamp: now,
        sequenceNumber: 0,
      });
      await fakeGraph.recordNavigationEvent({
        destination: "ProfileScreen",
        source: "TEST",
        arguments: {},
        metadata: {},
        timestamp: now + 100,
        sequenceNumber: 1,
      });
      await fakeGraph.recordNavigationEvent({
        destination: "HomeScreen",
        source: "TEST",
        arguments: {},
        metadata: {},
        timestamp: now + 200,
        sequenceNumber: 2,
      });

      // Inject fakeGraph via constructor
      navigateTo = new NavigateTo(device, fakeAdbFactory, null, null, fakeGraph);

      const result = await navigateTo.execute({
        targetScreen: "ProfileScreen",
        platform: "android",
      });

      expect(result.path).toBeDefined();
      expect(Array.isArray(result.path)).toBe(true);
      expect(result.path!.length > 0).toBe(true);
    });

    test("should report progress during navigation", async () => {
      const now = Date.now();
      const progressUpdates: Array<{ current: number; total: number; message: string }> = [];

      // Set up navigation map so fake tool triggers navigation
      navigationMap.set("Step1", "Screen2");

      fakeGraph.recordToolCall("tapOn", { text: "Step1", action: "tap", platform: "android" });
      await fakeGraph.recordNavigationEvent({
        destination: "Screen1",
        source: "TEST",
        arguments: {},
        metadata: {},
        timestamp: now,
        sequenceNumber: 0,
      });
      await fakeGraph.recordNavigationEvent({
        destination: "Screen2",
        source: "TEST",
        arguments: {},
        metadata: {},
        timestamp: now + 100,
        sequenceNumber: 1,
      });
      await fakeGraph.recordNavigationEvent({
        destination: "Screen1",
        source: "TEST",
        arguments: {},
        metadata: {},
        timestamp: now + 200,
        sequenceNumber: 2,
      });

      // Inject fakeGraph via constructor
      navigateTo = new NavigateTo(device, fakeAdbFactory, null, null, fakeGraph);

      await navigateTo.execute(
        { targetScreen: "Screen2", platform: "android" },
        async (current, total, message) => {
          progressUpdates.push({ current, total, message });
        },
      );

      expect(progressUpdates.length > 0).toBe(true);
      expect(progressUpdates[0].total).toBe(1);
      expect(progressUpdates[0].message).toContain("Screen1");
      expect(progressUpdates[0].message).toContain("Screen2");
    });

    test("should return duration in result", async () => {
      await fakeGraph.recordNavigationEvent({
        destination: "HomeScreen",
        source: "TEST",
        arguments: {},
        metadata: {},
        timestamp: Date.now(),
        sequenceNumber: 0,
      });

      // Inject fakeGraph via constructor
      navigateTo = new NavigateTo(device, fakeAdbFactory, null, null, fakeGraph);

      const result = await navigateTo.execute({
        targetScreen: "HomeScreen",
        platform: "android",
      });

      expect(result.durationMs).toBeDefined();
      expect(typeof result.durationMs).toBe("number");
      expect(result.durationMs!).toBeGreaterThanOrEqual(0);
    });

    test("should await smart back-button recommendation and execute back navigation", async () => {
      const now = Date.now();
      await fakeGraph.recordNavigationEvent({
        destination: "DetailScreen",
        source: "TEST",
        arguments: {},
        metadata: {},
        timestamp: now,
        sequenceNumber: 0,
      });
      fakeGraph.addNode({
        screenName: "DetailScreen",
        firstSeenAt: now,
        lastSeenAt: now,
        visitCount: 1,
        backStackDepth: 1,
      });

      shouldUseBackButtonSpy = spyOn(
        SmartNavigationHelper,
        "shouldUseBackButton",
      ).mockResolvedValue({
        shouldUseBack: true,
        backPresses: 1,
        reason: "test recommendation",
      });
      const ctrlProxySpy = spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue({
        requestGlobalAction: async () => ({ success: false, error: "unavailable" }),
      } as never);

      const screenWaiter: ScreenTransitionWaiter = {
        waitForScreen: async (screenName) => screenName === "HomeScreen",
      };
      const fakeTimer = new FakeTimer();
      fakeTimer.enableAutoAdvance();
      navigateTo = new NavigateTo(device, fakeAdbFactory, null, screenWaiter, fakeGraph, fakeTimer);

      try {
        const result = await navigateTo.execute({
          targetScreen: "HomeScreen",
          platform: "android",
        });

        expect(shouldUseBackButtonSpy).toHaveBeenCalledWith("DetailScreen", "HomeScreen", 1);
        expect(result.success).toBe(true);
        expect(result.message).toBe('Successfully navigated to "HomeScreen" using back button');
        expect(result.stepsExecuted).toBe(1);
        expect(result.path).toEqual(["pressButton(back)"]);
        expect(fakeAdbFactory.getFakeClient().getAllCommands()).toEqual(["shell input keyevent 4"]);
        expect(fakeTimer.getSleepHistory()).toEqual([300]);
      } finally {
        ctrlProxySpy.mockRestore();
      }
    });

    test("routes iOS smart-back recovery through the internal pressButton tool without ADB", async () => {
      const now = 1;
      const iOSDevice = {
        deviceId: "ios-simulator-123",
        platform: "ios",
        source: "local",
      } as BootedDevice;
      await fakeGraph.recordNavigationEvent({
        destination: "DetailScreen",
        source: "TEST",
        arguments: {},
        metadata: {},
        timestamp: now,
        sequenceNumber: 0,
      });
      fakeGraph.addNode({
        screenName: "DetailScreen",
        firstSeenAt: now,
        lastSeenAt: now,
        visitCount: 1,
        backStackDepth: 1,
      });
      shouldUseBackButtonSpy = spyOn(
        SmartNavigationHelper,
        "shouldUseBackButton",
      ).mockResolvedValue({
        shouldUseBack: true,
        backPresses: 1,
        reason: "test recommendation",
      });

      let pressButtonArgs: Record<string, unknown> | undefined;
      ToolRegistry.register("pressButton", "pressButton", {}, async (args) => {
        pressButtonArgs = args;
        return { success: true };
      });
      const screenWaiter: ScreenTransitionWaiter = {
        waitForScreen: async (screenName) => screenName === "HomeScreen",
      };
      const fakeTimer = new FakeTimer();
      fakeTimer.enableAutoAdvance();
      navigateTo = new NavigateTo(
        iOSDevice,
        fakeAdbFactory,
        null,
        screenWaiter,
        fakeGraph,
        fakeTimer,
      );

      const result = await navigateTo.execute({ targetScreen: "HomeScreen", platform: "ios" });

      expect(result.success).toBe(true);
      expect(pressButtonArgs).toEqual({
        button: "back",
        platform: "ios",
        deviceId: "ios-simulator-123",
        [INTERNAL_NO_DIFF_PARAM]: true,
      });
      expect(fakeAdbFactory.getFakeClient().getAllCommands()).toEqual([]);
    });

    test("reports an unsuccessful iOS smart-back recovery instead of claiming navigation succeeded", async () => {
      const iOSDevice = {
        ...device,
        deviceId: "ios-simulator-456",
        platform: "ios",
      } as BootedDevice;
      await fakeGraph.recordNavigationEvent({
        destination: "DetailScreen",
        source: "TEST",
        arguments: {},
        metadata: {},
        timestamp: 1,
        sequenceNumber: 0,
      });
      fakeGraph.addNode({
        screenName: "DetailScreen",
        firstSeenAt: 1,
        lastSeenAt: 1,
        visitCount: 1,
        backStackDepth: 1,
      });
      shouldUseBackButtonSpy = spyOn(
        SmartNavigationHelper,
        "shouldUseBackButton",
      ).mockResolvedValue({
        shouldUseBack: true,
        backPresses: 1,
        reason: "test recommendation",
      });
      ToolRegistry.register("pressButton", "pressButton", {}, async () => ({
        success: false,
        error: "back unavailable",
      }));
      navigateTo = new NavigateTo(
        iOSDevice,
        fakeAdbFactory,
        null,
        {
          waitForScreen: async () => true,
        },
        fakeGraph,
      );

      const result = await navigateTo.execute({ targetScreen: "HomeScreen", platform: "ios" });

      expect(result.success).toBe(false);
      expect(result.error).toContain("pressButton failed on ios: back unavailable");
    });
  });

  describe("failure envelopes", () => {
    // A Timer whose now() replays a fixed script (last value sticky), so we can
    // force the elapsed clock to cross the 30s ceiling or report a real, non-zero
    // durationMs without any wall-clock dependency. startTime consumes the first
    // reading; the in-loop timeout check and the envelope's durationMs consume
    // the rest.
    class ScriptedTimer extends FakeTimer {
      private idx = 0;
      constructor(private readonly script: number[]) {
        super();
      }
      now(): number {
        const value = this.script[Math.min(this.idx, this.script.length - 1)];
        this.idx += 1;
        return value;
      }
    }

    function toolEdge(from: string, to: string): NavigationEdge {
      return {
        from,
        to,
        timestamp: 0,
        edgeType: "tool",
        interaction: {
          toolName: "tapOn",
          args: { text: "Next", action: "tap", platform: "android" },
          timestamp: 0,
        },
      };
    }

    function setPath(path: NavigationEdge[]): void {
      fakeGraph.setCurrentScreenValue("HomeScreen");
      fakeGraph.setPathResult({
        found: true,
        path,
        startScreen: "HomeScreen",
        targetScreen: "TargetScreen",
      });
    }

    test("reports failure and current screen when the final edge is not reached", async () => {
      setPath([toolEdge("HomeScreen", "TargetScreen")]);
      const progressMessages: string[] = [];
      navigateTo = new NavigateTo(
        device,
        fakeAdbFactory,
        { setupUIState: async () => [], setupScrollPosition: async () => null },
        { waitForScreen: async () => false },
        fakeGraph,
        new FakeTimer(),
      );

      const result = await navigateTo.execute(
        { targetScreen: "TargetScreen", platform: "android" },
        async (_current, _total, message) => {
          progressMessages.push(message);
        },
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain('did not reach "TargetScreen"');
      expect(result.message).toContain('"HomeScreen"');
      expect(result.message).not.toContain("Successfully navigated");
      expect(result.error).toBe(result.message);
      expect(result.currentScreen).toBe("HomeScreen");
      expect(result.stepsExecuted).toBe(1);
      expect(result.path).toHaveLength(1);
      expect(progressMessages.at(-1)).toBe("Waiting for TargetScreen");
    });

    test("default waiter advances only with the injected FakeTimer", async () => {
      setPath([toolEdge("HomeScreen", "TargetScreen")]);
      const timer = new FakeTimer();
      // Fail immediately if the default waiter tries to use real time, including before the fix.
      const realSleepSpy = spyOn(defaultTimer, "sleep").mockImplementation(async () => {
        throw new Error("Unexpected real timer sleep");
      });
      navigateTo = new NavigateTo(
        device,
        fakeAdbFactory,
        { setupUIState: async () => [], setupScrollPosition: async () => null },
        null,
        fakeGraph,
        timer,
      );
      let settled = false;
      const execution = navigateTo
        .execute({ targetScreen: "TargetScreen", platform: "android" })
        .then((result) => {
          settled = true;
          return result;
        });

      try {
        // Drain the asynchronous tool replay without advancing fake time.
        for (let i = 0; i < 30; i++) {
          await Promise.resolve();
        }
        expect(realSleepSpy).not.toHaveBeenCalled();
        expect(timer.getPendingSleeps()).toEqual([500]);
        expect(settled).toBe(false);
        for (let elapsed = 500; elapsed < 5000; elapsed += 500) {
          await timer.advanceTimeAsync(500);
          expect(settled).toBe(false);
        }
        await timer.advanceTimeAsync(500);
        const result = await execution;

        expect(result.success).toBe(false);
        expect(result.message).toContain('did not reach "TargetScreen"');
        expect(result.durationMs).toBe(5000);
        expect(timer.getSleepHistory()).toEqual(Array(10).fill(500));
      } finally {
        realSleepSpy.mockRestore();
      }
    });

    test.each([{ path: [] }, { path: [toolEdge("HomeScreen", "OtherScreen")] }])(
      "does not claim arrival when the path does not end at the requested target: %j",
      async ({ path }) => {
        setPath(path);
        navigateTo = new NavigateTo(
          device,
          fakeAdbFactory,
          { setupUIState: async () => [], setupScrollPosition: async () => null },
          { waitForScreen: async () => true },
          fakeGraph,
          new FakeTimer(),
        );

        const result = await navigateTo.execute({
          targetScreen: "TargetScreen",
          platform: "android",
        });

        expect(result.success).toBe(false);
        expect(result.message).toContain('did not reach "TargetScreen"');
        expect(result.error).toBe(result.message);
      },
    );

    test("continues after an intermediate timeout and succeeds when the final target is reached", async () => {
      setPath([
        toolEdge("HomeScreen", "IntermediateScreen"),
        toolEdge("IntermediateScreen", "TargetScreen"),
      ]);
      const waitedScreens: string[] = [];
      navigateTo = new NavigateTo(
        device,
        fakeAdbFactory,
        { setupUIState: async () => [], setupScrollPosition: async () => null },
        {
          waitForScreen: async (screen) => {
            waitedScreens.push(screen);
            if (screen === "TargetScreen") {
              fakeGraph.setCurrentScreenValue(screen);
              return true;
            }
            return false;
          },
        },
        fakeGraph,
        new FakeTimer(),
      );

      const result = await navigateTo.execute({
        targetScreen: "TargetScreen",
        platform: "android",
      });

      expect(result.success).toBe(true);
      expect(result.message).toBe('Successfully navigated to "TargetScreen"');
      expect(result.error).toBeUndefined();
      expect(result.currentScreen).toBe("TargetScreen");
      expect(result.stepsExecuted).toBe(2);
      expect(waitedScreens).toEqual(["IntermediateScreen", "TargetScreen"]);
    });

    test("aborts with a timeout envelope once the 30s ceiling is crossed", async () => {
      await fakeGraph.recordNavigationEvent({
        destination: "HomeScreen",
        source: "TEST",
        arguments: {},
        metadata: {},
        timestamp: Date.now(),
        sequenceNumber: 0,
      });
      fakeGraph.setPathResult({
        found: true,
        path: [toolEdge("HomeScreen", "TargetScreen")],
        startScreen: "HomeScreen",
        targetScreen: "TargetScreen",
      });

      // startTime = 0, first in-loop check = 40_000 (> MAX_TIMEOUT_MS 30_000).
      const timer = new ScriptedTimer([0, 40_000]);
      navigateTo = new NavigateTo(device, fakeAdbFactory, null, null, fakeGraph, timer);

      const result = await navigateTo.execute({
        targetScreen: "TargetScreen",
        platform: "android",
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe("Navigation timeout (30 seconds)");
      expect(result.stepsExecuted).toBe(0);
      expect(result.partialPath).toEqual([]);
      // A real elapsed duration, not a hard-coded 0 (guards the durationMs mutant).
      expect(result.durationMs).toBe(40_000);
      // The offending tool step must never have run.
      expect(toolCallLog).toHaveLength(0);
    });

    test("reports the failing step number and partial path when a step throws", async () => {
      await fakeGraph.recordNavigationEvent({
        destination: "HomeScreen",
        source: "TEST",
        arguments: {},
        metadata: {},
        timestamp: Date.now(),
        sequenceNumber: 0,
      });
      fakeGraph.setPathResult({
        found: true,
        path: [toolEdge("HomeScreen", "TargetScreen")],
        startScreen: "HomeScreen",
        targetScreen: "TargetScreen",
      });

      const throwingUiStateSetup: UIStateSetup = {
        setupUIState: async () => {
          throw new Error("ui-state boom");
        },
        setupScrollPosition: async () => null,
      };

      // startTime = 0, in-loop timeout check = 100 (no timeout), catch durationMs = 31_000.
      const timer = new ScriptedTimer([0, 100, 31_000]);
      navigateTo = new NavigateTo(
        device,
        fakeAdbFactory,
        throwingUiStateSetup,
        null,
        fakeGraph,
        timer,
      );

      const result = await navigateTo.execute({
        targetScreen: "TargetScreen",
        platform: "android",
      });

      expect(result.success).toBe(false);
      // 1-based step index (guards the `step ${i}` off-by-one mutant).
      expect(result.error).toContain("Failed to execute step 1");
      expect(result.error).toContain("ui-state boom");
      expect(result.partialPath).toEqual([]);
      // Bundled with A3 so the durationMs assertion measures a real elapsed span.
      expect(result.durationMs).toBe(31_000);
    });

    test("records a back-button hop for an edge with no known interaction", async () => {
      await fakeGraph.recordNavigationEvent({
        destination: "HomeScreen",
        source: "TEST",
        arguments: {},
        metadata: {},
        timestamp: Date.now(),
        sequenceNumber: 0,
      });
      fakeGraph.setPathResult({
        found: true,
        path: [{ from: "HomeScreen", to: "TargetScreen", timestamp: 0, edgeType: "back" }],
        startScreen: "HomeScreen",
        targetScreen: "TargetScreen",
      });

      const screenWaiter: ScreenTransitionWaiter = {
        waitForScreen: async (screenName) => screenName === "TargetScreen",
      };
      const timer = new FakeTimer();
      timer.enableAutoAdvance();
      ToolRegistry.register("pressButton", "Fake back tool", {}, async () => ({ success: true }));
      navigateTo = new NavigateTo(device, fakeAdbFactory, null, screenWaiter, fakeGraph, timer);

      const result = await navigateTo.execute({
        targetScreen: "TargetScreen",
        platform: "android",
      });

      expect(result.success).toBe(true);
      // Guards the dropped `executedPath.push("pressButton(back)")` in the
      // no-interaction branch of the step loop.
      expect(result.path).toEqual(["pressButton(back)"]);
      expect(result.stepsExecuted).toBe(1);
    });
  });

  describe("multi-hop navigation", () => {
    test("should find and execute multi-hop path", async () => {
      const now = Date.now();

      // Set up navigation map so fake tools trigger navigation
      navigationMap.set("Settings", "SettingsScreen");
      navigationMap.set("Advanced", "AdvancedScreen");

      // Create path: Home -> Settings -> Advanced
      fakeGraph.recordToolCall("tapOn", { text: "Settings", action: "tap", platform: "android" });
      await fakeGraph.recordNavigationEvent({
        destination: "HomeScreen",
        source: "TEST",
        arguments: {},
        metadata: {},
        timestamp: now,
        sequenceNumber: 0,
      });
      await fakeGraph.recordNavigationEvent({
        destination: "SettingsScreen",
        source: "TEST",
        arguments: {},
        metadata: {},
        timestamp: now + 100,
        sequenceNumber: 1,
      });

      fakeGraph.recordToolCall("tapOn", { text: "Advanced", action: "tap", platform: "android" });
      await fakeGraph.recordNavigationEvent({
        destination: "AdvancedScreen",
        source: "TEST",
        arguments: {},
        metadata: {},
        timestamp: now + 200,
        sequenceNumber: 2,
      });

      // Go back to Home
      await fakeGraph.recordNavigationEvent({
        destination: "HomeScreen",
        source: "TEST",
        arguments: {},
        metadata: {},
        timestamp: now + 300,
        sequenceNumber: 3,
      });

      // Inject fakeGraph via constructor
      navigateTo = new NavigateTo(device, fakeAdbFactory, null, null, fakeGraph);

      await navigateTo.execute({
        targetScreen: "AdvancedScreen",
        platform: "android",
      });

      // Should execute two tool calls: Home -> Settings -> Advanced
      expect(toolCallLog).toHaveLength(2);
      expect(toolCallLog[0].args.text).toBe("Settings");
      expect(toolCallLog[1].args.text).toBe("Advanced");
    });
  });
});
