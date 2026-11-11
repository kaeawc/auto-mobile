import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TapOnElement } from "../../../src/features/action/TapOnElement";
import {
  settleUnconfirmedXrClick,
  xrCoordinateError,
} from "../../../src/features/action/xrPanelNodeClick";
import { recordObservationRead } from "../../../src/features/observe/observationReadScope";
import type { A11yActionResult } from "../../../src/features/observe/android/types";
import { SearchableHierarchy } from "../../../src/features/utility/SearchableNode";
import type { ObserveResult, TapEffect, ViewHierarchyResult } from "../../../src/models";
import { DEFAULT_VISION_CONFIG } from "../../../src/vision";
import { FakeAdbClient } from "../../fakes/FakeAdbClient";
import { FakeAndroidXrDetector } from "../../fakes/FakeAndroidXrDetector";
import { FakeCtrlProxy } from "../../fakes/FakeCtrlProxy";
import { FakeTimer } from "../../fakes/FakeTimer";
import { runBlockWithEnvelope } from "../../helpers/observedInteractionStub";
import { buildObserveResult } from "../../helpers/observeFixture";

const fixtureDir = join(import.meta.dir, "../../fixtures/android-xr");

// Verbatim from the headset: the failed tapOn, the observes around it and CtrlProxy's logcat.
const issue: {
  tapOnStorage: { ms: number; payload: { success: boolean; error: string } };
  observeBefore: Pick<ObserveResult, "activeWindow" | "screenSize">;
  observeAfter: Pick<ObserveResult, "activeWindow">;
  ctrlProxyLogcat: string[];
} = JSON.parse(
  readFileSync(join(fixtureDir, "tapon-storage-unconfirmed-click-17983.json"), "utf8"),
);

// Verbatim Settings windows (same homepage panel the issue tapped).
const settingsCapture: Pick<ViewHierarchyResult, "windows"> = JSON.parse(
  readFileSync(join(fixtureDir, "observe-settings-panel-children.json"), "utf8"),
);

const CLIENT_ACTION_TIMEOUT_MS = 5000;

/** What the client reports when CtrlProxy's `action_result` outlives the 5 s request timeout. */
const lateReply: A11yActionResult = {
  success: false,
  action: "click",
  totalTimeMs: CLIENT_ACTION_TIMEOUT_MS,
  error: `Action timeout after ${CLIENT_ACTION_TIMEOUT_MS}ms`,
  dispatched: true,
  acknowledged: false,
};

function settingsTree(): ViewHierarchyResult {
  const tree: ViewHierarchyResult = { hierarchy: {}, ...structuredClone(settingsCapture) };
  const nodes = new SearchableHierarchy().project(tree);
  const label = nodes.find((entry) => entry.properties.text === "Connected devices")!;
  const row = nodes[nodes[label.parentIndex!].parentIndex!];
  Object.assign(row.source, { "unique-id": "settings-connected-row" });
  return tree;
}

function labelOf(tree: ViewHierarchyResult) {
  const label = new SearchableHierarchy()
    .project(tree)
    .find((entry) => entry.properties.text === "Connected devices")!;
  return { ...label.properties, bounds: label.bounds! };
}

function setup(reply: A11yActionResult) {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const adb = new FakeAdbClient();
  const service = new FakeCtrlProxy(timer);
  service.setSupportsNodeActionSelectors(true);
  service.setActionResult(reply);
  const tap = new TapOnElement(
    { name: "XR", platform: "android", deviceId: "fake-xr", formFactor: "xr-headset" },
    adb,
    {
      timer,
      xrDetector: new FakeAndroidXrDetector(true),
      visionConfig: { ...DEFAULT_VISION_CONFIG, enabled: false },
    },
  );
  Object.assign(tap, { accessibilityService: service });
  return { tap, service, adb };
}

function executeDirect(
  tap: TapOnElement,
  tree: ViewHierarchyResult,
  onUnconfirmedClick?: (reason: string) => void,
) {
  return tap.executeAndroidTap("tap", { x: 0, y: 0 }, 0, {
    element: labelOf(tree),
    isTalkBackEnabled: false,
    options: { action: "tap", resolvedHierarchy: tree, onUnconfirmedClick },
  });
}

