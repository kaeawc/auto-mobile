import { describe, expect, test } from "bun:test";
import { ResolverElementSelector } from "../../../src/features/utility/ResolverElementSelector";
import { TapOnElement } from "../../../src/features/action/TapOnElement";
import type { ViewHierarchyResult } from "../../../src/models";
import { FakeAdbClient } from "../../fakes/FakeAdbClient";
import { FakeTimer } from "../../fakes/FakeTimer";
// Overlay nodes captured on emulator-5602 (API 36, Pixel Fold inner panel) while verifying
// #10433: the overlay's Compose testTags arrive as a bare `resource-id` with no `test-tag`.
import overlayCapture from "../../fixtures/android-overlay-testtag/overlay-scroll-emulator-api36.json";
import testTagCapture from "../../fixtures/observe/android-test-tag.json";

type HierarchyNode = Record<string, unknown>;

function overlay(): ViewHierarchyResult & { hierarchy: { node: HierarchyNode[] } } {
  return structuredClone(overlayCapture);
}

function taggedSubmitNode(): HierarchyNode {
  return structuredClone(testTagCapture.viewHierarchy.hierarchy.node[0]);
}

describe("testTag selector falls back to an untagged node's exact resource-id (#10626)", () => {
  test.each([
    ["A_on2", { left: 78, top: 889, right: 230, bottom: 1006 }],
    ["A_pick", { left: 39, top: 331, right: 186, bottom: 448 }],
    ["A_fab", { left: 39, top: 1957, right: 180, bottom: 2074 }],
  ])("selects the captured overlay node tagged %s", (tag, bounds) => {
    const selected = new ResolverElementSelector().selectByTestTag(overlay(), tag);
    expect(selected.element?.["resource-id"]).toBe(tag);
    expect(selected.element?.bounds).toEqual(bounds);
  });

  test("tapOn's testTag lookup finds the captured overlay node", () => {
    const tapOn = new TapOnElement(
      { name: "test-device", platform: "android", deviceId: "emulator-5602" } as never,
      new FakeAdbClient() as never,
      { timer: new FakeTimer() },
    );
    const lookup = (
      tapOn as unknown as {
        findElementInHierarchy(
          options: { testTag: string; action: "tap" },
          hierarchy: ViewHierarchyResult,
        ): { selection: { element: HierarchyNode | null } };
      }
    ).findElementInHierarchy({ testTag: "A_edit3", action: "tap" }, overlay());
    expect(lookup.selection.element?.["resource-id"]).toBe("A_edit3");
  });

  test("a node's own test-tag still wins over another node's matching resource-id", () => {
    const capture = overlay();
    const tagged = { ...taggedSubmitNode(), "test-tag": "A_on2" };
    capture.hierarchy.node.push(tagged);
    const selected = new ResolverElementSelector().selectByTestTag(capture, "A_on2");
    expect(selected.element?.["test-tag"]).toBe("A_on2");
    expect(selected.element?.["resource-id"]).toBe("example.app:id/submit");
  });

  test("a node whose test-tag differs is not matched through its resource-id", () => {
    const capture = overlay();
    capture.hierarchy.node[1] = { ...capture.hierarchy.node[1], "test-tag": "other-tag" };
    expect(new ResolverElementSelector().selectByTestTag(capture, "A_on2").element).toBeNull();
  });

  test("the fallback is exact: a bare tag does not match a package-qualified View id", () => {
    const untagged = taggedSubmitNode();
    delete untagged["test-tag"];
    const capture = { hierarchy: { node: [untagged] } };
    const selector = new ResolverElementSelector();
    expect(selector.selectByTestTag(capture, "submit").element).toBeNull();
    // The full id is the node's exact reported identifier, so it matches when the node has no tag.
    expect(selector.selectByTestTag(capture, "example.app:id/submit").element?.text).toBe(
      "Submit form",
    );
  });
});
