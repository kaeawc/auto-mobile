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
  capturedPrototypeHierarchy,
  capturedTwoWindowHierarchy,
  observationOf,
} from "../helpers/prototypeWindowCapture";

isolateToolRegistry();

// Captured Recents overview with its floating window relabelled as the CtrlProxy
// prototype; see test/helpers/prototypeWindowCapture.ts. "YouTube" is prototype-only.

async function observe(
  result: ObserveResult,
  args: Record<string, unknown>,
  options: { hidesPrototype?: boolean; screen?: FakeObserveScreen } = {},
) {
  const screen = options.screen ?? new FakeObserveScreen();
  screen.setObserveResult(result);
  const notify = spyOn(ResourceRegistry, "notifyResourcesUpdated").mockResolvedValue(undefined);
  try {
    registerObserveTools({
      hidesPrototypeForScreenshot: async () => options.hidesPrototype ?? false,
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
      { deviceId: "observe-layer", name: "Fake", platform: "android" },
      tool.schema.parse({ screenshot: "none", ...args }),
    );
  } finally {
    notify.mockRestore();
    ToolRegistry.clearTools();
  }
}

describe("observe layer (#9305)", () => {
  test("the schema accepts app and prototype only", () => {
    expect(observeSchema.safeParse({ platform: "android", layer: "app" }).success).toBe(true);
    expect(observeSchema.safeParse({ platform: "android", layer: "prototype" }).success).toBe(true);
    expect(observeSchema.safeParse({ platform: "android", layer: "both" }).success).toBe(false);
  });

  test("omitted layer serves prototype and app nodes", async () => {
    const response = await observe(observationOf(capturedPrototypeHierarchy()), {});
    expect(JSON.stringify(response)).toContain("YouTube");
  });

  test('"app" serves the app without prototype nodes and leaves the observation intact', async () => {
    const result = observationOf(capturedPrototypeHierarchy());
    const response = await observe(result, { layer: "app" });

    expect(JSON.stringify(response)).not.toContain("YouTube");
    expect(JSON.stringify(response)).toContain("Screenshot");
    expect(JSON.stringify(result.viewHierarchy)).toContain("YouTube");
  });

  test('"prototype" with no prototype showing is an actionable error', async () => {
    await expect(
      observe(observationOf(capturedTwoWindowHierarchy()), { layer: "prototype" }),
    ).rejects.toThrow("no AutoMobile prototype is showing");
  });
});

describe("observe waitFor with layer (#9305)", () => {
  const waitFor = async (layer: WaitForWithSettled["layer"]) => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const screen = new FakeObserveScreen();
    screen.setObserveResult((index) => {
      const viewHierarchy = capturedPrototypeHierarchy();
      viewHierarchy.updatedAt = (index + 1) * 10;
      return observationOf(viewHierarchy);
    });
    return waitForObservation(
      screen,
      { text: "YouTube", timeout: 300, layer } satisfies WaitForWithSettled,
      undefined,
      false,
      timer,
    );
  };

  test("a prototype-only element matches by default and for prototype", async () => {
    expect((await waitFor(undefined)).matched).toBe(true);
    expect((await waitFor("prototype")).matched).toBe(true);
  });

  test('a prototype-only element never matches for "app"', async () => {
    const outcome = await waitFor("app");
    expect(outcome.matched).toBe(false);
    expect(outcome.awaitTimeout).toBe(true);
  });

  test.each([
    [undefined, true],
    ["prototype", true],
    ["app", false],
  ] as const)("the DSL appear predicate with layer %p matches=%p", async (layer, matched) => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const screen = new FakeObserveScreen();
    screen.setObserveResult((index) => {
      const viewHierarchy = capturedPrototypeHierarchy();
      viewHierarchy.updatedAt = (index + 1) * 10;
      return observationOf(viewHierarchy);
    });
    const outcome = await waitForObservation(
      screen,
      { for: "appear", text: "YouTube", timeout: 300, layer } satisfies WaitForWithSettled,
      undefined,
      false,
      timer,
    );
    expect(outcome.matched).toBe(matched);
  });
});

