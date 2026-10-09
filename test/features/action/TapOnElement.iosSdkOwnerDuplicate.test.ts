import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ViewHierarchyNode, ViewHierarchyResult } from "../../../src/models";
import { TapOnElement } from "../../../src/features/action/TapOnElement";
import { isSdkInjectedNode } from "../../../src/features/observe/android/StableNodeIdentity";
import { getHierarchyNodeSource } from "../../../src/features/observe/output/elementProvenance";
import { DefaultElementParser } from "../../../src/features/utility/ElementParser";
import { FakeTimer } from "../../fakes/FakeTimer";

// Captured on an iOS 27 simulator, Playground "Semantic Links (UIKit)" demo (#10843): the
// XCUITest UILink owner `uikit_semantic_links_inline` plus two sdkWalker UITextView copies
// carrying the same resource-id.
const FIXTURE = join(
  import.meta.dir,
  "../../fixtures/ios/ios27-uikit-semantic-links-sdk-owner-duplicate.json",
);
const OWNER_ID = "uikit_semantic_links_inline";

const loadHierarchy = (): ViewHierarchyResult =>
  JSON.parse(readFileSync(FIXTURE, "utf8")) as ViewHierarchyResult;

const createTapOnElement = (): TapOnElement =>
  new TapOnElement({ name: "test-device", platform: "ios", deviceId: "sim-udid" }, null, {
    timer: new FakeTimer(),
  });

const ownerCandidates = (hierarchy: ViewHierarchyResult) =>
  new DefaultElementParser()
    .flattenViewHierarchy(hierarchy, { includeWindows: true })
    .map(({ element }) => element)
    .filter((element) => element["resource-id"] === OWNER_ID);

const isInjected = (element: ReturnType<typeof ownerCandidates>[number]): boolean =>
  isSdkInjectedNode(getHierarchyNodeSource(element) as ViewHierarchyNode);

/** Visit every node of the main tree and window subtrees. */
const visitNodes = (hierarchy: ViewHierarchyResult, visit: (node: ViewHierarchyNode) => void) => {
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    if (value && typeof value === "object") {
      const node = value as ViewHierarchyNode;
      visit(node);
      walk(node.node);
    }
  };
  walk(hierarchy.hierarchy?.node);
  hierarchy.windows?.forEach((window) => walk(window.hierarchy?.node));
};

describe("TapOnElement iOS semantic-link owner identity with SDK copies (#10843)", () => {
  test("the capture holds one XCUITest owner and SDK copies of its resource-id", () => {
    const candidates = ownerCandidates(loadHierarchy());
    expect(candidates.filter((element) => !isInjected(element))).toHaveLength(1);
    expect(candidates.filter(isInjected).length).toBeGreaterThanOrEqual(1);
  });

  test("accepts the XCUITest owner despite sdkWalker copies of its resource-id", () => {
    const hierarchy = loadHierarchy();
    const owner = ownerCandidates(hierarchy).find((element) => !isInjected(element));
    expect(createTapOnElement()["hasUniqueSemanticLinkOwner"](owner, hierarchy)).toBe(true);
  });

  test("the id-only container resolves to an owner that passes the identity check", () => {
    const hierarchy = loadHierarchy();
    const tapOnElement = createTapOnElement();
    const owner = tapOnElement["resolveContainerElement"](hierarchy, {
      container: { elementId: OWNER_ID },
      accessibilityLink: "Terms of Service",
    });
    expect(owner?.["resource-id"]).toBe(OWNER_ID);
    expect(tapOnElement["hasUniqueSemanticLinkOwner"](owner, hierarchy)).toBe(true);
  });

  test("still rejects an owner whose resource-id two XCUITest nodes carry", () => {
    const hierarchy = loadHierarchy();
    let promoted = false;
    visitNodes(hierarchy, (node) => {
      if (!promoted && node["resource-id"] === OWNER_ID && isSdkInjectedNode(node)) {
        // Turn one SDK copy into a captured node: two captured owners are ambiguous.
        delete (node.extras as Record<string, unknown>)["sdk.source"];
        promoted = true;
      }
    });
    expect(promoted).toBe(true);
    const owner = ownerCandidates(hierarchy)[0];
    expect(createTapOnElement()["hasUniqueSemanticLinkOwner"](owner, hierarchy)).toBe(false);
  });

  test("counts SDK copies when XCUITest captured no node with the resource-id", () => {
    const hierarchy = loadHierarchy();
    visitNodes(hierarchy, (node) => {
      if (node["resource-id"] === OWNER_ID && !isSdkInjectedNode(node)) {
        node["resource-id"] = "renamed_owner";
      }
    });
    const owner = ownerCandidates(hierarchy)[0];
    expect(createTapOnElement()["hasUniqueSemanticLinkOwner"](owner, hierarchy)).toBe(false);
  });
});
