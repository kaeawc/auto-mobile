import { describe, expect, test } from "bun:test";
import {
  findTemplateHostBackTarget,
  isCarAppTemplateHost,
  retryBackOnTemplateHost,
  type TemplateHostBackContext,
  type TemplateHostBackTapClient,
} from "../../../src/features/action/carAppTemplateBack";
import type { ObservedChangeOptions } from "../../../src/features/action/observedInteractionTypes";
import type { ObserveResult, PressButtonResult } from "../../../src/models";
import type { TapCoordinatesRequest } from "../../../src/utils/interfaces/TapCoordinatesRequest";
import { carAppTemplateObservation } from "../../helpers/carAppTemplateFixtures";

const OPTIONS: ObservedChangeOptions = { changeExpected: true };

class RecordingTapClient implements TemplateHostBackTapClient {
  readonly taps: Array<{ x: number; y: number }> = [];
  constructor(private readonly reply: { success: boolean; error?: string } = { success: true }) {}
  async requestTapCoordinates(request: TapCoordinatesRequest) {
    this.taps.push({ x: request.x, y: request.y });
    return { ...this.reply, totalTimeMs: 0 };
  }
}

/** Runs the block against the post-tap observation, as `observedInteraction` would after a change. */
function fakeObservedInteraction(after: ObserveResult) {
  const calls: ObservedChangeOptions[] = [];
  return {
    calls,
    run: async (
      block: (observation: ObserveResult) => Promise<PressButtonResult>,
      options: ObservedChangeOptions,
    ) => {
      calls.push(options);
      return { ...(await block(after)), observation: after };
    },
  };
}

function noChange(observation: ObserveResult): PressButtonResult & { observation: ObserveResult } {
  return {
    success: false,
    button: "back",
    keyCode: 4,
    error: "No visual change observed",
    observation,
  };
}

function backContext(prePress: ObserveResult): TemplateHostBackContext {
  return { platform: "android", button: "back", pressSucceeded: true, prePress, options: OPTIONS };
}

describe("isCarAppTemplateHost (#17498)", () => {
  test.each(["menu", "list", "grid", "pane", "navigation-place-list", "list-driving"] as const)(
    "%s capture is a template host",
    (name) => {
      expect(isCarAppTemplateHost(carAppTemplateObservation(name))).toBe(true);
    },
  );

  test("templates-host nodes alone mark a template host", () => {
    const observation = carAppTemplateObservation("pane", { activityName: "OtherActivity" });
    expect(isCarAppTemplateHost(observation)).toBe(true);
  });

  test("a regular activity with no host nodes is not", () => {
    const observation: ObserveResult = {
      ...carAppTemplateObservation("pane", { activityName: ".MainActivity" }),
      viewHierarchy: { hierarchy: { node: { "resource-id": "com.example:id/root" } } },
    };
    expect(isCarAppTemplateHost(observation)).toBe(false);
    expect(isCarAppTemplateHost(undefined)).toBe(false);
  });
});

describe("findTemplateHostBackTarget (#17498)", () => {
  test.each(["list", "grid", "pane", "list-driving"] as const)(
    "%s taps the labelled toolbar Back",
    (name) => {
      expect(findTemplateHostBackTarget(carAppTemplateObservation(name).viewHierarchy)).toEqual({
        affordance: "toolbar_nav_icon",
        resourceId:
          "com.google.android.apps.automotive.templates.host:id/car_ui_toolbar_nav_icon_container",
        x: 56,
        y: 124,
      });
    },
  );

  test("navigation place list taps the unlabelled primary header action", () => {
    const observation = carAppTemplateObservation("navigation-place-list");
    expect(findTemplateHostBackTarget(observation.viewHierarchy)).toEqual({
      affordance: "primary_header_action",
      resourceId: "com.google.android.apps.automotive.templates.host:id/primary_header_action",
      x: 56,
      y: 132,
    });
  });

  test("root menu has no Back affordance", () => {
    expect(findTemplateHostBackTarget(carAppTemplateObservation("menu").viewHierarchy)).toBe(
      undefined,
    );
  });
});

describe("retryBackOnTemplateHost (#17498)", () => {
  test.each([
    ["navigation-place-list", "primary_header_action", { x: 56, y: 132 }],
    ["pane", "toolbar_nav_icon", { x: 56, y: 124 }],
  ] as const)("no-op BACK on %s taps %s", async (name, affordance, point) => {
    const before = carAppTemplateObservation(name);
    const tapClient = new RecordingTapClient();
    const observed = fakeObservedInteraction(carAppTemplateObservation("menu", { updatedAt: 2 }));
    const result = await retryBackOnTemplateHost(noChange(before), backContext(before), {
      tapClient: () => tapClient,
      observedInteraction: observed.run,
    });
    expect(tapClient.taps).toEqual([point]);
    expect(observed.calls).toEqual([{ changeExpected: true }]);
    expect(result).toMatchObject({ success: true, button: "back", keyCode: 4 });
    expect(result.backFallback).toBe(affordance);
    expect(result.error).toBeUndefined();
  });

  test("a failed tap is reported with the affordance it tried", async () => {
    const before = carAppTemplateObservation("pane");
    const tapClient = new RecordingTapClient({ success: false, error: "gesture rejected" });
    const observed = fakeObservedInteraction(before);
    const result = await retryBackOnTemplateHost(noChange(before), backContext(before), {
      tapClient: () => tapClient,
      observedInteraction: observed.run,
    });
    expect(result.success).toBe(false);
    expect(result.backFallback).toBe("toolbar_nav_icon");
    expect(result.error).toContain("car_ui_toolbar_nav_icon_container");
    expect(result.error).toContain("gesture rejected");
  });

  const pane = carAppTemplateObservation("pane");
  const menu = carAppTemplateObservation("menu");
  const offHost: ObserveResult = {
    ...carAppTemplateObservation("pane", { activityName: ".MainActivity" }),
    viewHierarchy: { hierarchy: { node: { "resource-id": "com.example:id/root" } } },
  };
  test.each([
    ["off the templates host", noChange(offHost), backContext(offHost)],
    ["on a root template", noChange(menu), backContext(menu)],
    ["on iOS", noChange(pane), { ...backContext(pane), platform: "ios" }],
    ["for home", noChange(pane), { ...backContext(pane), button: "home" }],
    ["when dispatch failed", noChange(pane), { ...backContext(pane), pressSucceeded: false }],
    [
      "for another failure",
      { ...noChange(pane), error: "Button press outcome is indeterminate" },
      backContext(pane),
    ],
    [
      "after a visible change",
      { ...noChange(pane), success: true, error: undefined },
      backContext(pane),
    ],
  ])("leaves the result alone %s", async (_label, result, context) => {
    const tapClient = new RecordingTapClient();
    const observed = fakeObservedInteraction(pane);
    const returned = await retryBackOnTemplateHost(result, context, {
      tapClient: () => tapClient,
      observedInteraction: observed.run,
    });
    expect(returned).toBe(result);
    expect(tapClient.taps).toEqual([]);
    expect(observed.calls).toEqual([]);
  });
});