describe("observe layer screenshot (#9305)", () => {
  const withScreenshot = (result: ObserveResult): ObserveResult => ({
    ...result,
    screenshotCaptureAttempted: true,
    screenshotPath: "/tmp/observe-layer.png",
  });

  const structured = (response: unknown): Record<string, unknown> =>
    (response as { structuredContent: Record<string, unknown> }).structuredContent;

  test('"app" with a prototype showing marks the screenshot as including the prototype', async () => {
    const response = await observe(withScreenshot(observationOf(capturedPrototypeHierarchy())), {
      layer: "app",
    });
    expect(structured(response).screenshotIncludesPrototype).toBe(true);
  });

  test.each([
    ["no layer", observationOf(capturedPrototypeHierarchy()), {}],
    ['"prototype"', observationOf(capturedPrototypeHierarchy()), { layer: "prototype" }],
    [
      '"app" with no prototype showing',
      observationOf(capturedTwoWindowHierarchy()),
      { layer: "app" },
    ],
  ] as const)("%s leaves the screenshot unmarked", async (_, result, args) => {
    const response = await observe(withScreenshot(result), args);
    expect(structured(response).screenshotIncludesPrototype).toBeUndefined();
  });

  test('"app" without a screenshot leaves the result unmarked', async () => {
    const response = await observe(observationOf(capturedPrototypeHierarchy()), { layer: "app" });
    expect(structured(response).screenshotIncludesPrototype).toBeUndefined();
  });
});

describe("observe layer screenshot with device-side prototype hiding (#9305)", () => {
  const structured = (response: unknown): Record<string, unknown> =>
    (response as { structuredContent: Record<string, unknown> }).structuredContent;

  // The capture marks the observation when it is requested with the prototype hidden.
  const capturedHidden = (result: ObserveResult): ObserveResult => ({
    ...result,
    screenshotCaptureAttempted: true,
    screenshotPath: "/tmp/observe-layer-hidden.png",
    screenshotIncludesPrototype: false,
  });

  test('"app" asks the capture to hide the prototype when the device can', async () => {
    const screen = new FakeObserveScreen();
    await observe(
      observationOf(capturedPrototypeHierarchy()),
      { layer: "app", screenshot: "async" },
      { hidesPrototype: true, screen },
    );
    expect(screen.getExecuteOptions()[0]?.screenshotOptions).toEqual({ hidePrototypes: true });
  });

  test("keeps the caller's encoding alongside the hide request", async () => {
    const screen = new FakeObserveScreen();
    await observe(
      observationOf(capturedPrototypeHierarchy()),
      { layer: "app", screenshot: "settled", screenshotOptions: { format: "jpeg", quality: 70 } },
      { hidesPrototype: true, screen },
    );
    expect(screen.getExecuteOptions()[0]?.screenshotOptions).toEqual({
      format: "jpeg",
      quality: 70,
      hidePrototypes: true,
    });
  });

  test.each([
    ["the device cannot hide", { layer: "app", screenshot: "async" }, false],
    ["no layer", { screenshot: "async" }, true],
    ['"prototype"', { layer: "prototype", screenshot: "async" }, true],
    ['screenshot "none"', { layer: "app", screenshot: "none" }, true],
  ] as const)("does not ask to hide when %s", async (_, args, hidesPrototype) => {
    const screen = new FakeObserveScreen();
    await observe(observationOf(capturedPrototypeHierarchy()), args, { hidesPrototype, screen });
    expect(screen.getExecuteOptions()[0]?.screenshotOptions?.hidePrototypes).toBeUndefined();
  });

  test('"app" reports a screenshot captured with the prototype hidden as excluding it', async () => {
    const response = await observe(
      capturedHidden(observationOf(capturedPrototypeHierarchy())),
      { layer: "app" },
      { hidesPrototype: true },
    );
    expect(structured(response).screenshotIncludesPrototype).toBe(false);
  });

  test('"app" with no prototype showing leaves a hidden capture unmarked', async () => {
    const response = await observe(
      capturedHidden(observationOf(capturedTwoWindowHierarchy())),
      { layer: "app" },
      { hidesPrototype: true },
    );
    expect(structured(response).screenshotIncludesPrototype).toBeUndefined();
  });
});
