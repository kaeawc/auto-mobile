import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TapOnElement } from "../../../src/features/action/TapOnElement";
import { SearchableHierarchy } from "../../../src/features/utility/SearchableNode";
import type {
  BootedDevice,
  Element,
  ViewHierarchyNode,
  ViewHierarchyResult,
} from "../../../src/models";
import { FakeAdbClient } from "../../fakes/FakeAdbClient";
import { FakeCtrlProxy } from "../../fakes/FakeCtrlProxy";
import { FakeTimer } from "../../fakes/FakeTimer";

// Preserve the captured trees, including the panel-space bounds and already-pruned Settings roots.
const capture: {
  screenSize: { width: number; height: number };
  windows: { id: number; hierarchy?: ViewHierarchyNode }[];
} = JSON.parse(
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
const entries = new SearchableHierarchy().project(hierarchy);
const launcher = entries.find((entry) => entry.label === "Open Launcher Panel")!;
const element: Element = { ...launcher.properties, bounds: launcher.bounds! };
const point = {
  x: (launcher.bounds!.left + launcher.bounds!.right) / 2,
  y: (launcher.bounds!.top + launcher.bounds!.bottom) / 2,
};

// Verbatim Settings windows from the post-occlusion-fix observe project:full capture.
const settingsCapture: Pick<ViewHierarchyResult, "windows"> = JSON.parse(
  readFileSync(
    join(import.meta.dir, "../../fixtures/android-xr/observe-settings-panel-children.json"),
    "utf8",
  ),
);

function settingsTarget(tree: ViewHierarchyResult) {
  const nodes = new SearchableHierarchy().project(tree);
  const label = nodes.find((entry) => entry.properties.text === "Connected devices")!;
  const frame = nodes[label.parentIndex!];
  const row = nodes[frame.parentIndex!];
  return { nodes, label, frame, row };
}

function setup(formFactor: BootedDevice["formFactor"] = "xr-headset") {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const adb = new FakeAdbClient();
  const service = new FakeCtrlProxy(timer);
  service.setSupportsNodeActionSelectors(true);
  service.setActionResult({ success: true, action: "click", totalTimeMs: 1 });
  const tap = new TapOnElement(
    { name: "XR", platform: "android", deviceId: "fake-xr", formFactor },
    adb,
    { timer },
  );
  Object.assign(tap, { accessibilityService: service });
  const execute = (target = element, action: "tap" | "doubleTap" = "tap", talkBack = false) =>
    tap.executeAndroidTap(action, point, 0, {
      element: target,
      isTalkBackEnabled: talkBack,
      options: { action, resolvedHierarchy: hierarchy },
    });
  return { execute, tap, service, adb, timer };
}

describe("XR panel-space tap routing", () => {
  test("uses the captured launcher node's ACTION_CLICK without a screen gesture", async () => {
    const { execute, service, adb, timer } = setup();
    await execute();
    expect(service.getNodeActionHistory()).toMatchObject([
      {
        action: "click",
        selector: { resourceId: "com.android.systemui:id/home_screen_launcher_button" },
      },
    ]);
    expect(service.getTapHistory()).toHaveLength(0);
    expect(adb.getAllCommands()).toHaveLength(0);
    expect(timer.getSleepHistory()).toEqual([]);
  });

  for (const mode of [
    "unsupported",
    "rejected",
    "missing-selector",
    "xml",
    "doubleTap",
    "talkback",
    "transport",
    "unadvertised",
  ] as const) {
    test(`refuses unsafe XR fallback: ${mode}`, async () => {
      const { execute, service, adb } = setup();
      if (mode === "unsupported") {
        service.setSupportsNodeActionSelectors(false);
      }
      if (mode === "rejected" || mode === "talkback") {
        service.setActionResult({ success: false, action: "click", totalTimeMs: 1 });
      }
      if (mode === "transport") {
        service.setFailureMode("requestNodeAction", new Error("Disconnected"));
      }
      const target =
        mode === "unadvertised"
          ? { ...element, actions: [] }
          : mode === "missing-selector"
            ? { ...element, "resource-id": undefined }
            : mode === "xml"
              ? { ...element, "hierarchy-source": "uiautomator" as const }
              : element;
      await expect(
        execute(target, mode === "doubleTap" ? "doubleTap" : "tap", mode === "talkback"),
      ).rejects.toThrow(/XR panel coordinate space.*not tappable screen coordinates.*tapAt/);
      expect(service.getTapHistory()).toHaveLength(0);
      expect(adb.getAllCommands()).toHaveLength(0);
    });
  }

  for (const id of [38, 39]) {
    test(`refuses the captured bare Settings panel ${id} instead of tapping its hierarchy centre`, async () => {
      const root = capture.windows.find((window) => window.id === id)!.hierarchy!;
      const panelHierarchy: ViewHierarchyResult = { hierarchy: { node: root } };
      const panel = new SearchableHierarchy().project(panelHierarchy)[0];
      const { execute, service, adb } = setup();
      await expect(execute({ ...panel.properties, bounds: panel.bounds! })).rejects.toThrow(
        /XR panel coordinate space.*tapAt/,
      );
      expect(service.getTapHistory()).toHaveLength(0);
      expect(adb.getAllCommands()).toHaveLength(0);
    });
  }

  test("refuses a duplicate native selector across captured windows", async () => {
    const { tap, service } = setup();
    await expect(
      tap.executeAndroidTap("tap", point, 0, {
        element,
        isTalkBackEnabled: false,
        options: {
          action: "tap",
          resolvedHierarchy: {
            hierarchy: {
              node: {
                node: [hierarchy.hierarchy.node!, structuredClone(hierarchy.hierarchy.node!)],
              },
            },
          },
        },
      }),
    ).rejects.toThrow(/XR panel coordinate space/);
    expect(service.getNodeActionHistory()).toHaveLength(0);
    expect(service.getTapHistory()).toHaveLength(0);
  });

  for (const mode of [
    "captured-no-selector",
    "unique-row",
    "text-frame",
    "no-clickable-ancestor",
    "duplicate-selector",
    "non-containing-row",
    "other-window",
    "nearest-ancestor",
    "rejected-ancestor",
  ] as const) {
    test(`Settings ancestor click: ${mode}`, async () => {
      const tree: ViewHierarchyResult = { hierarchy: {}, ...structuredClone(settingsCapture) };
      const { label, frame, row } = settingsTarget(tree);
      expect(label.properties.actions).not.toContain("click");
      expect(row.properties.actions).toContain("click");
      expect(row.properties.clickable).toBe("true");
      // The capture's clickable row has no stable native identity. Positive cases
      // deliberately add one to a copy; never change the captured fixture.
      if (mode !== "captured-no-selector") {
        Object.assign(row.source, { "unique-id": "settings-connected-row" });
      }
      if (mode === "no-clickable-ancestor") {
        row.source.actions = [];
      }
      if (mode === "non-containing-row") {
        row.source.bounds = { left: 0, top: 0, right: 1, bottom: 1 };
      }
      if (mode === "nearest-ancestor") {
        Object.assign(frame.source, { "unique-id": "settings-connected-frame" });
        frame.source.actions = ["click"];
      }
      if (mode === "duplicate-selector") {
        tree.windows!.push({
          id: 998,
          hierarchy: { ...structuredClone(row.source), node: undefined },
        });
      }

      if (mode === "other-window") {
        // A containing clickable sibling/window must never be treated as a parent.
        tree.windows!.push({
          id: 999,
          hierarchy: { ...structuredClone(row.source), node: undefined },
        });
        row.source.actions = [];
      }
      const current = settingsTarget(tree);
      const target = mode === "text-frame" ? current.frame : current.label;
      const { tap, service, adb } = setup();
      if (mode === "rejected-ancestor") {
        service.setActionResult({ success: false, action: "click", totalTimeMs: 1 });
      }
      const result = tap.executeAndroidTap("tap", point, 0, {
        element: { ...target.properties, bounds: target.bounds! },
        isTalkBackEnabled: false,
        options: { action: "tap", resolvedHierarchy: tree },
      });
      if (["unique-row", "text-frame", "nearest-ancestor"].includes(mode)) {
        await result;
        expect(service.getNodeActionHistory()).toMatchObject([
          {
            action: "click",
            selector:
              mode === "nearest-ancestor"
                ? { uniqueId: "settings-connected-frame" }
                : { uniqueId: "settings-connected-row", collectionRow: 1, collectionColumn: 0 },
          },
        ]);
      } else {
        await expect(result).rejects.toThrow(/XR panel coordinate space/);
        if (mode !== "rejected-ancestor") {
          expect(service.getNodeActionHistory()).toHaveLength(0);
        }
      }
      expect(service.getTapHistory()).toHaveLength(0);
      expect(adb.getAllCommands()).toHaveLength(0);
    });
  }

  test("guards the direct coordinate dispatch seam on XR too", async () => {
    const { tap, service, adb } = setup();
    await expect(
      tap.executeAndroidTapWithCoordinates("tap", 1052, 1961, 0, element),
    ).rejects.toThrow(/XR panel coordinate space.*tapAt/);
    expect(service.getTapHistory()).toHaveLength(0);
    expect(adb.getAllCommands()).toHaveLength(0);
  });

  test("keeps coordinate taps for the same captured element on a phone", async () => {
    const { execute, service, adb } = setup("phone");
    await execute();
    expect(service.getNodeActionHistory()).toHaveLength(0);
    expect(service.getTapHistory()).toHaveLength(1);
    expect(adb.getAllCommands()).toHaveLength(0);
  });
});
