import type { PrototypeColorMode } from "../prototypeContrast";
import type { WebOrientation } from "./webFrame";
import type { PrototypeIconGlyphSource, PrototypeIconVariant } from "./webIconGlyphs";
import { toHtml, type WebElement } from "./webNodes";
import { renderPrototypeWebPointViews, type PrototypeWebViewSettings } from "./webPageViews";
import { prototypeWebViewMatches, type PrototypeWebViewKey } from "./webPageRuntime";
import type { StillTextSize } from "./webTextScale";

/**
 * What the prototype web page inlines for the browser to draw from (#16528): the inlined revisions
 * as spec JSON and everything the host drew their views with, so the page bundle draws a view the
 * host did not inline with the same function and the same inputs, and so the same markup.
 */
export interface PrototypeWebPageData {
  readonly frame: string;
  readonly mode?: PrototypeColorMode;
  readonly nowMs?: number;
  readonly locale?: string;
  readonly textSize?: StillTextSize;
  /** Asset ids in slot order: the slot each page image rule fills. */
  readonly imageSlots: readonly string[];
  /** Each glyph the inlined revisions draw, keyed `<variant>/<name>`, as the shapes the host drew. */
  readonly glyphs: Readonly<Record<string, readonly WebElement[]>>;
  /** Variants in page order, each one's revisions newest first. */
  readonly revisions: readonly PrototypeWebPageRevision[];
}

export interface PrototypeWebPageRevision {
  readonly variant: string;
  readonly revision: number;
  readonly spec: unknown;
}

/** The page's data block; the CSP does not apply to it, since a JSON script never runs. */
export const PROTOTYPE_WEB_PAGE_DATA_SELECTOR =
  'script[type="application/json"][data-prototype-page]';

/**
 * JSON for an inline `<script type="application/json">`: every `<` escaped, so no spec text can
 * close the element or open a comment; `JSON.parse` reads the escape back as `<`.
 */
export function prototypeWebPageJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

/** The data's glyph table as the still renderer's glyph source. */
export function prototypeWebPageGlyphSource(
  glyphs: PrototypeWebPageData["glyphs"],
): PrototypeIconGlyphSource {
  return {
    glyph(name: string, variant: PrototypeIconVariant) {
      const key = `${variant}/${name}`;
      return Object.hasOwn(glyphs, key) ? glyphs[key] : undefined;
    },
  };
}

const orientationOf = (name: string): WebOrientation =>
  name === "landscape" ? "landscape" : "portrait";

/** What the drawer needs from the page: its views, and a place to add one's markup. */
export interface PrototypeWebPageViewDom {
  readonly views: () => readonly {
    readonly dataset: Readonly<Record<string, string | undefined>>;
  }[];
  readonly insert: (html: string) => void;
}

/**
 * The runtime's `ensureViews` for a page: the first time a key is shown, it draws each of that
 * revision's views at the key's orientation and posture the page does not hold yet (one per stack
 * screen) and inserts their markup. A revision the page did not inline draws nothing.
 */
export function prototypeWebPageViewDrawer(
  data: PrototypeWebPageData,
  dom: PrototypeWebPageViewDom,
): (key: PrototypeWebViewKey) => boolean {
  const settings: PrototypeWebViewSettings = {
    frame: data.frame,
    ...(data.mode === undefined ? {} : { mode: data.mode }),
    ...(data.nowMs === undefined ? {} : { nowMs: data.nowMs }),
    ...(data.locale === undefined ? {} : { locale: data.locale }),
    ...(data.textSize === undefined ? {} : { textSize: data.textSize }),
    imageSlots: new Map(data.imageSlots.map((id, slot) => [id, slot])),
    glyphs: prototypeWebPageGlyphSource(data.glyphs),
  };
  const drawn = new Set<string>();
  return (key) => {
    const id = JSON.stringify([key.variant, key.revision, key.orientation, key.posture]);
    if (drawn.has(id)) {
      return false;
    }
    drawn.add(id);
    const of = data.revisions.find(
      (entry) => entry.variant === key.variant && String(entry.revision) === key.revision,
    );
    if (!of) {
      return false;
    }
    const held = new Set(
      dom
        .views()
        .filter((view) => prototypeWebViewMatches(view.dataset, key))
        .map((view) => view.dataset.screen ?? ""),
    );
    const point = {
      orientation: orientationOf(key.orientation),
      posture: key.posture === "" ? undefined : key.posture,
    };
    const missing = renderPrototypeWebPointViews(settings, of, point).filter(
      (view) => !held.has(view.screen ?? ""),
    );
    missing.forEach((view) => dom.insert(toHtml(view.element)));
    return missing.length > 0;
  };
}
