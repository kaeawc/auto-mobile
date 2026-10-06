import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { z } from "zod/v4";
import { NavigateTo } from "../../../src/features/navigation/NavigateTo";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android";
import { SmartNavigationHelper } from "../../../src/features/navigation/SmartNavigationHelper";
import type { ForegroundObserver } from "../../../src/features/navigation/foregroundOverlay";
import type { ScreenTransitionWaiter } from "../../../src/features/navigation/interfaces/ScreenTransitionWaiter";
import type { UIStateSetup } from "../../../src/features/navigation/interfaces/UIStateSetup";
import type { BootedDevice } from "../../../src/models";
import {
  navigateToHandler,
  resetNavigateToFactory,
  setNavigateToFactory,
} from "../../../src/server/navigationTools";
import { ToolRegistry } from "../../../src/server/toolRegistry";
import type { NavigationEdge } from "../../../src/utils/interfaces/NavigationGraph";
import { OPERATION_CANCELLED_MESSAGE } from "../../../src/utils/constants";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeNavigationGraphManager } from "../../fakes/FakeNavigationGraphManager";
import { FakeTimer } from "../../fakes/FakeTimer";

const device: BootedDevice = { deviceId: "replay-device", platform: "ios", name: "Replay device" };
const options = { targetScreen: "D", platform: "ios" } as const;
const noSetup: UIStateSetup = {
  setupUIState: async () => [],
  setupScrollPosition: async () => null,
};
const edge = (from: string, to: string): NavigationEdge => ({
  from,
  to,
  timestamp: 0,
  edgeType: "tool",
  interaction: { toolName: "tapOn", args: { text: `to${to}` }, timestamp: 0 },
});

// A failed replay re-observes the device before any fallback edge (#10133); a fake keeps
// that off the real observe path (which would spawn device tools) and reports no overlay.
const cleanForegroundObserver: ForegroundObserver = { execute: async () => ({}) };

async function drainMicrotasks(): Promise<void> {
  for (let i = 0; i < 60; i++) {
    await Promise.resolve();
  }
}

