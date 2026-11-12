import { expect, test } from "bun:test";
import { preferVisibleMatches } from "../../../src/features/utility/ElementResolverNodes";
import { SearchableHierarchy } from "../../../src/features/utility/SearchableNode";
import type { ViewHierarchyResult } from "../../../src/models";

test("preferVisibleMatches terminates when a node list does not match its parent indexes (#18084)", () => {
  const hierarchy: ViewHierarchyResult = {
    hierarchy: {
      node: {
        bounds: { left: 0, top: 0, right: 1000, bottom: 2000 },
        node: [
          { "resource-id": "hidden", bounds: { left: 0, top: 0, right: 1000, bottom: 100 } },
          {
            "resource-id": "list",
            scrollable: true,
            bounds: { left: 0, top: 100, right: 1000, bottom: 2000 },
            node: [
              {
                "resource-id": "carousel",
                scrollable: true,
                bounds: { left: 0, top: 200, right: 1000, bottom: 600 },
              },
            ],
          },
        ],
      },
    },
  };
  // Dropping the hidden node shifts later positions by one: the carousel's parentIndex now names itself.
  const shifted = new SearchableHierarchy()
    .project(hierarchy)
    .filter((node) => node.properties["resource-id"] !== "hidden");
  const carousel = shifted.find((node) => node.properties["resource-id"] === "carousel")!;
  expect(shifted[carousel.parentIndex!]).toBe(carousel);
  const matches = shifted
    .filter((node) => node.parentIndex !== undefined)
    .map((node) => ({ node }));
  const kept = preferVisibleMatches(matches as Parameters<typeof preferVisibleMatches>[0], shifted);
  expect(kept.map(({ node }) => node.properties["resource-id"])).toEqual(["list", "carousel"]);
});