describe("XR node click whose CtrlProxy reply is lost (#17983)", () => {
  test("the captured run is a landed click reported as the coordinate refusal", () => {
    const sent = issue.ctrlProxyLogcat.findIndex((line) =>
      line.includes("performAction: action='click'"),
    );
    expect(sent).toBeGreaterThanOrEqual(0);
    expect(issue.ctrlProxyLogcat[sent + 1]).toContain("Action completed: success=true");
    expect(issue.observeBefore.activeWindow?.activityName).toBe(
      "com.android.settings.homepage.SettingsHomepageActivity",
    );
    expect(issue.observeAfter.activeWindow?.activityName).toBe("com.android.settings.SubSettings");
    expect(issue.tapOnStorage.payload.success).toBe(false);
    expect(issue.tapOnStorage.payload.error).toContain(xrCoordinateError().message);
    // The whole call outlived the client's action timeout.
    expect(issue.tapOnStorage.ms).toBeGreaterThan(CLIENT_ACTION_TIMEOUT_MS);
  });

  test("hands an unconfirmed dispatched click to the caller instead of refusing it", async () => {
    const tree = settingsTree();
    const { tap, service, adb } = setup(lateReply);
    const reasons: string[] = [];
    await executeDirect(tap, tree, (reason) => reasons.push(reason));
    expect(reasons).toEqual([lateReply.error!]);
    expect(service.getNodeActionHistory()).toHaveLength(1);
    expect(service.getTapHistory()).toHaveLength(0);
    expect(adb.getAllCommands()).toHaveLength(0);
  });

  test("without a caller check, an unconfirmed click fails as unconfirmed, not the refusal", async () => {
    const tree = settingsTree();
    const { tap, service } = setup(lateReply);
    const result = executeDirect(tap, tree);
    await expect(result).rejects.toThrow(/not confirmed.*Do not retry automatically/);
    await expect(result).rejects.not.toThrow(/XR panel coordinate space/);
    expect(service.getNodeActionHistory()).toHaveLength(1);
  });

  for (const [name, reply] of [
    [
      "an acknowledged refusal",
      { ...lateReply, error: "node_identity_mismatch: row changed", acknowledged: true },
    ],
    ["a click that was never sent", { ...lateReply, dispatched: false }],
    ["a reply without delivery evidence", { success: false, action: "click", totalTimeMs: 1 }],
  ] as const) {
    test(`still refuses ${name} as the coordinate error`, async () => {
      const tree = settingsTree();
      const { tap } = setup(reply);
      const reasons: string[] = [];
      await expect(executeDirect(tap, tree, (reason) => reasons.push(reason))).rejects.toThrow(
        /XR panel coordinate space/,
      );
      expect(reasons).toEqual([]);
    });
  }
});

describe("settleUnconfirmedXrClick", () => {
  const reason = lateReply.error!;
  const changed: TapEffect = { screenChanged: true, basis: "activeWindow changed" };
  const unchanged: TapEffect = { screenChanged: false, basis: "viewHierarchy unchanged" };

  test("a changed screen reports the click as landed with a warning", () => {
    const result: Parameters<typeof settleUnconfirmedXrClick>[0] = {
      success: true,
      effect: changed,
    };
    settleUnconfirmedXrClick(result, reason);
    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.warnings).toEqual([
      expect.stringMatching(/did not confirm.*Action timeout.*screen changed.*activeWindow/),
    ]);
  });

  for (const [name, effect] of [
    ["an unchanged screen", unchanged],
    ["a missing effect", undefined],
  ] as const) {
    test(`${name} fails as unconfirmed without inviting a retry`, () => {
      const result: Parameters<typeof settleUnconfirmedXrClick>[0] = {
        success: true,
        effect,
        warnings: ["unrelated"],
      };
      settleUnconfirmedXrClick(result, reason);
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/not confirmed \(Action timeout.*Do not retry automatically/);
      expect(result.error).not.toContain("XR panel coordinate space");
      expect(result.warnings).toBeUndefined();
    });
  }

  test("leaves a confirmed click untouched", () => {
    const result: Parameters<typeof settleUnconfirmedXrClick>[0] = {
      success: true,
      effect: unchanged,
    };
    settleUnconfirmedXrClick(result, undefined);
    expect(result).toEqual({ success: true, effect: unchanged });
  });

  test("leaves an already failed result untouched", () => {
    const result: Parameters<typeof settleUnconfirmedXrClick>[0] = {
      success: false,
      error: "earlier",
    };
    settleUnconfirmedXrClick(result, reason);
    expect(result).toEqual({ success: false, error: "earlier" });
  });
});

describe("tapOn on the XR headset after a late CtrlProxy reply", () => {
  function run(after: Pick<ObserveResult, "activeWindow">) {
    const tree = settingsTree();
    const { tap, service } = setup(lateReply);
    const before = buildObserveResult({
      updatedAt: 0,
      systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
      viewHierarchy: tree,
      screenSize: issue.observeBefore.screenSize,
      activeWindow: issue.observeBefore.activeWindow,
    });
    const post = buildObserveResult({
      ...before,
      updatedAt: 1,
      activeWindow: after.activeWindow,
    });
    tap.observedInteraction = runBlockWithEnvelope(() => recordObservationRead(before), {
      observation: post,
    });
    tap.refreshViewHierarchy = async () => tree;
    // The post-tap effect compares the fresh observation with the pre-tap one.
    tap.deriveTapEffectAfterPostTapObservation = async (previous, current) => ({
      effect:
        previous?.activeWindow?.activityName === current.activeWindow?.activityName
          ? { screenChanged: false, basis: "activeWindow unchanged" }
          : { screenChanged: true, basis: "activeWindow changed" },
      observation: current,
    });
    const result = tap.execute({
      action: "tap",
      text: "Connected devices",
      searchUntil: { duration: 100 },
    });
    return { result, service };
  }

  test("reports success when the fresh observation shows the click landed", async () => {
    const { result, service } = run(issue.observeAfter);
    const outcome = await result;
    expect(outcome.success).toBe(true);
    expect(outcome.error).toBeUndefined();
    expect(outcome.warnings).toEqual([expect.stringMatching(/did not confirm.*screen changed/)]);
    expect(service.getNodeActionHistory()).toHaveLength(1);
    expect(service.getTapHistory()).toHaveLength(0);
  });

  test("fails as unconfirmed, not the coordinate refusal, when nothing changed", async () => {
    const { result, service } = run(issue.observeBefore);
    const outcome = await result;
    expect(outcome.success).toBe(false);
    expect(outcome.error).toMatch(/not confirmed.*Do not retry automatically/);
    expect(outcome.error).not.toContain("XR panel coordinate space");
    expect(service.getNodeActionHistory()).toHaveLength(1);
  });
});
