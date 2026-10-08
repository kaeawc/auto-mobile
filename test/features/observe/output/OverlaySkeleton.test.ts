import { describe, expect, test } from "bun:test";
import { scopeHierarchyToLayer } from "../../../../src/features/observe/hierarchyLayer";
import { projectSkeleton } from "../../../../src/features/observe/output/SkeletonProjection";
import type {
  ViewHierarchyNode,
  ViewHierarchyResult,
} from "../../../../src/models/ViewHierarchyResult";
import {
  OVERLAY_CAPTURE,
  capturedOverlayHierarchy,
  observationOf,
} from "../../../helpers/overlayWindowCapture";

// Captured Recents overview with window 252 relabelled as the CtrlProxy overlay (see
// test/helpers/overlayWindowCapture.ts). `fullScreen` widens that window to the screen, standing in
// for a fullscreen prototype overlay.

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

describe("app rows behind a fullscreen overlay (#10446)", () => {
  test("are occluded with no actions by default, and the overlay's own rows stay actionable", () => {
    const projection = project(capturedOverlayHierarchy({ fullScreen: true }));

    const calendar = find(projection, "Calendar");
    expect(calendar?.occluded).toBe(true);
    expect(calendar?.affordances).toEqual([]);
    expect(projection.context).toContain(calendar!);

    const phone = projection.skeleton.find((row) => row.label === "Phone");
    expect(phone?.affordances).toContain("tap");
    expect(phone?.occluded).toBeUndefined();
  });

  test('layer "app" shows them as ordinary actionable rows', () => {
    const hierarchy = capturedOverlayHierarchy({ fullScreen: true });
    const projection = project(scopeHierarchyToLayer(hierarchy, "app"));

    const calendar = projection.skeleton.find((row) => row.label === "Calendar");
    expect(calendar?.affordances).toContain("tap");
    expect(calendar?.occluded).toBeUndefined();
    expect(find(projection, "Phone")).toBeUndefined();
  });

  test("stay actionable when the overlay window does not span them", () => {
    const projection = project(capturedOverlayHierarchy());

    const calendar = projection.skeleton.find((row) => row.label === "Calendar");
    expect(calendar?.affordances).toContain("tap");
    expect(calendar?.occluded).toBeUndefined();
  });

  test("stay actionable when no overlay is present", () => {
    const hierarchy = capturedOverlayHierarchy({ fullScreen: true });
    hierarchy.windows = hierarchy.windows!.map((window) =>
      window.id === OVERLAY_CAPTURE.overlayWindowId
        ? { ...window, packageName: "com.other" }
        : window,
    );
    const projection = project(hierarchy);

    expect(projection.skeleton.find((row) => row.label === "Calendar")?.occluded).toBeUndefined();
  });
});

function overlayNode(hierarchy: ViewHierarchyResult, viewId: string): ViewHierarchyNode {
  const window = hierarchy.windows!.find((entry) => entry.id === OVERLAY_CAPTURE.overlayWindowId)!;
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

describe("icon-only tappable overlay containers (#10446)", () => {
  // The captured overlay window has no icon-only tappable container, so the captured clickable
  // "Apps list" node is relabelled as the overlay's kind label and given an icon child, the shape
  // the FAB has once #10524 stops labelling the icon child with its kind.
  const FAB_ID = "s2-157067aa28ca60b8";

  function withFab(kind: string, children: Array<{ desc: string }>) {
    const hierarchy = capturedOverlayHierarchy();
    const fab = overlayNode(hierarchy, FAB_ID) as Record<string, unknown>;
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
