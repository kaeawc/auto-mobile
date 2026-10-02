import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { NavigationGraphManager } from "../../src/features/navigation/NavigationGraphManager";
import { IdentifyInteractions } from "../../src/features/observe/IdentifyInteractions";
import { ActionableError, type BootedDevice, type ObserveResult } from "../../src/models";
import { registerObserveTools } from "../../src/server/observeTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { isDebugModeEnabled, setDebugModeEnabled } from "../../src/utils/debug";
import { FakeNavigationGraphManager } from "../fakes/FakeNavigationGraphManager";
import { FakeObserveScreen } from "../fakes/FakeObserveScreen";
import { FakeTimer } from "../fakes/FakeTimer";

const device: BootedDevice = {
  deviceId: "interactions-freshness",
  name: "Fake",
  platform: "android",
};

describe("identifyInteractions cached freshness", () => {
  let screen: FakeObserveScreen;
  let timer: FakeTimer;
  let navigation: ReturnType<typeof spyOn<typeof NavigationGraphManager, "getInstance">>;
  let previousDebugMode: boolean;
  let analyze: ReturnType<typeof spyOn<IdentifyInteractions, "analyze">>;

  function observation(text: string, freshness?: ObserveResult["freshness"]): ObserveResult {
    return {
      timestamp: timer.now(),
      screenSize: { width: 1080, height: 1920 },
      systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
      viewHierarchy: {
        hierarchy: {
          node: {
            $: {
              class: "android.widget.Button",
              clickable: "true",
              text,
              "resource-id": text,
              bounds: { left: 10, top: 10, right: 200, bottom: 60 },
            },
          },
        },
      },
      freshness,
    };
  }

  function call() {
    return ToolRegistry.getTool("identifyInteractions")!.deviceAwareHandler!(device, {
      includeContext: { navigationGraph: false },
    });
  }

  async function parsedResult() {
    const response = await call();
    const content = response.content[0];
    if (content.type !== "text") {
      throw new Error("Expected JSON text response");
    }
    return JSON.parse(content.text);
  }

  beforeEach(() => {
    previousDebugMode = isDebugModeEnabled();
    setDebugModeEnabled(true);
    // Freshness only reads the current screen; avoid unrelated database migrations.
    navigation = spyOn(NavigationGraphManager, "getInstance").mockReturnValue(
      new FakeNavigationGraphManager() as unknown as NavigationGraphManager,
    );
    timer = new FakeTimer();
    screen = new FakeObserveScreen();
    analyze = spyOn(IdentifyInteractions.prototype, "analyze");
    registerObserveTools({
      timer,
      createScreen: () => ({
        execute: screen.execute.bind(screen),
        executeDeviceRead: () => screen.execute(),
        captureScreenshot: screen.captureScreenshot.bind(screen),
        appendRawViewHierarchy: screen.appendRawViewHierarchy.bind(screen),
        getMostRecentCachedObserveResult: screen.getMostRecentCachedObserveResult.bind(screen),
      }),
    });
  });

  afterEach(() => {
    analyze.mockRestore();
    ToolRegistry.clearTools();
    setDebugModeEnabled(previousDebugMode);
    timer.reset();
    navigation.mockRestore();
  });

  test("refetches stale usable cache exactly once and analyzes fresh elements", async () => {
    const cached = observation("StaleOnly", {
      isFresh: false,
      ageMs: 120000,
      category: "cache_age",
    });
    timer.advanceTime(120000);
    const fresh = observation("FreshOnly", { isFresh: true });
    screen.setObserveSequence([cached, fresh]);

    const result = await parsedResult();

    expect(result.success).toBe(true);
    expect(
      result.interactions.map(
        (interaction: { element: { text: string } }) => interaction.element.text,
      ),
    ).toEqual(["FreshOnly"]);
    expect(analyze.mock.calls[0][0]).toBe(fresh);
    expect(screen.getExecuteOptions()).toEqual([{ freshness: "fresh" }]);
    expect(screen.getGetMostRecentCachedObserveResultCallCount()).toBe(1);
  });

  test("analyzes fresh cache without executing observe", async () => {
    const cached = observation("CachedOnly", { isFresh: true });
    screen.setObserveResult(cached);

    const result = await parsedResult();

    expect(result.interactions[0].element.text).toBe("CachedOnly");
    expect(analyze.mock.calls[0][0]).toBe(cached);
    expect(screen.getExecuteCallCount()).toBe(0);
  });

  test("preserves the cache-only no-observation response", async () => {
    const cached = observation("Unavailable", { isFresh: false });
    cached.viewHierarchy = null;
    screen.setObserveResult(cached);

    const result = await parsedResult();

    expect(result.success).toBe(false);
    expect(result.error).toBe(
      "No observation available. Call the 'observe' tool first to capture screen state.",
    );
    expect(result.interactions).toEqual([]);
    expect(screen.getExecuteCallCount()).toBe(0);
  });

  test("preserves errored cache behavior without executing observe", async () => {
    const cached = observation("Unavailable", { isFresh: false });
    cached.viewHierarchy = { hierarchy: { error: "cache unavailable" } };
    screen.setObserveResult(cached);

    const result = await parsedResult();

    expect(result.interactions).toEqual([]);
    expect(analyze.mock.calls[0][0]).toBe(cached);
    expect(screen.getExecuteCallCount()).toBe(0);
  });

  for (const failure of ["throws", "missing hierarchy", "errored hierarchy"]) {
    test(`failed stale refetch (${failure}) rejects without analyzing stale cache`, async () => {
      const cached = observation("StaleOnly", { isFresh: false });
      const unavailable = observation("FreshOnly", { isFresh: true });
      unavailable.viewHierarchy =
        failure === "errored hierarchy" ? { hierarchy: { error: "capture failed" } } : null;
      screen.setObserveSequence([cached, unavailable]);
      const cause = new Error("capture failed");
      if (failure === "throws") {
        screen.setFailureMode("execute", cause);
      }

      const result = call();

      await expect(result).rejects.toBeInstanceOf(ActionableError);
      await expect(result).rejects.toThrow("Unable to observe screen to identify interactions.");
      if (failure === "throws") {
        await expect(result).rejects.toHaveProperty("cause", cause);
      }
      expect(analyze).not.toHaveBeenCalled();
      expect(screen.getExecuteOptions()).toEqual([{ freshness: "fresh" }]);
    });
  }
});
