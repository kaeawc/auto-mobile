import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import type { ObserveResult, ViewHierarchyResult } from "../../../src/models";
import { ResolverElementSelector } from "../../../src/features/utility/ResolverElementSelector";
import { TapOnElement } from "../../../src/features/action/TapOnElement";
import { FakeAdbClient } from "../../fakes/FakeAdbClient";
import { FakeTimer } from "../../fakes/FakeTimer";
import { isolatedTapStrategy } from "../../helpers/observedInteractionStub";

/**
 * Captured Settings radio list: each clickable row holds an `android:id/checkbox` RadioButton.
 * `tapOn ensureChecked` resolves the row's own radio, so the activated element lies inside the
 * matched row rather than containing it (#18351).
 */
const capture: ObserveResult = JSON.parse(
  readFileSync(
    new URL(
      "../../fixtures/android-settings/open-by-default-radio-rows.observe.json",
      import.meta.url,
    ),
    "utf8",
  ),
);

const CONTAINMENT_WARNING = "does not contain the matched element";

/** The capture with the "In your browser" row's radio set to `selected`, in every window copy. */
function hierarchyWithBrowserRadioChecked(): ViewHierarchyResult {
  const hierarchy = structuredClone(capture.viewHierarchy as ViewHierarchyResult);
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (typeof value !== "object" || value === null) {
      return;
    }
    const node = value as Record<string, unknown>;
    const bounds = node.bounds;
    if (
      node["resource-id"] === "android:id/checkbox" &&
      Array.isArray(bounds) &&
      bounds[1] === 1244
    ) {
      node.checked = "true";
      node["state-description"] = "selected";
    }
    Object.values(node).forEach(visit);
  };
  visit(hierarchy);
  return hierarchy;
}

function createTap(flips: boolean): { tap: TapOnElement; taps: () => number } {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const adb = new FakeAdbClient();
  adb.isScreenOn = async () => true;
  const tap = new TapOnElement(
    { name: "test-device", platform: "android", deviceId: "emulator-5554" },
    adb,
    {
      timer,
      elementSelector: new ResolverElementSelector(),
      tapStrategy: isolatedTapStrategy(),
      selectionStateTracker: { prepare: async () => null, finalize: async () => [] },
    },
  );
  const before = capture.viewHierarchy as ViewHierarchyResult;
  const after = flips ? hierarchyWithBrowserRadioChecked() : before;
  let tapCalls = 0;
  tap.executeAndroidTap = async () => {
    tapCalls++;
  };
  tap.prepareSelectionCapture = async () => null;
  tap.refreshViewHierarchy = async () => (tapCalls > 0 ? after : before);
  tap.testHooks.setTerminalScreenshotCapture(async () => {});
  tap.testHooks.setDeferredPredictionRecorder(async () => {});
  tap.deriveTapEffectAfterPostTapObservation = async (_previous, current) => ({
    effect: { screenChanged: true, basis: "viewHierarchy changed" },
    observation: current,
  });
  tap.observedInteraction = (async (block: (observation: ObserveResult) => Promise<unknown>) => {
    const result = (await block({ ...capture, viewHierarchy: before })) as object;
    return { ...result, observation: { ...capture, viewHierarchy: after } };
  }) as TapOnElement["observedInteraction"];
  return { tap, taps: () => tapCalls };
}

describe("tapOn ensureChecked on a radio inside its list row (#18351)", () => {
  test("a verified flip of the matched row omits the containment warning", async () => {
    const { tap, taps } = createTap(true);

    const result = await tap.execute({
      text: "In your browser",
      action: "tap",
      ensureChecked: true,
      exactText: true,
    });

    expect(result.success).toBe(true);
    expect(taps()).toBe(1);
    expect(result.element).toMatchObject({ "resource-id": "android:id/checkbox" });
    expect(result.warnings ?? []).not.toContainEqual(expect.stringContaining(CONTAINMENT_WARNING));
  });

  test("an unverified flip still reports the containment warning", async () => {
    const { tap } = createTap(false);

    const result = await tap.execute({
      text: "In your browser",
      action: "tap",
      ensureChecked: true,
      exactText: true,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("checked is now false");
    expect(result.warnings).toContainEqual(expect.stringContaining(CONTAINMENT_WARNING));
  });
});
