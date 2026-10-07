import { isolateToolRegistry } from "../helpers/withTemporaryTool";
import { describe, expect, spyOn, test } from "bun:test";
import type { ObserveResult } from "../../src/models";
import { ResourceRegistry } from "../../src/server/resourceRegistry";
import {
  observeSchema,
  registerObserveTools,
  waitForObservation,
  type WaitForWithSettled,
} from "../../src/server/observeTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { FakeObserveScreen } from "../fakes/FakeObserveScreen";
import { FakeTimer } from "../fakes/FakeTimer";
import {
  capturedOverlayHierarchy,
  capturedTwoWindowHierarchy,
  observationOf,
} from "../helpers/overlayWindowCapture";

isolateToolRegistry();

// Captured Recents overview with its floating window relabelled as the CtrlProxy
// overlay; see test/helpers/overlayWindowCapture.ts. "YouTube" is overlay-only.

async function observe(result: ObserveResult, args: Record<string, unknown>) {
  const screen = new FakeObserveScreen();
  screen.setObserveResult(result);
  const notify = spyOn(ResourceRegistry, "notifyResourcesUpdated").mockResolvedValue(undefined);
  try {
    registerObserveTools({
      createScreen: () => ({
        execute: screen.execute.bind(screen),
        executeDeviceRead: screen.execute.bind(screen),
        captureScreenshot: screen.captureScreenshot.bind(screen),
        appendRawViewHierarchy: screen.appendRawViewHierarchy.bind(screen),
        getMostRecentCachedObserveResult: screen.getMostRecentCachedObserveResult.bind(screen),
      }),
    });
    const tool = ToolRegistry.getTool("observe")!;
    return await tool.deviceAwareHandler!(
      { deviceId: "observe-target", name: "Fake", platform: "android" },
      tool.schema.parse({ screenshot: "none", ...args }),
    );
  } finally {
    notify.mockRestore();
    ToolRegistry.clearTools();
  }
}

describe("observe target (#9305)", () => {
  test("the schema accepts app and overlay only", () => {
    expect(observeSchema.safeParse({ platform: "android", target: "app" }).success).toBe(true);
    expect(observeSchema.safeParse({ platform: "android", target: "overlay" }).success).toBe(true);
    expect(observeSchema.safeParse({ platform: "android", target: "both" }).success).toBe(false);
  });

  test("omitted target serves overlay and app nodes", async () => {
    const response = await observe(observationOf(capturedOverlayHierarchy()), {});
    expect(JSON.stringify(response)).toContain("YouTube");
  });

  test('"app" serves the app without overlay nodes and leaves the observation intact', async () => {
    const result = observationOf(capturedOverlayHierarchy());
    const response = await observe(result, { target: "app" });

    expect(JSON.stringify(response)).not.toContain("YouTube");
    expect(JSON.stringify(response)).toContain("Screenshot");
    expect(JSON.stringify(result.viewHierarchy)).toContain("YouTube");
  });

  test('"overlay" with no overlay showing is an actionable error', async () => {
    await expect(
      observe(observationOf(capturedTwoWindowHierarchy()), { target: "overlay" }),
    ).rejects.toThrow("no AutoMobile overlay is showing");
  });
});

describe("observe waitFor with target (#9305)", () => {
  const waitFor = async (target: WaitForWithSettled["target"]) => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const screen = new FakeObserveScreen();
    screen.setObserveResult((index) => {
      const viewHierarchy = capturedOverlayHierarchy();
      viewHierarchy.updatedAt = (index + 1) * 10;
      return observationOf(viewHierarchy);
    });
    return waitForObservation(
      screen,
      { text: "YouTube", timeout: 300, target } satisfies WaitForWithSettled,
      undefined,
      false,
      timer,
    );
  };

  test("an overlay-only element matches by default and for overlay", async () => {
    expect((await waitFor(undefined)).matched).toBe(true);
    expect((await waitFor("overlay")).matched).toBe(true);
  });

  test('an overlay-only element never matches for "app"', async () => {
    const outcome = await waitFor("app");
    expect(outcome.matched).toBe(false);
    expect(outcome.awaitTimeout).toBe(true);
  });

  test.each([
    [undefined, true],
    ["overlay", true],
    ["app", false],
  ] as const)("the DSL appear predicate with target %p matches=%p", async (target, matched) => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const screen = new FakeObserveScreen();
    screen.setObserveResult((index) => {
      const viewHierarchy = capturedOverlayHierarchy();
      viewHierarchy.updatedAt = (index + 1) * 10;
      return observationOf(viewHierarchy);
    });
    const outcome = await waitForObservation(
      screen,
      { for: "appear", text: "YouTube", timeout: 300, target } satisfies WaitForWithSettled,
      undefined,
      false,
      timer,
    );
    expect(outcome.matched).toBe(matched);
  });
});
