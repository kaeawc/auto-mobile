import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import { NavigateTo } from "../../../src/features/navigation/NavigateTo";
import type { NavigationGraphManager } from "../../../src/features/navigation/NavigationGraphManager";
import type { UIStateSetup } from "../../../src/features/navigation/interfaces/UIStateSetup";
import type {
  ForegroundObservation,
  ForegroundObserver,
} from "../../../src/features/navigation/foregroundOverlay";
import type { BootedDevice } from "../../../src/models";
import { ToolRegistry } from "../../../src/server/toolRegistry";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeTimer } from "../../fakes/FakeTimer";
import {
  installInMemoryNavManager,
  type InMemoryNavManagerHarness,
} from "../../helpers/navigationTestHarness";

const APP_ID = "com.example.fallback";
const STALE_TAP = { selector: { text: "Stale" }, action: "tap" };
const SETTINGS_TAP = { selector: { text: "Settings" }, action: "tap" };

type ToolArgs = Record<string, unknown>;

/**
 * navigateTo edge fallback and failure memory (#10031) on the REAL in-memory
 * NavigationGraphManager: when replaying the preferred edge for a screen pair does not
 * reach its target, the next-best edge for that pair is tried, and the failure is
 * remembered so later path searches rank that edge below the others.
 */
describe("navigateTo edge fallback (#10031)", () => {
  let harness: InMemoryNavManagerHarness;
  let manager: NavigationGraphManager;
  let sequence = 0;
  let clock = 0;
  let dispatched: string[];
  /** What a replayed tapOn does, keyed by the selector text it targets. */
  let tapBehaviour: Record<string, "navigates" | "no-effect" | "tool-error">;
  let backNavigates: boolean;
  /** What a fresh observation after a failed replay reports; null = the observation fails. */
  let observation: ForegroundObservation | null;
  let observations: number;

  const device: BootedDevice = { deviceId: "fake", platform: "ios", name: "Fake" };
  const noSetup: UIStateSetup = {
    setupUIState: async () => [],
    setupScrollPosition: async () => null,
  };

  beforeEach(async () => {
    harness = await installInMemoryNavManager();
    manager = harness.manager;
    sequence = 0;
    clock = Date.now();
    dispatched = [];
    tapBehaviour = {};
    backNavigates = true;
    observation = {};
    observations = 0;
    await manager.setCurrentApp(APP_ID);
    registerTools();
  });

  afterEach(async () => {
    ToolRegistry.clearTools();
    await harness.dispose();
  });

  /** Move to `screen`, as the device would after the tool call that caused it. */
  async function go(screen: string, tool?: { name: string; args: ToolArgs }): Promise<void> {
    if (tool) {
      manager.recordToolCall(tool.name, tool.args);
    }
    sequence += 1;
    clock += 100;
    await manager.recordNavigationEvent({
      destination: screen,
      source: "",
      arguments: {},
      metadata: {},
      timestamp: clock,
      sequenceNumber: sequence,
      applicationId: APP_ID,
    });
  }

  function registerTools(): void {
    ToolRegistry.clearTools();
    ToolRegistry.register(
      "tapOn",
      "Fake tap",
      z.object({ selector: z.object({ text: z.string() }), action: z.string() }),
      async (args) => {
        const label = args.selector.text;
        dispatched.push(`tapOn:${label}`);
        const behaviour = tapBehaviour[label] ?? "no-effect";
        if (behaviour === "tool-error") {
          return { success: false, error: `no element "${label}"` };
        }
        if (behaviour === "navigates") {
          await go("Settings", { name: "tapOn", args: { ...args } });
        }
        return { success: true };
      },
    );
    ToolRegistry.register("pressButton", "Fake press", z.object({}), async () => {
      dispatched.push("pressButton");
      if (backNavigates) {
        await go("Settings");
      }
      return { success: true };
    });
  }

  const observer: ForegroundObserver = {
    execute: async () => {
      observations += 1;
      if (!observation) {
        throw new Error("observe unavailable");
      }
      return observation;
    },
  };

  function navigate(target: string) {
    return new NavigateTo(
      device,
      new FakeAdbClientFactory(),
      noSetup,
      { waitForScreen: async (screen) => manager.getCurrentScreen() === screen },
      manager,
      new FakeTimer(),
      undefined,
      undefined,
      () => observer,
    ).execute({ targetScreen: target, platform: "ios" });
  }

  /** Home -> Settings recorded twice by tapOn; the Settings tap is the newer, preferred row. */
  async function recordTwoTapEdges(): Promise<void> {
    await go("Home");
    await go("Settings", { name: "tapOn", args: STALE_TAP });
    await go("Home");
    await go("Settings", { name: "tapOn", args: SETTINGS_TAP });
    await go("Home");
  }

  async function preferredSelector(): Promise<unknown> {
    const result = await manager.findPath("Settings");
    return result.path[0]?.interaction?.args.selector;
  }

  for (const failure of ["no-effect", "tool-error"] as const) {
    test(`a preferred edge that fails on replay (${failure}) falls back to the other tool edge`, async () => {
      await recordTwoTapEdges();
      expect(await preferredSelector()).toEqual({ text: "Settings" });
      tapBehaviour = { Settings: failure, Stale: "navigates" };

      const result = await navigate("Settings");

      expect(result.success).toBe(true);
      expect(dispatched).toEqual(["tapOn:Settings", "tapOn:Stale"]);
      expect(result.currentScreen).toBe("Settings");
    });
  }

  test("the next search prefers the edge that worked over the one that failed", async () => {
    await recordTwoTapEdges();
    tapBehaviour = { Settings: "no-effect", Stale: "navigates" };
    await navigate("Settings");
    await go("Home");

    expect(await preferredSelector()).toEqual({ text: "Stale" });

    dispatched = [];
    const second = await navigate("Settings");

    expect(second.success).toBe(true);
    expect(dispatched).toEqual(["tapOn:Stale"]);
  });

  test("a failed tool edge does not shadow a recorded Back edge for the same pair", async () => {
    await go("Home");
    await go("Settings", { name: "pressButton", args: { button: "back" } });
    await go("Home");
    await go("Settings", { name: "tapOn", args: SETTINGS_TAP });
    await go("Home");
    tapBehaviour = { Settings: "no-effect" };

    const first = await navigate("Settings");

    expect(first.success).toBe(true);
    expect(dispatched).toEqual(["tapOn:Settings", "pressButton"]);

    await go("Home");
    const next = await manager.findPath("Settings");
    expect(next.path[0].interaction?.toolName).toBe("pressButton");
    dispatched = [];
    expect((await navigate("Settings")).success).toBe(true);
    expect(dispatched).toEqual(["pressButton"]);
  });

  test("a transition with no recorded action is never replayed as a guessed Back press (#10196)", async () => {
    await go("Home");
    await go("Settings");
    await go("Home");

    const result = await navigate("Settings");

    expect(result.success).toBe(false);
    expect(result.error).toContain('No known path from "Home" to "Settings"');
    expect(result.error).toContain("cannot be replayed");
    expect(dispatched).toEqual([]);
  });

  test("a failed tool edge is not retried through an unrecorded edge as Back (#10196)", async () => {
    await go("Home");
    await go("Settings");
    await go("Home");
    await go("Settings", { name: "tapOn", args: SETTINGS_TAP });
    await go("Home");
    tapBehaviour = { Settings: "no-effect" };

    const result = await navigate("Settings");

    expect(result.success).toBe(false);
    expect(dispatched).toEqual(["tapOn:Settings"]);
  });

  test("a remembered failure is forgotten when the edge's replay later succeeds", async () => {
    await recordTwoTapEdges();
    const preferred = (await manager.findPath("Settings")).path[0];

    manager.recordEdgeReplayOutcome(preferred, false);
    expect(await preferredSelector()).toEqual({ text: "Stale" });

    manager.recordEdgeReplayOutcome(preferred, true);
    expect(await preferredSelector()).toEqual({ text: "Settings" });
  });

  test("a remembered failure is forgotten when the same action is recorded again", async () => {
    await recordTwoTapEdges();
    manager.recordEdgeReplayOutcome((await manager.findPath("Settings")).path[0], false);
    expect(await preferredSelector()).toEqual({ text: "Stale" });

    await go("Settings", { name: "tapOn", args: SETTINGS_TAP });
    await go("Home");

    expect(await preferredSelector()).toEqual({ text: "Settings" });
  });

  test("every edge failing reports the failure after trying each action once", async () => {
    await recordTwoTapEdges();
    tapBehaviour = { Settings: "no-effect", Stale: "no-effect" };

    const result = await navigate("Settings");

    expect(result.success).toBe(false);
    expect(dispatched).toEqual(["tapOn:Settings", "tapOn:Stale"]);
    expect(result.error).toContain("did not reach expected screen");
    expect(result.currentScreen).toBe("Home");
  });

  test("a step that left the source screen is not retried with another edge", async () => {
    await recordTwoTapEdges();
    // The preferred tap lands somewhere unexpected instead of Settings.
    ToolRegistry.clearTools();
    ToolRegistry.register(
      "tapOn",
      "Fake tap",
      z.object({ selector: z.object({ text: z.string() }), action: z.string() }),
      async (args) => {
        dispatched.push(`tapOn:${args.selector.text}`);
        await go("Elsewhere");
        return { success: true };
      },
    );

    const result = await navigate("Settings");

    expect(result.success).toBe(false);
    expect(dispatched).toEqual(["tapOn:Settings"]);
    expect(result.currentScreen).toBe("Elsewhere");
  });

  describe("re-observing before a fallback edge (#10133)", () => {
    beforeEach(async () => {
      await recordTwoTapEdges();
      tapBehaviour = { Settings: "no-effect", Stale: "navigates" };
    });

    test("a clean observation still lets the fallback edge run", async () => {
      const result = await navigate("Settings");

      expect(result.success).toBe(true);
      expect(observations).toBe(1);
      expect(dispatched).toEqual(["tapOn:Settings", "tapOn:Stale"]);
    });

    test("an overlay the graph does not report stops the fallback and names it", async () => {
      observation = { notificationPermissionDetected: true };

      const result = await navigate("Settings");

      expect(result.success).toBe(false);
      expect(dispatched).toEqual(["tapOn:Settings"]);
      expect(result.error).toContain("Not trying a fallback edge");
      expect(result.error).toContain("a notification permission dialog");
      expect(result.error).toContain("did not reach expected screen");
    });

    test("a Back-press fallback is not sent onto an unreported system dialog", async () => {
      await go("Home");
      await go("Settings");
      await go("Home");
      await go("Settings", { name: "tapOn", args: SETTINGS_TAP });
      await go("Home");
      tapBehaviour = { Settings: "no-effect" };
      observation = {
        activeWindow: {
          appId: "com.android.permissioncontroller",
          activityName: "",
          layoutSeqSum: 0,
        },
      };

      const result = await navigate("Settings");

      expect(result.success).toBe(false);
      expect(dispatched).toEqual(["tapOn:Settings"]);
      expect(result.error).toContain("another app window (com.android.permissioncontroller)");
    });

    test("an observation that moved the graph elsewhere reports where the device is", async () => {
      const unobserved: ForegroundObserver = {
        execute: async () => {
          await go("Elsewhere");
          return {};
        },
      };
      const result = await new NavigateTo(
        device,
        new FakeAdbClientFactory(),
        noSetup,
        { waitForScreen: async (screen) => manager.getCurrentScreen() === screen },
        manager,
        new FakeTimer(),
        undefined,
        undefined,
        () => unobserved,
      ).execute({ targetScreen: "Settings", platform: "ios" });

      expect(result.success).toBe(false);
      expect(dispatched).toEqual(["tapOn:Settings"]);
      expect(result.currentScreen).toBe("Elsewhere");
      expect(result.error).toContain('the observed screen is "Elsewhere"');
    });

    test("an observation failure never lets the fallback run blind", async () => {
      observation = null;

      const result = await navigate("Settings");

      expect(result.success).toBe(false);
      expect(dispatched).toEqual(["tapOn:Settings"]);
      expect(result.error).toContain("the device could not be observed (observe unavailable)");
    });

    test("no observation is taken when the replayed step reached its target", async () => {
      tapBehaviour = { Settings: "navigates", Stale: "navigates" };

      const result = await navigate("Settings");

      expect(result.success).toBe(true);
      expect(observations).toBe(0);
    });
  });
});
