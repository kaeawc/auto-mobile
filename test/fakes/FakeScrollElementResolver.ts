import type { ResolverSelector } from "../../src/server/elementSelectorSchemas";
import type {
  ElementResolution,
  ResolutionIntent,
  ResolverSnapshot,
} from "../../src/features/utility/ElementResolver";
import { SearchableHierarchy } from "../../src/features/utility/SearchableNode";
import type { FakeElementFinder } from "./FakeElementFinder";

/** Retains scripted finder fixture data in scroll orchestration tests; matcher tests use the real resolver. */
export class FakeScrollElementResolver {
  constructor(private readonly finder: FakeElementFinder) {}
  resolve(
    snapshot: ResolverSnapshot,
    selector: ResolverSelector,
    intent: ResolutionIntent,
  ): ElementResolution {
    const roots = snapshot.nodes
      .filter((node) => node.parentIndex === undefined)
      .map((node) => node.source);
    const hierarchy = { hierarchy: { node: roots.length === 1 ? roots[0] : roots } };
    const element =
      selector.text !== undefined
        ? this.finder.findElementByText(hierarchy, selector.text, selector.container, true, false)
        : selector.elementId !== undefined
          ? this.finder.findElementByResourceId(
              hierarchy,
              selector.elementId,
              selector.container,
              false,
            )
          : intent.action === "scroll"
            ? this.finder.findScrollableContainer(hierarchy)
            : null;
    const entry = element
      ? new SearchableHierarchy().project({ hierarchy: { node: element } })[0]
      : null;
    return {
      chosen: entry,
      candidates: entry ? [entry] : [],
      matches: entry ? [{ node: entry, kind: "all" }] : [],
      matchMode: "exact",
    };
  }
}
