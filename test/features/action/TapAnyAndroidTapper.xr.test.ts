import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  TapAnyAndroidTapper,
  type CapturedTapTarget,
} from "../../../src/features/action/TapAnyAndroidTapper";
import { identifyObservedHierarchy } from "../../../src/features/observe/HierarchyCapture";
import { SearchableHierarchy } from "../../../src/features/utility/SearchableNode";
import type { Element, ViewHierarchyNode, ViewHierarchyResult } from "../../../src/models";
import { hierarchyFingerprint } from "../../../src/utils/hierarchyFingerprint";
import { FakeAccessibilityDetector } from "../../fakes/FakeAccessibilityDetector";
import { FakeAdbClient } from "../../fakes/FakeAdbClient";
import { FakeAndroidXrDetector } from "../../fakes/FakeAndroidXrDetector";
import { FakeCtrlProxy } from "../../fakes/FakeCtrlProxy";
import { FakeTalkBackTapStrategy } from "../../fakes/FakeTalkBackTapStrategy";
import { FakeTimer } from "../../fakes/FakeTimer";

// Verbatim XR headset capture; the launcher button's bounds are panel-space, not screen pixels.
const capture: { windows: { hierarchy?: ViewHierarchyNode }[] } = JSON.parse(
  readFileSync(
    join(import.meta.dir, "../../fixtures/android-xr/observe-settings-panel-windows.json"),
    "utf8",
  ),
);
const hierarchy: ViewHierarchyResult = {
  hierarchy: {
    node: {
      node: capture.windows.flatMap((window) => (window.hierarchy ? [window.hierarchy] : [])),
    },
  },
};
const launcher = new SearchableHierarchy()
  .project(hierarchy)
  .find((entry) => entry.label === "Open Launcher Panel")!;
const element: Element = { ...launcher.properties, bounds: launcher.bounds! };
const point = {
  x: (launcher.bounds!.left + launcher.bounds!.right) / 2,
  y: (launcher.bounds!.top + launcher.bounds!.bottom) / 2,
};

// Verbatim Settings panel windows; its "Connected devices" label has a clickable row ancestor.
const settingsCapture: Pick<ViewHierarchyResult, "windows"> = JSON.parse(
  readFileSync(
    join(import.meta.dir, "../../fixtures/android-xr/observe-settings-panel-children.json"),
    "utf8",
  ),
);

function setup(xr: boolean, resolveContainer: () => Element | undefined = () => undefined) {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const adb = new FakeAdbClient();
  const service = new FakeCtrlProxy(timer);
  service.setSupportsNodeActionSelectors(true);
  service.setActionResult({ success: true, action: "click", totalTimeMs: 1 });
  let refreshes = 0;
  const tapper = new TapAnyAndroidTapper({
    device: { name: "XR", platform: "android", deviceId: "fake-xr" },
    timer,
    getAdb: () => adb,
    accessibilityService: service,
    accessibilityDetector: new FakeAccessibilityDetector(),
    featureFlags: { isEnabled: () => false },
    talkBackStrategy: new FakeTalkBackTapStrategy(),
    talkBackDriverFactory: {
      createDriver: () => {
        throw new Error("TalkBack is off in these tests");
      },
    },
    isAndroidXr: (signal) =>
      new FakeAndroidXrDetector(xr).isAndroidXr({
        adb,
        device: { deviceId: "fake-xr", platform: "android" },
        signal,
      }),
    resolveContainer,
    beforeTap: () => {},
    refreshViewHierarchy: async () => {
      refreshes++;
      return hierarchy;
    },
    findClickableElement: () => ({ element, containerFound: true }),
    resolveTapPoint: () => point,
  });
  const target = (): CapturedTapTarget => ({
    element,
    talkBackState: false,
    capture: identifyObservedHierarchy("android", hierarchy, "fresh", { timer }),
  });
  return { tapper, service, adb, target, refreshes: () => refreshes };
}

