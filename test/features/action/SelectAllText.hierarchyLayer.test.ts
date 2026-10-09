import { describe, expect, test } from "bun:test";
import { SelectAllText } from "../../../src/features/action/SelectAllText";
import type { BootedDevice } from "../../../src/models";
import type { HierarchyLayer } from "../../../src/models/HierarchyLayer";
import {
  nodeAttributes,
  type ViewHierarchyNode,
  type ViewHierarchyResult,
} from "../../../src/models/ViewHierarchyResult";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import {
  capturedFloatingCoverHierarchy,
  capturedTwoWindowHierarchy,
  observationOf,
} from "../../helpers/overlayWindowCapture";

const device: BootedDevice = { name: "Android", platform: "android", deviceId: "emulator-5600" };

/**
 * The floating-overlay device capture with one node marked input-focused. No device capture of a
 * focused prototype text field exists yet, so the overlay's `coverBox` or the app's
 * `button_elevated` stands in for the focused field; the windows and tree are as captured.
 */
function withFocused(hierarchy: ViewHierarchyResult, resourceId: string): ViewHierarchyResult {
  const visit = (node: ViewHierarchyNode): boolean => {
    const attributes = nodeAttributes(node);
    if (attributes["resource-id"] === resourceId) {
      attributes["focused"] = "true";
      return true;
    }
    const children =
      node.node === undefined ? [] : Array.isArray(node.node) ? node.node : [node.node];
    return children.some(visit);
  };
  expect(visit(hierarchy.hierarchy as ViewHierarchyNode)).toBe(true);
  return hierarchy;
}

async function selectAll(hierarchy: ViewHierarchyResult, layer?: HierarchyLayer) {
  let requests = 0;
  const action = new SelectAllText(device, new FakeAdbClientFactory(), () => ({
    requestSelectAll: async () => {
      requests++;
      return { success: true, totalTimeMs: 1 };
    },
  }));
  action.observedInteraction = (block) => block(observationOf(hierarchy));
  const result = await action.execute(undefined, undefined, { layer });
  return { result, requests };
}

describe("selectAllText layer (#9305)", () => {
  test('"app" refuses before dispatch when the focused field is in the overlay', async () => {
    const { result, requests } = await selectAll(
      withFocused(capturedFloatingCoverHierarchy(), "coverBox"),
      "app",
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("the focused text field is in the AutoMobile overlay");
    expect(requests).toBe(0);
  });

  test('"overlay" refuses before dispatch when the focused field is in the app', async () => {
    const { result, requests } = await selectAll(
      withFocused(capturedFloatingCoverHierarchy(), "button_elevated"),
      "overlay",
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("the focused text field is in the app");
    expect(requests).toBe(0);
  });

  test("a focused field on the requested layer is selected", async () => {
    const overlay = await selectAll(
      withFocused(capturedFloatingCoverHierarchy(), "coverBox"),
      "overlay",
    );
    const app = await selectAll(
      withFocused(capturedFloatingCoverHierarchy(), "button_elevated"),
      "app",
    );

    expect([overlay.result.success, app.result.success]).toEqual([true, true]);
    expect(overlay.requests + app.requests).toBe(2);
  });

  test('"overlay" with no overlay showing is an actionable error', async () => {
    const { result, requests } = await selectAll(capturedTwoWindowHierarchy(), "overlay");

    expect(result.success).toBe(false);
    expect(result.error).toContain("no AutoMobile overlay is showing");
    expect(requests).toBe(0);
  });

  test("omitting layer keeps today's behaviour: the overlay's focused field is selected", async () => {
    const { result, requests } = await selectAll(
      withFocused(capturedFloatingCoverHierarchy(), "coverBox"),
    );

    expect(result.success).toBe(true);
    expect(requests).toBe(1);
  });
});
