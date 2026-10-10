import { describe, expect, test } from "bun:test";
import { scopeHierarchyToLayer } from "../../../../src/features/observe/hierarchyLayer";
import { projectSkeleton } from "../../../../src/features/observe/output/SkeletonProjection";
import type {
  ViewHierarchyNode,
  ViewHierarchyResult,
} from "../../../../src/models/ViewHierarchyResult";
import {
  RELABELLED_CAPTURE,
  capturedPrototypeHierarchy,
  observationOf,
} from "../../../helpers/prototypeWindowCapture";

// Captured Recents overview with window 252 relabelled as the CtrlProxy prototype (see
// test/helpers/prototypeWindowCapture.ts). `fullScreen` widens that window to the screen, standing in
// for a fullscreen prototype.

function project(hierarchy: ViewHierarchyResult) {
  const observation = observationOf(hierarchy);
  return projectSkeleton(observation.elements!, observation.screenSize, hierarchy);
}

function rows(projection: ReturnType<typeof project>) {
  return [...projection.skeleton, ...projection.context];
}

function find(projection: ReturnType<typeof project>, label: string) {
  return rows(projection).find((row) => row.label === label);
}

describe("app rows behind a fullscreen prototype (#10446)", () => {
  test("are occluded with no actions by default, and the prototype's own rows stay actionable", () => {
    const projection = project(capturedPrototypeHierarchy({ fullScreen: true }));

    const calendar = find(projection, "Calendar");
    expect(calendar?.occluded).toBe(true);
    expect(calendar?.affordances).toEqual([]);
    expect(projection.context).toContain(calendar!);

    const phone = projection.skeleton.find((row) => row.label === "Phone");
    expect(phone?.affordances).toContain("tap");
    expect(phone?.occluded).toBeUndefined();
  });

  test('layer "app" shows them as ordinary actionable rows', () => {
    const hierarchy = capturedPrototypeHierarchy({ fullScreen: true });
    const projection = project(scopeHierarchyToLayer(hierarchy, "app"));

    const calendar = projection.skeleton.find((row) => row.label === "Calendar");
    expect(calendar?.affordances).toContain("tap");
    expect(calendar?.occluded).toBeUndefined();
    expect(find(projection, "Phone")).toBeUndefined();
  });

  test("stay actionable when the prototype window does not span them", () => {
    const projection = project(capturedPrototypeHierarchy());

    const calendar = projection.skeleton.find((row) => row.label === "Calendar");
    expect(calendar?.affordances).toContain("tap");
    expect(calendar?.occluded).toBeUndefined();
  });

  test("stay actionable under the node-free non-touchable highlight overlay (#10446)", () => {
    const hierarchy = capturedPrototypeHierarchy();
    const prototype = hierarchy.windows!.find(
      (w) => w.id === RELABELLED_CAPTURE.prototypeWindowId,
    )!;
    hierarchy.windows!.push({
      ...prototype,
      id: 999,
      windowLayer: (prototype.windowLayer ?? 0) + 1,
      bounds: { ...RELABELLED_CAPTURE.screen },
      hierarchy: {},
    });
    const projection = project(hierarchy);

    const calendar = projection.skeleton.find((row) => row.label === "Calendar");
    expect(calendar?.affordances).toContain("tap");
    expect(calendar?.occluded).toBeUndefined();
  });

  // Owner decision 2026-10-08 (#10715) reverses #10615: the prototype is touchable within its
  // bounds whatever it paints, so a tap there lands in the prototype and tapOn refuses the row.
  for (const [name, prototypePlacement, prototypeOpaque] of [
    ["an opaque fullscreen", "fullscreen", true],
    ["a translucent fullscreen", "fullscreen", false],
    ["a sheet", "sheet", true],
    ["a floating", "floating", false],
  ] as const) {
    test(`are occluded under a bounds-spanning prototype the APK reports as ${name} window (#10715)`, () => {
      const projection = project(
        capturedPrototypeHierarchy({ fullScreen: true, prototypePlacement, prototypeOpaque }),
      );

      const calendar = find(projection, "Calendar");
      expect(calendar?.occluded).toBe(true);
      expect(calendar?.affordances).toEqual([]);
      expect(projection.skeleton.find((row) => row.label === "Phone")?.affordances).toContain(
        "tap",
      );
    });
  }

  test("follow the window bounds, not the reported placement, as tapOn does (#10715)", () => {
    // An opaque "fullscreen" report on a window that does not span the row: a tap on the row
    // reaches the app, so the row stays actionable.
    const projection = project(
      capturedPrototypeHierarchy({ prototypePlacement: "fullscreen", prototypeOpaque: true }),
    );

    const calendar = projection.skeleton.find((row) => row.label === "Calendar");
    expect(calendar?.affordances).toContain("tap");
    expect(calendar?.occluded).toBeUndefined();
  });

  test("stay actionable when no prototype is present", () => {
    const hierarchy = capturedPrototypeHierarchy({ fullScreen: true });
    hierarchy.windows = hierarchy.windows!.map((window) =>
      window.id === RELABELLED_CAPTURE.prototypeWindowId
        ? { ...window, packageName: "com.other" }
        : window,
    );
    const projection = project(hierarchy);

    expect(projection.skeleton.find((row) => row.label === "Calendar")?.occluded).toBeUndefined();
  });
});

function prototypeNode(hierarchy: ViewHierarchyResult, viewId: string): ViewHierarchyNode {
  const window = hierarchy.windows!.find(
    (entry) => entry.id === RELABELLED_CAPTURE.prototypeWindowId,
  )!;
  const found: ViewHierarchyNode[] = [];
  const visit = (node: ViewHierarchyNode) => {
    if ((node as { "view-id"?: string })["view-id"] === viewId) {
      found.push(node);
    }
    const children = node.node ? (Array.isArray(node.node) ? node.node : [node.node]) : [];
    children.forEach(visit);
  };
  visit(window.hierarchy!);
  return found[0];
}

describe("icon-only tappable prototype containers (#10446)", () => {
  // The captured prototype window has no icon-only tappable container, so the captured clickable
  // "Apps list" node is relabelled as the prototype's kind label and given an icon child, the shape
  // the FAB has once #10524 stops labelling the icon child with its kind.
  const FAB_ID = "s2-157067aa28ca60b8";

  function withFab(kind: string, children: Array<{ desc: string }>) {
    const hierarchy = capturedPrototypeHierarchy();
    const fab = prototypeNode(hierarchy, FAB_ID) as Record<string, unknown>;
    fab["content-desc"] = kind;
    fab.node = children.map(({ desc }) => ({
      "content-desc": desc,
      "visible-to-user": true,
      bounds: { ...(fab.bounds as object) },
    }));
    return hierarchy;
  }

  test("the icon name becomes the label instead of the kind", () => {
    const fab = rows(project(withFab("box", [{ desc: "add" }]))).find(
      (row) => row.elementId === FAB_ID,
    );
    expect(fab?.label).toBe("add");
    expect(fab?.sublabel).toBeUndefined();
    expect(fab?.affordances).toContain("tap");
  });

  test("a container with several accessible children keeps its kind and lists them", () => {
    const fab = rows(project(withFab("box", [{ desc: "add" }, { desc: "Compose" }]))).find(
      (row) => row.elementId === FAB_ID,
    );
    expect(fab?.label).toBe("box");
  });

  test("an authored label is never replaced", () => {
    const fab = rows(project(withFab("Create", [{ desc: "add" }]))).find(
      (row) => row.elementId === FAB_ID,
    );
    expect(fab?.label).toBe("Create");
    expect(fab?.sublabel).toBe("add");
  });
});
