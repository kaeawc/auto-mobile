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
import { FakeAndroidXrDetector } from "../../fakes/FakeAndroidXrDetector";

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

function setup(formFactor: BootedDevice["formFactor"] = "xr-headset", xr = formFactor !== "phone") {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const adb = new FakeAdbClient();
  const service = new FakeCtrlProxy(timer);
  service.setSupportsNodeActionSelectors(true);
  service.setActionResult({ success: true, action: "click", totalTimeMs: 1 });
  const tap = new TapOnElement(
    { name: "XR", platform: "android", deviceId: "fake-xr", formFactor },
    adb,
    { timer, xrDetector: new FakeAndroidXrDetector(xr) },
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
        expectedBounds: element.bounds,
      },
    ]);
    expect(service.getNodeActionHistory()[0]).toHaveProperty("allowInvisible", true);
    expect(service.getTapHistory()).toHaveLength(0);
    expect(adb.getAllCommands()).toHaveLength(0);
    expect(timer.getSleepHistory()).toEqual([]);
  });

  test("a visible node click omits the invisible opt in", async () => {
    const visibleHierarchy = structuredClone(hierarchy);
    const visibleLauncher = new SearchableHierarchy()
      .project(visibleHierarchy)
      .find((entry) => entry.label === "Open Launcher Panel")!;
    Object.assign(visibleLauncher.source, { "visible-to-user": true });
    const { tap, service } = setup();
    await tap.executeAndroidTap("tap", point, 0, {
      element: { ...element, "visible-to-user": true },
      isTalkBackEnabled: false,
      options: { action: "tap", resolvedHierarchy: visibleHierarchy },
    });
    expect(service.getNodeActionHistory()).toHaveLength(1);
    expect(service.getNodeActionHistory()[0]).not.toHaveProperty("allowInvisible");
  });

  for (const mode of [
    "unsupported",
    "bounds-unsupported",
    "node_bounds_mismatch",
    "node_bounds_ambiguous",
    "node_identity_mismatch",
    "thrown-identity-mismatch",
    "rejected",
    "xml",
    "doubleTap",
    "talkback",
    "transport",
    "unadvertised",
  ] as const) {
    test(`refuses unsafe XR fallback: ${mode}`, async () => {
      const { execute, service, adb } = setup();
      if (mode === "bounds-unsupported") {
        service.setSupportsNodeBoundsVerification(false);
      }
      if (
        mode === "node_bounds_mismatch" ||
        mode === "node_bounds_ambiguous" ||
        mode === "node_identity_mismatch"
      ) {
        service.setActionResult({
          success: false,
          action: "click",
          totalTimeMs: 1,
          error: `${mode}: selector verification refused`,
        });
      }
      if (mode === "unsupported") {
        service.setSupportsNodeActionSelectors(false);
      }
      if (mode === "rejected" || mode === "talkback") {
        service.setActionResult({ success: false, action: "click", totalTimeMs: 1 });
      }
      if (mode === "transport") {
        service.setFailureMode("requestNodeAction", new Error("Disconnected"));
      }
      if (mode === "thrown-identity-mismatch") {
        service.setFailureMode(
          "requestNodeAction",
          new Error("request failed: node_identity_mismatch: row changed"),
        );
      }
      const target =
        mode === "unadvertised"
          ? { ...element, actions: [] }
          : mode === "xml"
            ? { ...element, "hierarchy-source": "uiautomator" as const }
            : element;
      await expect(
        execute(target, mode === "doubleTap" ? "doubleTap" : "tap", mode === "talkback"),
      ).rejects.toThrow(/XR panel coordinate space.*not tappable screen coordinates.*tapAt/);
      if (mode === "bounds-unsupported") {
        expect(service.getNodeActionHistory()).toHaveLength(0);
      }
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
    "missing-class",
    "duplicate-bounds",
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
      // Keep the captured identity absent for bounds-only cases.
      if (!["captured-no-selector", "duplicate-bounds", "missing-class"].includes(mode)) {
        Object.assign(row.source, { "unique-id": "settings-connected-row" });
      }
      if (mode === "missing-class") {
        delete row.source.class;
        Reflect.deleteProperty(row.source, "className");
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
      if (mode === "duplicate-selector" || mode === "duplicate-bounds") {
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
      if (
        [
          "captured-no-selector",
          "missing-class",
          "unique-row",
          "text-frame",
          "nearest-ancestor",
        ].includes(mode)
      ) {
        await result;
        expect(service.getNodeActionHistory()[0]).not.toHaveProperty("allowInvisible");
        expect(service.getNodeActionHistory()).toMatchObject([
          {
            action: "click",
            expectedBounds: mode === "nearest-ancestor" ? current.frame.bounds : current.row.bounds,
            ...(mode === "captured-no-selector"
              ? {
                  identityHints: {
                    className: current.row.properties.class,
                    labelText: "Connected devices",
                  },
                }
              : {}),
            selector:
              mode === "captured-no-selector" || mode === "missing-class"
                ? undefined
                : mode === "nearest-ancestor"
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

  for (const mode of ["owner-outside-container", "owner-inside-container"] as const) {
    test(`container-scoped Settings ancestor click: ${mode}`, async () => {
      const tree: ViewHierarchyResult = { hierarchy: {}, ...structuredClone(settingsCapture) };
      const { nodes, label, frame, row } = settingsTarget(tree);
      // Scope to the label's own frame (its only clickable owner, the row, is outside
      // it) or to the list that contains the row. Resource ids keep the scope unambiguous.
      const elementId = `com.android.settings:id/${mode}`;
      const scope = mode === "owner-outside-container" ? frame : nodes[row.parentIndex!];
      Object.assign(scope.source, { "resource-id": elementId });
      const current = settingsTarget(tree);
      const { tap, service, adb } = setup();
      const result = tap.executeAndroidTap("tap", point, 0, {
        element: { ...current.label.properties, bounds: label.bounds! },
        isTalkBackEnabled: false,
        options: { action: "tap", resolvedHierarchy: tree, container: { elementId } },
      });
      if (mode === "owner-inside-container") {
        await result;
        expect(service.getNodeActionHistory()).toMatchObject([
          {
            action: "click",
            expectedBounds: current.row.bounds,
            selector: undefined,
            identityHints: {
              className: current.row.properties.class,
              labelText: "Connected devices",
            },
          },
        ]);
      } else {
        await expect(result).rejects.toThrow(
          /XR panel coordinate space.*not tappable screen coordinates.*tapAt/,
        );
        expect(service.getNodeActionHistory()).toHaveLength(0);
      }
      expect(service.getTapHistory()).toHaveLength(0);
      expect(adb.getAllCommands()).toHaveLength(0);
    });
  }

  for (const targetKind of ["row", "switch"] as const) {
    test(`clicks the captured Settings ${targetKind} by bounds alone`, async () => {
      const tree: ViewHierarchyResult = { hierarchy: {}, ...structuredClone(settingsCapture) };
      const { nodes, row } = settingsTarget(tree);
      const target =
        targetKind === "row"
          ? row
          : nodes.find(
              (entry) =>
                entry.properties["resource-id"] === "android:id/switch_widget" &&
                entry.bounds?.left === 1904 &&
                entry.bounds?.top === 729,
            )!;
      const { tap, service } = setup();
      await tap.executeAndroidTap("tap", point, 0, {
        element: { ...target.properties, bounds: target.bounds! },
        isTalkBackEnabled: false,
        options: { action: "tap", resolvedHierarchy: tree },
      });
      expect(service.getNodeActionHistory()).toMatchObject([
        {
          action: "click",
          selector: undefined,
          expectedBounds:
            targetKind === "row"
              ? { left: 48, top: 372, right: 696, bottom: 548 }
              : { left: 744, top: 718, right: 2048, bottom: 836 },
        },
      ]);
    });
  }

  test("bounds-only clicks send the captured node's own text and description", async () => {
    const tree: ViewHierarchyResult = { hierarchy: {}, ...structuredClone(settingsCapture) };
    const { label, row } = settingsTarget(tree);
    row.source.text = "Connected devices";
    row.source["content-desc"] = "Connections";
    // The clicked ancestor's own identity takes precedence over the tapped label.
    const { tap, service } = setup();
    await tap.executeAndroidTap("tap", point, 0, {
      element: { ...label.properties, bounds: label.bounds! },
      isTalkBackEnabled: false,
      options: { action: "tap", resolvedHierarchy: tree },
    });
    expect(service.getNodeActionHistory()[0]!.identityHints).toEqual({
      className: row.properties.class,
      text: "Connected devices",
      contentDesc: "Connections",
    });
  });

  test("a description-only label is sent for a textless clickable ancestor", async () => {
    const tree: ViewHierarchyResult = { hierarchy: {}, ...structuredClone(settingsCapture) };
    const { label, row } = settingsTarget(tree);
    delete label.source.text;
    label.source["content-desc"] = "Connections";
    const currentLabel = new SearchableHierarchy()
      .project(tree)
      .find((entry) => entry.source === label.source)!;
    const { tap, service } = setup();
    await tap.executeAndroidTap("tap", point, 0, {
      element: { ...currentLabel.properties, bounds: currentLabel.bounds! },
      isTalkBackEnabled: false,
      options: { action: "tap", resolvedHierarchy: tree },
    });
    expect(service.getNodeActionHistory()[0]!.identityHints).toEqual({
      className: row.properties.class,
      text: undefined,
      contentDesc: undefined,
      labelText: undefined,
      labelContentDesc: "Connections",
    });
  });

  // The extractor maps View, FrameLayout, ScrollView and TextView to a null class (#17853).
  function genericClassRow(tree: ViewHierarchyResult) {
    const { row } = settingsTarget(tree);
    delete row.source.class;
    Reflect.deleteProperty(row.source, "className");
    return row;
  }

  test("a generic-class FrameLayout row with text clicks without a class hint", async () => {
    const tree: ViewHierarchyResult = { hierarchy: {}, ...structuredClone(settingsCapture) };
    const row = genericClassRow(tree);
    row.source.text = "Connected devices row";
    const current = new SearchableHierarchy()
      .project(tree)
      .find((entry) => entry.source === row.source)!;
    const { tap, service, adb } = setup();
    await tap.executeAndroidTap("tap", point, 0, {
      element: { ...current.properties, bounds: current.bounds! },
      isTalkBackEnabled: false,
      options: { action: "tap", resolvedHierarchy: tree },
    });
    const [request] = service.getNodeActionHistory();
    expect(request).toMatchObject({ selector: undefined, expectedBounds: current.bounds });
    expect(request!.identityHints).toEqual({ text: "Connected devices row" });
    expect(service.getTapHistory()).toHaveLength(0);
    expect(adb.getAllCommands()).toHaveLength(0);
  });

  test("a generic-class View row with only a label descendant clicks by its label", async () => {
    const tree: ViewHierarchyResult = { hierarchy: {}, ...structuredClone(settingsCapture) };
    genericClassRow(tree);
    const current = settingsTarget(tree);
    const { tap, service } = setup();
    await tap.executeAndroidTap("tap", point, 0, {
      element: { ...current.label.properties, bounds: current.label.bounds! },
      isTalkBackEnabled: false,
      options: { action: "tap", resolvedHierarchy: tree },
    });
    const [request] = service.getNodeActionHistory();
    expect(request).toMatchObject({ selector: undefined, expectedBounds: current.row.bounds });
    expect(request!.identityHints).toEqual({ labelText: "Connected devices" });
    expect(service.getTapHistory()).toHaveLength(0);
  });

  test("a generic-class node with no identity hints still refuses", async () => {
    const tree: ViewHierarchyResult = { hierarchy: {}, ...structuredClone(settingsCapture) };
    const row = genericClassRow(tree);
    delete row.source.text;
    delete row.source["content-desc"];
    // Descendant labels now supply identity for a promoted Compose owner.
    delete row.source.node;
    const current = new SearchableHierarchy()
      .project(tree)
      .find((entry) => entry.source === row.source)!;
    const { tap, service, adb } = setup();
    await expect(
      tap.executeAndroidTap("tap", point, 0, {
        element: { ...current.properties, bounds: current.bounds! },
        isTalkBackEnabled: false,
        options: { action: "tap", resolvedHierarchy: tree },
      }),
    ).rejects.toThrow(/XR panel coordinate space.*tapAt/);
    expect(service.getNodeActionHistory()).toHaveLength(0);
    expect(service.getTapHistory()).toHaveLength(0);
    expect(adb.getAllCommands()).toHaveLength(0);
  });

  test("a runner requiring a selector preserves XR coordinate guidance", async () => {
    const tree: ViewHierarchyResult = { hierarchy: {}, ...structuredClone(settingsCapture) };
    const { row } = settingsTarget(tree);
    const { tap, service } = setup();
    service.setActionResult({
      success: false,
      action: "click",
      totalTimeMs: 1,
      error: "A resource-id or stable node selector is required for accessibility actions",
    });
    await expect(
      tap.executeAndroidTap("tap", point, 0, {
        element: { ...row.properties, bounds: row.bounds! },
        isTalkBackEnabled: false,
        options: { action: "tap", resolvedHierarchy: tree },
      }),
    ).rejects.toThrow(/XR panel coordinate space.*tapAt/);
    expect(service.getNodeActionHistory()).toHaveLength(1);
    expect(service.getNodeActionHistory()[0]!.selector).toBeUndefined();
    expect(service.getTapHistory()).toHaveLength(0);
  });

  test("guards the direct coordinate dispatch seam on XR too", async () => {
    const { tap, service, adb } = setup();
    await expect(
      tap.executeAndroidTapWithCoordinates("tap", 1052, 1961, 0, element),
    ).rejects.toThrow(/XR panel coordinate space.*tapAt/);
    expect(service.getTapHistory()).toHaveLength(0);
    expect(adb.getAllCommands()).toHaveLength(0);
  });

  test("routes by the shared XR predicate, not the provisional form factor (#17811)", async () => {
    // A headset whose ro.build.characteristics lacks "xr" still declares the spatial feature.
    const headset = setup("phone", true);
    await headset.execute();
    expect(headset.service.getNodeActionHistory()).toHaveLength(1);
    expect(headset.service.getTapHistory()).toHaveLength(0);
    // An xr-headset form factor without the spatial feature keeps the coordinate tap.
    const phone = setup("xr-headset", false);
    await phone.execute();
    expect(phone.service.getNodeActionHistory()).toHaveLength(0);
    expect(phone.service.getTapHistory()).toHaveLength(1);
  });

  test("keeps coordinate taps for the same captured element on a phone", async () => {
    const { execute, service, adb } = setup("phone");
    await execute();
    expect(service.getNodeActionHistory()).toHaveLength(0);
    expect(service.getTapHistory()).toHaveLength(1);
    expect(adb.getAllCommands()).toHaveLength(0);
  });
});
