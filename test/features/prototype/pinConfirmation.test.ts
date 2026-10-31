import { describe, expect, test } from "bun:test";
import {
  confirmPinDialog,
  findPinConfirmButton,
  savedAdbDependencies,
  type PinConfirmationDriver,
} from "../../../src/features/prototype/pinConfirmation";
import { SearchableHierarchy } from "../../../src/features/utility/SearchableNode";
import type { ViewHierarchyResult } from "../../../src/models";
import { FakeHierarchyCapture } from "../../fakes/FakeHierarchyCapture";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { capturedLauncherHierarchy } from "../../helpers/capturedLauncherHierarchy";
import { refreshLauncherForShortcut } from "../../../src/features/prototype/launcherRefresh";

const searchable = new SearchableHierarchy();
const api37 = await capturedLauncherHierarchy(
  "android-pin-dialog/pin-dialog-api37-issue12261-uiautomator.xml",
);
const api33 = await capturedLauncherHierarchy(
  "android-pin-dialog/pin-dialog-api33-uiautomator.xml",
);
const api30 = await capturedLauncherHierarchy(
  "android-pin-dialog/pin-dialog-api30-launcher3-uiautomator.xml",
);
const home = await capturedLauncherHierarchy("android-launcher-home/api34-page2-uiautomator.xml");

for (const [api, tree, label, x, y] of [
  [37, api37, "Add to home screen", 783, 2233],
  [33, api33, "Add to home screen", 831, 2253],
  [30, api30, "ADD AUTOMATICALLY", 746, 1529],
] as const) {
  describe(`captured API ${api} pin dialog`, () => {
    test("selects accept, never Cancel or the API 30 title", () => {
      expect(findPinConfirmButton(searchable.project(tree))).toEqual({
        kind: "found",
        label,
        x,
        y,
      });
    });
    test("taps the captured accept centre once", async () => {
      const d = driver([tree]);
      expect(await confirmPinDialog(d.value)).toEqual({ status: "tapped", label });
      expect(d.taps).toEqual([[x, y]]);
      expect(d.timer.getSleepHistory()).toEqual([]);
    });
    test("never chooses Cancel when accept is unavailable", () => {
      const cancel = searchable
        .project(tree)
        .filter((node) => node.properties.text?.toLowerCase() === "cancel");
      expect(findPinConfirmButton(cancel)).toEqual({
        kind: "unrecognized",
        visibleButtons: [api === 30 ? "CANCEL" : "Cancel"],
      });
    });
  });
}

function driver(trees: ViewHierarchyResult[], failTap = false) {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const taps: Array<[number, number]> = [];
  let reads = 0;
  const capture = new FakeHierarchyCapture(
    () => trees[Math.min(reads++, trees.length - 1)],
    "android",
    timer,
  );
  const value: PinConfirmationDriver = {
    capture,
    timer,
    tapAt: async (x, y) => {
      if (failTap) {
        throw new Error("no input");
      }
      taps.push([x, y]);
    },
  };
  return { value, taps, timer };
}

describe("confirmPinDialog", () => {
  test("waits for the captured dialog, then taps once", async () => {
    const d = driver([home, api37]);
    expect(await confirmPinDialog(d.value)).toEqual({
      status: "tapped",
      label: "Add to home screen",
    });
    expect(d.taps).toEqual([[783, 2233]]);
    expect(d.timer.getSleepHistory()).toEqual([250]);
  });
  test("times out on the injected timer when no dialog appears", async () => {
    const d = driver([home]);
    expect(await confirmPinDialog(d.value, { timeoutMs: 1000, pollMs: 250 })).toEqual({
      status: "timeout",
    });
    expect(d.taps).toEqual([]);
    expect(d.timer.getSleepHistory()).toEqual([250, 250, 250, 250]);
  });
  test("a failed tap is reported", async () => {
    const d = driver([api37], true);
    expect(await confirmPinDialog(d.value)).toEqual({ status: "tap_failed", error: "no input" });
  });
});

describe("savedAdbDependencies workspace driver", () => {
  function dependencies(tree: ViewHierarchyResult = home) {
    const adb = new FakeAdbExecutor();
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const deps = {
      adbFactory: new FakeAdbClientFactory(adb),
      timer,
      anchorHierarchyCaptureFactory: () => new FakeHierarchyCapture(() => tree, "android", timer),
    };
    const device = { deviceId: "captured-home", platform: "android" as const, name: "Fake" };
    return {
      adb,
      value: savedAdbDependencies(device, deps),
      second: () => savedAdbDependencies(device, deps),
    };
  }

  test("uses captured root coordinates and noRetry for the right-to-left swipe", async () => {
    const d = dependencies();
    const snapshot = await d.value.launcherRefresh.capture.capture({ freshness: "fresh" });
    const bounds = snapshot.nodes[0].bounds!;
    await d.value.launcherRefresh.swipeWorkspaceToNextPage(bounds);
    expect(d.adb.getCommandCalls()).toMatchObject([
      { command: "shell input swipe 864 1200 216 1200 300", noRetry: true },
    ]);
  });

  test("shares device ownership across independently constructed drivers", () => {
    const d = dependencies();
    const first = d.value.launcherRefresh;
    const second = d.second().launcherRefresh;
    const release = first.gate.tryAcquire(first.deviceKey);
    expect(release).toBeDefined();
    try {
      expect(second.gate.tryAcquire(second.deviceKey)).toBeUndefined();
    } finally {
      release?.();
    }
    const again = second.gate.tryAcquire(second.deviceKey);
    expect(again).toBeDefined();
    again?.();
  });

  test("skips workspace swipes without captured root bounds", async () => {
    const d = dependencies({ hierarchy: {} });
    await refreshLauncherForShortcut(d.value.launcherRefresh, { label: "Missing" });
    expect(d.adb.getCommandCalls().some((call) => call.command.includes("input swipe"))).toBe(
      false,
    );
  });
});
