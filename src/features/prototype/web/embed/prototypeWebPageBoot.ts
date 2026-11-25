import {
  prototypeWebPageViewDrawer,
  type PrototypeWebPageData,
  type PrototypeWebPageViewDom,
} from "../webPageData";
import type { PrototypeWebViewKey } from "../webPageRuntime";

/** What the page bundle reads from the document: the browser's `document`, a fake in tests. */
export interface PrototypeWebPageDom extends PrototypeWebPageViewDom {
  /** The page's JSON data block (`PROTOTYPE_WEB_PAGE_DATA_SELECTOR`), or null without one. */
  readonly dataText: () => string | null;
}

/**
 * The page's `ensureViews` (#16528): it draws from the inlined data. A page without a data block
 * holds every view it has, so it gets none and the runtime only switches between them.
 */
export function bootPrototypeWebPage(
  dom: PrototypeWebPageDom,
): ((key: PrototypeWebViewKey) => boolean) | undefined {
  const text = dom.dataText();
  return text === null
    ? undefined
    : prototypeWebPageViewDrawer(JSON.parse(text) as PrototypeWebPageData, dom);
}
