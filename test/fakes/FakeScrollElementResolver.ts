import type { ResolverSelector } from "../../src/server/elementSelectorSchemas";
import type {
  ElementResolver,
  ElementResolution,
  ResolutionIntent,
  ResolverSnapshot,
} from "../../src/features/utility/ElementResolver";
import { SearchableHierarchy } from "../../src/features/utility/SearchableNode";
import type { Element } from "../../src/models/Element";
import { FakeElementFinder } from "./FakeElementFinder";

/** Retains scripted finder fixture data in scroll orchestration tests; matcher tests use the real resolver. */
export class FakeScrollElementResolver implements Pick<ElementResolver, "resolve"> {
  private scrollableContainer: () => Element | null = () => null;

  constructor(private readonly finder: FakeElementFinder = new FakeElementFinder()) {}

  /** Scripts the container returned for every scroll-intent resolution. */
  setNextScrollableContainer(container: Element | null): void {
    this.scrollableContainer = () => container;
  }

  /** Scripts the scroll container per lookup, e.g. to shift bounds between calls. */
  setScrollableContainerResolver(resolver: () => Element | null): void {
    this.scrollableContainer = resolver;
  }

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
            ? this.scrollableContainer()
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