describe("NavigateTo replay safety", () => {
  let graph: FakeNavigationGraphManager;
  let timer: FakeTimer;
  let taps: string[];
  let onTap: (signal?: AbortSignal) => void;

  beforeEach(() => {
    ToolRegistry.clearTools();
    graph = new FakeNavigationGraphManager();
    graph.setCurrentScreenValue("A");
    graph.setPathResult({
      found: true,
      path: [edge("A", "B"), edge("B", "C"), edge("C", "D")],
      startScreen: "A",
      targetScreen: "D",
    });
    timer = new FakeTimer();
    taps = [];
    onTap = () => {};
    ToolRegistry.register(
      "tapOn",
      "Fake tap",
      z.object({ text: z.string() }),
      async (args, _progress, signal) => {
        taps.push(args.text);
        onTap(signal);
        return { success: true };
      },
    );
  });

  afterEach(() => {
    ToolRegistry.clearTools();
    resetNavigateToFactory();
  });

  function makeNav(
    waiter: ScreenTransitionWaiter | null = { waitForScreen: async () => true },
    setup = noSetup,
  ): NavigateTo {
    return new NavigateTo(
      device,
      new FakeAdbClientFactory(),
      setup,
      waiter,
      graph,
      timer,
      undefined,
      undefined,
      () => cleanForegroundObserver,
    );
  }

  for (const failedStep of [1, 2]) {
    test(`stops at missed replay step ${failedStep} and reports only dispatched actions`, async () => {
      let waits = 0;
      const result = await makeNav({
        waitForScreen: async (screen) => {
          waits++;
          if (waits === failedStep) {
            return false;
          }
          graph.setCurrentScreenValue(screen);
          return true;
        },
      }).execute(options);
      expect(taps).toEqual(failedStep === 1 ? ["toB"] : ["toB", "toC"]);
      expect(result.success).toBe(false);
      expect(result.error).toContain(`step ${failedStep}`);
      expect(result.error).toContain(`expected screen "${failedStep === 1 ? "B" : "C"}"`);
      expect(result.error).toContain(`observed current screen "${failedStep === 1 ? "A" : "B"}"`);
      expect(result.error).toContain(`${failedStep} steps ran`);
      expect(result.stepsExecuted).toBe(failedStep);
      expect(result.partialPath ?? result.path).toHaveLength(failedStep);
      expect(waits).toBe(failedStep);
    });
  }

  test("a waiter miss succeeds with only the first tap when the re-read reports the final target", async () => {
    const read = spyOn(graph, "getCurrentScreen");
    const waitedScreens: string[] = [];
    const progressMessages: string[] = [];
    try {
      const result = await makeNav({
        waitForScreen: async (screen) => {
          waitedScreens.push(screen);
          graph.setCurrentScreenValue("D");
          return false;
        },
      }).execute(options, async (_current, _total, message) => {
        progressMessages.push(message);
      });
      expect(result).toEqual({
        success: true,
        message: 'Successfully navigated to "D"',
        currentScreen: "D",
        targetScreen: "D",
        stepsExecuted: 1,
        path: ['tapOn({"text":"toB"})'],
        durationMs: 0,
      });
      expect(taps).toEqual(["toB"]);
      expect(waitedScreens).toEqual(["B"]);
      expect(progressMessages.at(-1)).toBe("Arrived at D");
      // The initial read and one fallback read; success must not read again.
      expect(read).toHaveBeenCalledTimes(2);
    } finally {
      read.mockRestore();
    }
  });

  for (const missedStep of [1, 3]) {
    test(`continues replay when missed step ${missedStep} re-reads the expected screen`, async () => {
      const read = spyOn(graph, "getCurrentScreen");
      const waitedScreens: string[] = [];
      try {
        const result = await makeNav({
          waitForScreen: async (screen) => {
            waitedScreens.push(screen);
            graph.setCurrentScreenValue(screen);
            return waitedScreens.length !== missedStep;
          },
        }).execute(options);
        expect(result.success).toBe(true);
        expect(result.message).toBe('Successfully navigated to "D"');
        expect(result.error).toBeUndefined();
        expect(result.currentScreen).toBe("D");
        expect(result.stepsExecuted).toBe(3);
        expect(result.path).toEqual([
          'tapOn({"text":"toB"})',
          'tapOn({"text":"toC"})',
          'tapOn({"text":"toD"})',
        ]);
        expect(result.partialPath).toBeUndefined();
        expect(taps).toEqual(["toB", "toC", "toD"]);
        expect(waitedScreens).toEqual(["B", "C", "D"]);
        // A confirmed final arrival keeps its normal result read; a missed one reuses the fallback.
        expect(read).toHaveBeenCalledTimes(missedStep === 3 ? 2 : 3);
      } finally {
        read.mockRestore();
      }
    });
  }

  for (const observedScreen of ["Other", null]) {
    test(`a waiter miss fails using the single re-read value ${observedScreen}`, async () => {
      const read = spyOn(graph, "getCurrentScreen");
      try {
        const result = await makeNav({
          waitForScreen: async () => {
            graph.setCurrentScreenValue(observedScreen);
            return false;
          },
        }).execute(options);
        expect(result.success).toBe(false);
        expect(result.currentScreen).toBe(observedScreen);
        expect(result.error).toContain("step 1");
        expect(result.error).toContain('expected screen "B"');
        expect(result.error).toContain(`observed current screen "${observedScreen ?? "unknown"}"`);
        expect(result.error).toContain("1 steps ran (1 actions dispatched)");
        expect(result.stepsExecuted).toBe(1);
        expect(result.partialPath).toEqual(['tapOn({"text":"toB"})']);
        expect(result.path).toBeUndefined();
        expect(taps).toEqual(["toB"]);
        expect(read).toHaveBeenCalledTimes(2);
      } finally {
        read.mockRestore();
      }
    });
  }

  test("abort just before the fallback prevents the re-read and later taps", async () => {
    const controller = new AbortController();
    const read = spyOn(graph, "getCurrentScreen");
    try {
      const nav = makeNav({
        waitForScreen: async () => {
          graph.setCurrentScreenValue("D");
          controller.abort();
          return false;
        },
      });
      await expect(nav.execute(options, undefined, controller.signal)).rejects.toThrow(
        OPERATION_CANCELLED_MESSAGE,
      );
      expect(read).toHaveBeenCalledTimes(1);
      expect(taps).toEqual(["toB"]);
    } finally {
      read.mockRestore();
    }
  });

  test("abort during the fallback re-read rejects even when it reports the final target", async () => {
    const controller = new AbortController();
    const read = spyOn(graph, "getCurrentScreen")
      .mockReturnValueOnce("A")
      .mockImplementation(() => {
        controller.abort();
        return "D";
      });
    try {
      const nav = makeNav({ waitForScreen: async () => false });
      await expect(nav.execute(options, undefined, controller.signal)).rejects.toThrow(
        OPERATION_CANCELLED_MESSAGE,
      );
      expect(read).toHaveBeenCalledTimes(2);
      expect(taps).toEqual(["toB"]);
    } finally {
      read.mockRestore();
    }
  });
  test("keeps successful replay results unchanged", async () => {
    const result = await makeNav({
      waitForScreen: async (screen) => {
        graph.setCurrentScreenValue(screen);
        return true;
      },
    }).execute(options);
    expect(taps).toEqual(["toB", "toC", "toD"]);
    expect(result).toEqual({
      success: true,
      message: 'Successfully navigated to "D"',
      currentScreen: "D",
      targetScreen: "D",
      stepsExecuted: 3,
      path: ['tapOn({"text":"toB"})', 'tapOn({"text":"toC"})', 'tapOn({"text":"toD"})'],
      durationMs: 0,
    });
  });

  test("handler rejects cancellation during the first tap without replaying later taps", async () => {
    const controller = new AbortController();
    const signals: Array<AbortSignal | undefined> = [];
    onTap = (signal) => {
      signals.push(signal);
      controller.abort();
    };
    setNavigateToFactory(() => makeNav());
    await expect(navigateToHandler(device, options, undefined, controller.signal)).rejects.toThrow(
      OPERATION_CANCELLED_MESSAGE,
    );
    expect(taps).toEqual(["toB"]);
    expect(signals).toEqual([controller.signal]);
  });

  test("rejects an already aborted request before setup or the first tap", async () => {
    const controller = new AbortController();
    controller.abort();
    const setups: string[] = [];
    const nav = makeNav(undefined, {
      setupUIState: async () => {
        setups.push("setup");
        return [];
      },
      setupScrollPosition: async () => null,
    });
    await expect(nav.execute(options, undefined, controller.signal)).rejects.toThrow(
      OPERATION_CANCELLED_MESSAGE,
    );
    expect(taps).toEqual([]);
    expect(setups).toEqual([]);
  });

  test("an aborted request cannot succeed just because it is already on target", async () => {
    graph.setCurrentScreenValue("D");
    const controller = new AbortController();
    controller.abort();
    await expect(makeNav().execute(options, undefined, controller.signal)).rejects.toThrow(
      OPERATION_CANCELLED_MESSAGE,
    );
    expect(taps).toEqual([]);
  });
  test("rejects cancellation between confirmed steps", async () => {
    const controller = new AbortController();
    const nav = makeNav({
      waitForScreen: async () => {
        controller.abort();
        return true;
      },
    });
    await expect(nav.execute(options, undefined, controller.signal)).rejects.toThrow(
      OPERATION_CANCELLED_MESSAGE,
    );
    expect(taps).toEqual(["toB"]);
  });

  test("checks cancellation again after progress before dispatching setup", async () => {
    const controller = new AbortController();
    const setups: string[] = [];
    const nav = makeNav(undefined, {
      setupUIState: async () => {
        setups.push("setup");
        return [];
      },
      setupScrollPosition: async () => null,
    });
    await expect(
      nav.execute(
        options,
        async () => {
          controller.abort();
        },
        controller.signal,
      ),
    ).rejects.toThrow(OPERATION_CANCELLED_MESSAGE);
    expect(setups).toEqual([]);
    expect(taps).toEqual([]);
  });

  test("smart back stops after abort in its first press", async () => {
    graph.addNode({
      screenName: "A",
      firstSeenAt: 0,
      lastSeenAt: 0,
      visitCount: 1,
      backStackDepth: 3,
    });
    const recommendation = spyOn(SmartNavigationHelper, "shouldUseBackButton").mockResolvedValue({
      shouldUseBack: true,
      backPresses: 3,
      reason: "test",
    });
    timer.enableAutoAdvance();
    const controller = new AbortController();
    const presses: Array<AbortSignal | undefined> = [];
    ToolRegistry.register(
      "pressButton",
      "Fake back",
      z.object({ button: z.string() }),
      async (_args, _progress, signal) => {
        presses.push(signal);
        controller.abort();
        return { success: true };
      },
    );
    try {
      await expect(makeNav().execute(options, undefined, controller.signal)).rejects.toThrow(
        OPERATION_CANCELLED_MESSAGE,
      );
      expect(presses).toEqual([controller.signal]);
      expect(timer.getSleepHistory()).toEqual([]);
    } finally {
      recommendation.mockRestore();
    }
  });

  test("abort ends the pending default screen wait without advancing five seconds", async () => {
    const controller = new AbortController();
    let outcome: unknown;
    const execution = makeNav(null)
      .execute(options, undefined, controller.signal)
      .then(
        (value) => {
          outcome = value;
        },
        (error: unknown) => {
          outcome = error;
        },
      );
    await drainMicrotasks();
    expect(timer.getPendingSleeps()).toEqual([500]);
    controller.abort();
    await drainMicrotasks();
    try {
      expect(outcome).toBeInstanceOf(Error);
      expect(outcome).toHaveProperty("message", OPERATION_CANCELLED_MESSAGE);
      expect(timer.now()).toBe(0);
      expect(timer.getSleepHistory()).toEqual([500]);
      expect(taps).toEqual(["toB"]);
    } finally {
      // Drain the original polling sleep as well when running against the unfixed source.
      timer.enableAutoAdvance();
      timer.resolveAll();
      await execution;
    }
  });
  test("Android smart back forwards cancellation and dispatches no fallback keyevent", async () => {
    graph.addNode({
      screenName: "A",
      firstSeenAt: 0,
      lastSeenAt: 0,
      visitCount: 1,
      backStackDepth: 3,
    });
    const controller = new AbortController();
    const recommendation = spyOn(SmartNavigationHelper, "shouldUseBackButton").mockResolvedValue({
      shouldUseBack: true,
      backPresses: 3,
      reason: "test",
    });
    const presses: Array<AbortSignal | undefined> = [];
    const proxy = spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue({
      requestGlobalAction: async (
        _action: string,
        _timeout?: number,
        _packageName?: string,
        _frameContext?: string,
        signal?: AbortSignal,
      ) => {
        presses.push(signal);
        controller.abort();
        return { success: false, error: "cancelled" };
      },
    } as never);
    const adb = new FakeAdbClientFactory();
    timer.enableAutoAdvance();
    try {
      const nav = new NavigateTo(
        { ...device, platform: "android" },
        adb,
        noSetup,
        { waitForScreen: async () => true },
        graph,
        timer,
      );
      await expect(
        nav.execute({ ...options, platform: "android" }, undefined, controller.signal),
      ).rejects.toThrow(OPERATION_CANCELLED_MESSAGE);
      expect(presses).toEqual([controller.signal]);
      expect(adb.getFakeClient().getAllCommands()).toEqual([]);
    } finally {
      proxy.mockRestore();
      recommendation.mockRestore();
    }
  });

  test("smart back sleep ends on abort before another press", async () => {
    graph.addNode({
      screenName: "A",
      firstSeenAt: 0,
      lastSeenAt: 0,
      visitCount: 1,
      backStackDepth: 3,
    });
    const recommendation = spyOn(SmartNavigationHelper, "shouldUseBackButton").mockResolvedValue({
      shouldUseBack: true,
      backPresses: 3,
      reason: "test",
    });
    const controller = new AbortController();
    let presses = 0;
    ToolRegistry.register("pressButton", "Fake back", {}, async () => {
      presses++;
      return { success: true };
    });
    let outcome: unknown;
    const execution = makeNav()
      .execute(options, undefined, controller.signal)
      .then(
        (value) => {
          outcome = value;
        },
        (error: unknown) => {
          outcome = error;
        },
      );
    await drainMicrotasks();
    controller.abort();
    await drainMicrotasks();
    try {
      expect(timer.getSleepHistory()).toEqual([300]);
      expect(timer.now()).toBe(0);
      expect(outcome).toHaveProperty("message", OPERATION_CANCELLED_MESSAGE);
      expect(presses).toBe(1);
    } finally {
      timer.enableAutoAdvance();
      timer.resolveAll();
      await execution;
      recommendation.mockRestore();
    }
  });

  test("scroll setup receives the signal and its abort prevents UI setup and replay", async () => {
    const controller = new AbortController();
    const first = edge("A", "B");
    first.uiState = { scrollPosition: { targetElement: { text: "toB" }, direction: "down" } };
    graph.setPathResult({ found: true, path: [first], startScreen: "A", targetScreen: "B" });
    const actions: string[] = [];
    const setup: UIStateSetup = {
      setupScrollPosition: async (_position, _platform, signal) => {
        expect(signal).toBe(controller.signal);
        actions.push("scroll");
        controller.abort();
        return "swipeOn";
      },
      setupUIState: async () => {
        actions.push("setup");
        return [];
      },
    };
    await expect(
      makeNav(undefined, setup).execute(
        { ...options, targetScreen: "B" },
        undefined,
        controller.signal,
      ),
    ).rejects.toThrow(OPERATION_CANCELLED_MESSAGE);
    expect(actions).toEqual(["scroll"]);
    expect(taps).toEqual([]);
  });
});
