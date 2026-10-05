import type { ViewHierarchyResult } from "../../../src/models";
import { FakeTalkBackNavigationDriver } from "../../fakes/FakeTalkBackNavigationDriver";

/** Full-tree observation seam; traversal order alone omits non-focusable nodes. */
export class HierarchyTalkBackDriver extends FakeTalkBackNavigationDriver {
  hierarchy: ViewHierarchyResult | null | undefined;

  async getAccessibilityHierarchy(): Promise<ViewHierarchyResult | null> {
    if (this.hierarchy !== undefined) {
      return this.hierarchy;
    }
    return {
      hierarchy: {
        node: (this.elements.length ? this.elements : [{ "resource-id": "test:id/button" }]).map(
          (element) => ({ $: element }),
        ),
      },
    };
  }
}
