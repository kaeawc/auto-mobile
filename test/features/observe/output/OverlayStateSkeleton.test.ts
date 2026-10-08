import { beforeAll, describe, expect, test } from "bun:test";
import { DefaultElementParser } from "../../../../src/features/utility/ElementParser";
import { projectSkeleton } from "../../../../src/features/observe/output/SkeletonProjection";
import type { ViewHierarchyResult } from "../../../../src/models/ViewHierarchyResult";
import {
  PROTOTYPE_CAPTURE,
  capturedAppLayerOverlayHierarchy,
  observationOf,
} from "../../../helpers/overlayWindowCapture";

// The captured prototype overlay (test/fixtures/android-overlay-window/, window 174) carries no
// selected tab or pager yet, so each test stamps `selected` / `state-description` onto captured
// nodes -- the overlay's "bump" node and the Playground's own app node -- the way CtrlProxy reports
// them for a Compose Tab or pager.

function stamp(
  hierarchy: ViewHierarchyResult,
  windowId: number,
  resourceIdOrText: string,
  fields: Record<string, string>,
): void {
  const window = hierarchy.windows!.find((w) => w.id === windowId)!;
  let found = false;
  new DefaultElementParser().traverseNode(window.hierarchy!, (node) => {
    if (node["resource-id"] === resourceIdOrText || node.text === resourceIdOrText) {
      Object.assign(node, fields);
      found = true;
    }
  });
  expect(found).toBe(true);
}

function project(hierarchy: ViewHierarchyResult) {
  const observation = observationOf(hierarchy);
  const projection = projectSkeleton(observation.elements!, observation.screenSize, hierarchy);
  return [...projection.skeleton, ...projection.context];
}

function firstAppResourceId(hierarchy: ViewHierarchyResult): string {
  const window = hierarchy.windows!.find((w) => w.id === PROTOTYPE_CAPTURE.appWindowId)!;
  let id: string | undefined;
  new DefaultElementParser().traverseNode(window.hierarchy!, (node) => {
    const resourceId = node["resource-id"];
    if (id === undefined && typeof resourceId === "string" && node.clickable === "true") {
      id = resourceId;
    }
  });
  return id!;
}

let captured: ViewHierarchyResult;
beforeAll(() => {
  captured = capturedAppLayerOverlayHierarchy();
  project(captured); // warm the projection path outside the per-test budget
});

/** A fresh copy of the converted capture, safe to stamp. */
function fresh(): ViewHierarchyResult {
  return structuredClone(captured);
}

describe("overlay node state in the skeleton (#10446)", () => {
  test("an overlay row reports selected and its state description", () => {
    const hierarchy = fresh();
    stamp(hierarchy, PROTOTYPE_CAPTURE.appLayerOverlayWindowId, "bump", {
      selected: "true",
      "state-description": "Page 2 of 4",
    });

    const row = project(hierarchy).find((r) => r.elementId === "bump");
    expect(row?.selected).toBe(true);
    expect(row?.state).toBe("Page 2 of 4");
    expect(row?.label).toBe("Bump");
  });

  test("an unselected overlay row reports neither", () => {
    const row = project(fresh()).find((r) => r.elementId === "bump");
    expect(row).toBeDefined();
    expect(row).not.toHaveProperty("selected");
    expect(row).not.toHaveProperty("state");
  });

  test("a label-only overlay row keeps its state description in context", () => {
    const hierarchy = fresh();
    stamp(hierarchy, PROTOTYPE_CAPTURE.appLayerOverlayWindowId, "Persisted 0", {
      "state-description": "Page 1 of 3",
    });

    const row = project(hierarchy).find((r) => r.state === "Page 1 of 3");
    expect(row?.affordances).toEqual([]);
    expect(row?.label).toBe("Persisted 0");
  });

  test("an app row with the same fields is unchanged", () => {
    const hierarchy = fresh();
    const appId = firstAppResourceId(hierarchy);
    stamp(hierarchy, PROTOTYPE_CAPTURE.appWindowId, appId, {
      selected: "true",
      "state-description": "Page 2 of 4",
    });

    const row = project(hierarchy).find((r) => r.elementId === appId);
    expect(row).toBeDefined();
    expect(row).not.toHaveProperty("selected");
    expect(row).not.toHaveProperty("state");
  });
});
