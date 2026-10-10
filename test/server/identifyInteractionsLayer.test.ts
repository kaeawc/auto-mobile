import { isolateToolRegistry } from "../helpers/withTemporaryTool";
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { NavigationGraphManager } from "../../src/features/navigation/NavigationGraphManager";
import type { ObserveResult } from "../../src/models";
import { identifyInteractionsSchema, registerObserveTools } from "../../src/server/observeTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { isDebugModeEnabled, setDebugModeEnabled } from "../../src/utils/debug";
import { FakeNavigationGraphManager } from "../fakes/FakeNavigationGraphManager";
import { FakeObserveScreen } from "../fakes/FakeObserveScreen";
import { FakeTimer } from "../fakes/FakeTimer";
import {
  capturedPrototypeHierarchy,
  capturedTwoWindowHierarchy,
  observationOf,
} from "../helpers/prototypeWindowCapture";

isolateToolRegistry();

// Captured Recents overview with its floating window relabelled as the CtrlProxy
// prototype; see test/helpers/prototypeWindowCapture.ts. "YouTube" is prototype-only,
// "Screenshot" app-only.

async function identify(result: ObserveResult, args: Record<string, unknown>) {
  const screen = new FakeObserveScreen();
  screen.setObserveResult(result);
  const navigation = spyOn(NavigationGraphManager, "getInstance").mockReturnValue(
    new FakeNavigationGraphManager() as unknown as NavigationGraphManager,
  );
  try {
    registerObserveTools({
      timer: new FakeTimer(),
      createScreen: () => ({
        execute: screen.execute.bind(screen),
        executeDeviceRead: screen.execute.bind(screen),
        captureScreenshot: screen.captureScreenshot.bind(screen),
        appendRawViewHierarchy: screen.appendRawViewHierarchy.bind(screen),
        getMostRecentCachedObserveResult: screen.getMostRecentCachedObserveResult.bind(screen),
      }),
    });
    const tool = ToolRegistry.getTool("identifyInteractions")!;
    return await tool.deviceAwareHandler!(
      { deviceId: "identify-layer", name: "Fake", platform: "android" },
      { includeContext: { navigationGraph: false }, ...args },
    );
  } finally {
    navigation.mockRestore();
    ToolRegistry.clearTools();
  }
}

describe("identifyInteractions layer (#9305)", () => {
  // identifyInteractions is registered in debug mode only.
  let previousDebugMode = false;
  beforeAll(() => {
    previousDebugMode = isDebugModeEnabled();
    setDebugModeEnabled(true);
  });
  afterAll(() => setDebugModeEnabled(previousDebugMode));

  test("the schema accepts app and prototype only", () => {
    expect(
      identifyInteractionsSchema.safeParse({ platform: "android", layer: "app" }).success,
    ).toBe(true);
    expect(
      identifyInteractionsSchema.safeParse({ platform: "android", layer: "prototype" }).success,
    ).toBe(true);
    expect(
      identifyInteractionsSchema.safeParse({ platform: "android", layer: "both" }).success,
    ).toBe(false);
  });

  test("omitted layer identifies prototype and app interactions", async () => {
    const text = JSON.stringify(await identify(observationOf(capturedPrototypeHierarchy()), {}));
    expect(text).toContain("YouTube");
    expect(text).toContain("Screenshot");
  });

  test('"app" drops prototype interactions and leaves the cached observation intact', async () => {
    const result = observationOf(capturedPrototypeHierarchy());
    const text = JSON.stringify(await identify(result, { layer: "app" }));

    expect(text).not.toContain("YouTube");
    expect(text).toContain("Screenshot");
    expect(JSON.stringify(result.viewHierarchy)).toContain("YouTube");
  });

  test('"prototype" keeps prototype interactions only', async () => {
    const text = JSON.stringify(
      await identify(observationOf(capturedPrototypeHierarchy()), { layer: "prototype" }),
    );
    expect(text).toContain("YouTube");
    expect(text).not.toContain("Screenshot");
  });

  test('"prototype" with no prototype showing is an actionable error', async () => {
    await expect(
      identify(observationOf(capturedTwoWindowHierarchy()), { layer: "prototype" }),
    ).rejects.toThrow("no AutoMobile prototype is showing");
  });
});