describe("tapAny on Android XR (#17811)", () => {
  test("clicks the accessibility node instead of sending panel-space coordinates", async () => {
    const { tapper, service, adb, target } = setup(true);
    await tapper.executeAndroidTap("tap", point, 0, { target: target() });
    expect(service.getNodeActionHistory()).toMatchObject([
      {
        action: "click",
        selector: { resourceId: "com.android.systemui:id/home_screen_launcher_button" },
      },
    ]);
    expect(service.getTapHistory()).toHaveLength(0);
    expect(adb.getAllCommands()).toHaveLength(0);
  });

  test("refuses a doubleTap the same way tapOn does", async () => {
    const { tapper, service, adb, target } = setup(true);
    await expect(
      tapper.executeAndroidTap("doubleTap", point, 0, { target: target() }),
    ).rejects.toThrow(/XR panel coordinate space.*tapAt/);
    expect(service.getNodeActionHistory()).toHaveLength(0);
    expect(service.getTapHistory()).toHaveLength(0);
    expect(adb.getAllCommands()).toHaveLength(0);
  });

  test("skips the ghost-tap retry so an unchanged hierarchy never re-clicks the node", async () => {
    const { tapper, service, target, refreshes } = setup(true);
    await tapper.retryAndroidTapIfNoChange(hierarchyFingerprint(hierarchy), target(), "tap", {
      durationMs: 0,
    });
    expect(refreshes()).toBe(0);
    expect(service.getNodeActionHistory()).toHaveLength(0);
    expect(service.getTapHistory()).toHaveLength(0);
  });

  test("keeps the coordinate tap and its retry on a non-XR device", async () => {
    const { tapper, service, target, refreshes } = setup(false);
    await tapper.executeAndroidTap("tap", point, 0, { target: target() });
    expect(service.getNodeActionHistory()).toHaveLength(0);
    expect(service.getTapHistory()).toHaveLength(1);
    await tapper.retryAndroidTapIfNoChange(hierarchyFingerprint(hierarchy), target(), "tap", {
      durationMs: 0,
    });
    expect(refreshes()).toBeGreaterThan(0);
    expect(service.getTapHistory()).toHaveLength(2);
  });

  for (const scope of ["outside-container", "inside-container"] as const) {
    test(`a container-scoped XR click never promotes past the container: ${scope}`, async () => {
      const tree: ViewHierarchyResult = { hierarchy: {}, ...structuredClone(settingsCapture) };
      const nodes = new SearchableHierarchy().project(tree);
      const label = nodes.find((entry) => entry.properties.text === "Connected devices")!;
      const frame = nodes[label.parentIndex!];
      const row = nodes[frame.parentIndex!];
      // The captured row has no stable native identity; give a copy one (never the fixture).
      Object.assign(row.source, { "unique-id": "settings-connected-row" });
      const scoped = new SearchableHierarchy().project(tree);
      const at = (entry: (typeof scoped)[number]) => ({
        ...entry.properties,
        bounds: entry.bounds!,
      });
      const container =
        scope === "outside-container"
          ? at(scoped[nodes.indexOf(frame)])
          : at(scoped[row.parentIndex!]);
      const { tapper, service } = setup(true, () => container);
      const result = tapper.executeAndroidTap("tap", point, 0, {
        target: {
          element: at(scoped[nodes.indexOf(label)]),
          talkBackState: false,
          scoped: true,
          container: { elementId: "scope" },
          capture: identifyObservedHierarchy("android", tree, "fresh", { timer: new FakeTimer() }),
        },
      });
      if (scope === "outside-container") {
        await expect(result).rejects.toThrow(/XR panel coordinate space/);
        expect(service.getNodeActionHistory()).toHaveLength(0);
      } else {
        await result;
        expect(service.getNodeActionHistory()).toMatchObject([
          { action: "click", selector: { uniqueId: "settings-connected-row" } },
        ]);
      }
      expect(service.getTapHistory()).toHaveLength(0);
    });
  }
});
