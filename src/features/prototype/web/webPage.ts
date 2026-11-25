import { createHash } from "node:crypto";
import { ActionableError } from "../../../models";
import { logger } from "../../../utils/logger";
import { materialIconGlyphs } from "./materialIconGlyphs";
import type { PrototypeColorMode } from "../prototypeContrast";
import { defaultDeviceFrameId, deviceFrameOrThrow } from "./deviceFrames";
import { withActionableWebInput } from "./prototypeWebInputActionable";
import {
  PROTOTYPE_WEB_3D_CSS,
  prototypeWeb3dBodyAttributes,
  prototypeWeb3dControls,
  prototypeWebFold,
  type PrototypeWebFold,
} from "./webDevice3d";
import { defaultFramePosture, framePostures } from "./webFold";
import { frameOrientations, type WebOrientation } from "./webFrame";
import type { PrototypeIconGlyphSource } from "./webIconGlyphs";
import { el, escapeAttribute, toHtml, type WebElement } from "./webNodes";
import { prototypeWebPageBundle } from "./prototypeWebPageBundle";
import { prototypeWebPageJson, type PrototypeWebPageData } from "./webPageData";
import {
  renderPrototypeWebPointViews,
  type PrototypeWebView,
  type PrototypeWebViewPoint,
  type PrototypeWebViewSettings,
} from "./webPageViews";
import { FADE_EDGES_PAGE_CSS } from "./webStylePolish";
import { ANCHORED_LAYERS_PAGE_CSS } from "./webMenu";
import type { UnsupportedWebNode } from "./webRender";
import {
  webImageBox,
  webImageRule,
  type PrototypeWebImage,
  type WebImageBox,
  type WebImageDraw,
  type WebImageFillExtent,
} from "./webImages";
import type { StillTextSize } from "./webTextScale";

/** One spec revision: its number, the operation that created it and the spec itself. */
export interface PrototypeWebRevision {
  readonly revision: number;
  readonly operation: "show" | "patch";
  readonly spec: unknown;
}

/** A design alternative: sibling specs grouped under one prototype. */
export interface PrototypeWebVariant {
  readonly id: string;
  readonly label: string;
  /** Oldest first, as the host records them. */
  readonly revisions: readonly PrototypeWebRevision[];
}

export interface PrototypeWebPageInput {
  readonly title: string;
  readonly variants: readonly PrototypeWebVariant[];
  /** The variant shown first; defaults to the first one. */
  readonly variant?: string;
  /** The revision shown first; defaults to the variant's latest. */
  readonly revision?: number;
  readonly frame?: string;
  readonly platform?: "android" | "ios";
  readonly mode?: PrototypeColorMode;
  readonly nowMs?: number;
  /** The host locale every view renders in (BCP 47, default `en-US`). */
  readonly locale?: string;
  /** The system text size every view renders at. */
  readonly textSize?: StillTextSize;
  /** Total page budget; defaults to MAX_PROTOTYPE_WEB_PAGE_BYTES. */
  readonly maxBytes?: number;
  /** Cumulative cap on the encoded images' data URIs, in budget order; defaults to maxBytes. */
  readonly maxImageBytes?: number;
  /** Encoded assets the page inlines while the budget allows; the first entry per id counts. */
  readonly images?: readonly PrototypeWebImage[];
}

/**
 * An asset the page draws and the pixel boxes it is drawn in, to encode it at the right size;
 * `compactBoxes`, present only when they differ, bound filled axes by the portrait width instead,
 * for a smaller encode when the page's images do not all fit.
 */
export interface PrototypeWebImageRequest {
  readonly id: string;
  readonly boxes: readonly WebImageBox[];
  readonly compactBoxes?: readonly WebImageBox[];
}

export interface PrototypeWebPage {
  readonly html: string;
  readonly sha256: string;
  readonly frame: string;
  /** Unsupported nodes of the view shown first. */
  readonly unsupportedNodes: readonly UnsupportedWebNode[];
  /** Revisions inlined per variant, newest first; older ones are not in the page. */
  readonly inlinedRevisions: Readonly<Record<string, readonly number[]>>;
  /**
   * Every asset any rendered view draws, the revision shown first, then the other pinned ones,
   * then older revisions newest first: the order the page inlines them in.
   */
  readonly imageRequests: readonly PrototypeWebImageRequest[];
  /** Asset ids inlined into the page. */
  readonly inlinedImages: readonly string[];
}

/**
 * The page's one script (#16528): the committed page bundle, the page runtime and its 3D view
 * plus the host's view renderer, which draws each view the host did not inline from the page's
 * spec JSON. The CSP pins it by hash.
 */
export const PROTOTYPE_WEB_PAGE_SCRIPT = prototypeWebPageBundle();
export const MAX_PROTOTYPE_WEB_PAGE_BYTES = 2 * 1024 * 1024;

const PAGE_CSS = [
  "*{box-sizing:border-box}",
  "html,body{margin:0;height:100%}",
  "body{display:flex;flex-direction:column;font:14px system-ui,-apple-system,Roboto,sans-serif;background:#f3f3f3;color:#1d1b20}",
  "[data-toolbar]{display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:8px;border-bottom:1px solid #ccc;background:#fff}",
  "[data-toolbar] button,[data-toolbar] select{font:inherit;padding:4px 10px}",
  "[aria-pressed=true]{font-weight:700}",
  "[data-main]{flex:1;display:flex;min-height:0}",
  "[data-viewport]{flex:1;overflow:hidden;position:relative;cursor:grab;touch-action:none}",
  "[data-stage]{position:absolute;left:50%;top:50%;transform-origin:center}",
  "[data-view]{position:absolute;transform:translate(-50%,-50%)}",
  "[data-control=revisions]{width:180px;overflow:auto;border-left:1px solid #ccc;background:#fff;margin:0;padding:8px;list-style:none}",
  "[data-control=revisions] button{width:100%;text-align:start;margin-bottom:4px}",
  "[data-note]{color:#5f5b66;font-size:12px}",
  // A narrow window keeps the width for the stage and moves the history below it.
  "@media (max-width:720px){[data-main]{flex-direction:column}[data-control=revisions]{width:auto;max-height:30vh;border-left:0;border-top:1px solid #ccc}}",
  "[hidden]{display:none!important}",
  FADE_EDGES_PAGE_CSS,
  ANCHORED_LAYERS_PAGE_CSS,
  PROTOTYPE_WEB_3D_CSS,
].join("");

function cspFor(script: string): string {
  const hash = createHash("sha256").update(script).digest("base64");
  return [
    "default-src 'none'",
    `script-src 'sha256-${hash}'`,
    "style-src 'unsafe-inline'",
    "img-src data:",
    "font-src data:",
  ].join("; ");
}

/** A view as the page inlines it: its markup, with what the budget and image requests read. */
type RenderedView = Omit<PrototypeWebView, "element" | "stack"> & { readonly html: string };

/**
 * One screen of one revision in each of the frame's orientations and every posture: the unit the
 * budget keeps or drops.
 */
type ScreenGroup = readonly RenderedView[];

/**
 * One revision: its spec, its screen groups (start screen first) and the glyphs its views drew,
 * which the page's data carries for the browser to draw them again.
 */
interface RevisionViews {
  readonly variant: string;
  readonly revision: number;
  readonly spec: unknown;
  readonly screens: readonly ScreenGroup[];
  readonly glyphs: ReadonlyMap<string, readonly WebElement[]>;
}

/**
 * The page's frame: its id, the orientations it has (the first shown first) and the postures it
 * pre-renders (one undefined entry for none).
 */
interface ViewFrame {
  readonly id: string;
  readonly orientations: readonly WebOrientation[];
  readonly postures: readonly (string | undefined)[];
}

/** What every view of the page shares; the page's data carries the same values. */
function viewSettings(
  input: PrototypeWebPageInput & { readonly slots: ReadonlyMap<string, number> },
  frame: string,
  glyphs: PrototypeIconGlyphSource,
): PrototypeWebViewSettings {
  return {
    frame,
    ...(input.mode === undefined ? {} : { mode: input.mode }),
    ...(input.nowMs === undefined ? {} : { nowMs: input.nowMs }),
    imageSlots: input.slots,
    ...(input.locale === undefined ? {} : { locale: input.locale }),
    ...(input.textSize === undefined ? {} : { textSize: input.textSize }),
    logger,
    glyphs,
  };
}

/**
 * The Material Icons Android draws, recording each glyph a still draws under `<variant>/<name>`,
 * so the page inlines exactly the shapes its views were drawn with.
 */
function recordingGlyphs(used: Map<string, readonly WebElement[]>): PrototypeIconGlyphSource {
  const source = materialIconGlyphs();
  return {
    glyph(name, variant) {
      const shapes = source.glyph(name, variant);
      if (shapes) {
        used.set(`${variant}/${name}`, shapes);
      }
      return shapes;
    },
  };
}

/** Every posture and orientation, the default posture's first orientation first. */
function viewPoints(frame: ViewFrame): PrototypeWebViewPoint[] {
  return frame.postures.flatMap((posture) =>
    frame.orientations.map((orientation) => ({ orientation, posture })),
  );
}

/** One orientation and posture's views of a revision, start screen first, as markup. */
function pointViews(
  settings: PrototypeWebViewSettings,
  at: { variant: string; revision: PrototypeWebRevision },
  point: PrototypeWebViewPoint,
): RenderedView[] {
  const of = { variant: at.variant, revision: at.revision.revision, spec: at.revision.spec };
  return renderPrototypeWebPointViews(settings, of, point).map(
    ({ element, stack: _stack, ...view }) => ({ ...view, html: toHtml(element) }),
  );
}

/**
 * Each revision newest first, grouped by screen index across every orientation and posture: group
 * 0 holds each one's start view (the default posture's first orientation first), group i each one's i-th
 * screen where it has one.
 */
function renderViews(
  input: PrototypeWebPageInput & { readonly slots: ReadonlyMap<string, number> },
  frame: ViewFrame,
  variant: PrototypeWebVariant,
): RevisionViews[] {
  return [...variant.revisions].reverse().map((revision) => {
    const at = { variant: variant.id, revision };
    const glyphs = new Map<string, readonly WebElement[]>();
    const settings = viewSettings(input, frame.id, recordingGlyphs(glyphs));
    const perPoint = viewPoints(frame).map((point) => pointViews(settings, at, point));
    const count = Math.max(...perPoint.map((views) => views.length));
    const groups = Array.from({ length: count }, (_, index) =>
      perPoint.flatMap((views) => views.slice(index, index + 1)),
    );
    return {
      variant: variant.id,
      revision: revision.revision,
      spec: revision.spec,
      screens: groups,
      glyphs,
    };
  });
}

const POSTURE_LABELS: Readonly<Record<string, string>> = {
  closed: "Closed",
  half_opened: "Half opened",
  opened: "Opened",
  rear_display: "Rear display",
  flipped: "Flipped",
  tent: "Tent",
};

/**
 * The posture picker, which switches the shown view's posture layout: only a frame with two or
 * more postures offers one. It is `layout-posture`, apart from the 3D view's `posture` select,
 * which turns the 3D hinge.
 */
function posturePicker(frame: PageFrame): WebElement[] {
  if (frame.postures.length < 2) {
    return [];
  }
  return [
    el(
      "select",
      { attrs: { "data-control": "layout-posture", "aria-label": "Layout posture" } },
      frame.postures.map((posture) =>
        el(
          "option",
          {
            attrs: { value: posture, ...(posture === frame.posture ? { selected: "" } : {}) },
          },
          [POSTURE_LABELS[posture] ?? posture],
        ),
      ),
    ),
  ];
}

/** The screen picker's options, or undefined for no picker; fewer than two options hide it. */
type ScreenPicker = readonly string[] | undefined;

function screenPicker(screens: ScreenPicker): WebElement[] {
  if (screens === undefined) {
    return [];
  }
  const attrs: Record<string, string> = { "data-control": "screen", "aria-label": "Screen" };
  return [
    el(
      "select",
      { attrs: screens.length < 2 ? { ...attrs, hidden: "" } : attrs },
      screens.map((screen) => el("option", { attrs: { value: screen } }, [screen])),
    ),
  ];
}

/** The frame facts the page shell needs: the platform's rotation and the orientations it has. */
interface PageFrame {
  readonly platform: string;
  /** The orientation shown first. */
  readonly orientation: WebOrientation;
  /** A device that never rotates gets no rotate control. */
  readonly rotates: boolean;
  /** The frame's postures, and the one shown first; a frame without postures has none. */
  readonly postures: readonly string[];
  readonly posture?: string;
  /** The frame's hinge and postures, for the 3D view's fold controls; none when it does not fold. */
  readonly fold: PrototypeWebFold | undefined;
}

function toolbar(
  input: PrototypeWebPageInput,
  chosen: PrototypeWebVariant,
  screens: ScreenPicker,
  frame: PageFrame,
): WebElement {
  const button = (control: string, label: string, text: string) =>
    el("button", { attrs: { type: "button", "data-control": control, "aria-label": label } }, [
      text,
    ]);
  // A variant with no revisions has nothing to show, so it is not offered.
  const selectable = input.variants.filter((variant) => variant.revisions.length > 0);
  const variants =
    selectable.length > 1
      ? [
          el(
            "select",
            { attrs: { "data-control": "variant", "aria-label": "Variant" } },
            selectable.map((variant) =>
              el(
                "option",
                {
                  attrs: {
                    value: variant.id,
                    "data-latest": String(variant.revisions.at(-1)?.revision ?? ""),
                    ...(variant.id === chosen.id ? { selected: "" } : {}),
                  },
                },
                [variant.label],
              ),
            ),
          ),
        ]
      : [];
  return el(
    "div",
    { attrs: { "data-toolbar": "", role: "toolbar", "aria-label": "Prototype view" } },
    [
      ...(frame.rotates ? [button("rotate", "Rotate device", "Rotate")] : []),
      ...posturePicker(frame),
      button("zoom-out", "Zoom out", "−"),
      el("span", { attrs: { "data-control": "zoom-level", "aria-live": "polite" } }, ["100%"]),
      button("zoom-in", "Zoom in", "+"),
      button("zoom-fit", "Fit to window", "Fit"),
      ...variants,
      ...screenPicker(screens),
      ...prototypeWeb3dControls(frame.fold),
      el("span", { attrs: { "data-note": "" } }, [
        // Kept from when every view was pre-rendered (#16528): every page golden draws this line.
        "Static preview: taps do nothing; these controls switch pre-rendered views.",
      ]),
    ],
  );
}

function historyEntry(variant: string, revision: { revision: number; operation: string }) {
  return el("li", {}, [
    el(
      "button",
      {
        attrs: {
          type: "button",
          "data-revision-for": variant,
          "data-revision-value": String(revision.revision),
          "aria-pressed": "false",
        },
      },
      [`r${revision.revision} · ${revision.operation}`],
    ),
  ]);
}

/** The bytes one revision's history entry adds to the page. */
function historyEntryBytes(input: PrototypeWebPageInput, variant: string, revision: number) {
  const entry = input.variants
    .find((candidate) => candidate.id === variant)
    ?.revisions.find((candidate) => candidate.revision === revision);
  return entry ? Buffer.byteLength(toHtml(historyEntry(variant, entry))) : 0;
}

/**
 * The revision history, or nothing when no variant has more than one revision in the page, since
 * a single entry has nothing to switch to. The shell is measured with the list always present, so
 * an older revision that brings the list back never pushes the page over its budget.
 */
function revisionHistory(
  input: PrototypeWebPageInput,
  included: (variant: string, revision: number) => boolean,
  always = false,
): WebElement | undefined {
  const lists = input.variants.map((variant) =>
    [...variant.revisions]
      .reverse()
      .filter((revision) => included(variant.id, revision.revision))
      .map((revision) => historyEntry(variant.id, revision)),
  );
  if (!always && !lists.some((list) => list.length > 1)) {
    return undefined;
  }
  const items = lists.flat();
  return el(
    "ul",
    { attrs: { "data-control": "revisions", "aria-label": "Revision history" } },
    items,
  );
}

/** Whether a revision is always kept: each variant's latest, plus the one shown first. */
type Pinned = (variant: string, revision: number) => boolean;

/** A revision's entry in the page's data. */
const dataEntry = (revision: RevisionViews) => ({
  variant: revision.variant,
  revision: revision.revision,
  spec: revision.spec,
});

const jsonBytes = (value: unknown) => Buffer.byteLength(prototypeWebPageJson(value));

/** The pinned revision whose spec JSON is largest: the one to name when even they do not fit. */
function largestRevision(revisions: readonly RevisionViews[]): RevisionViews {
  return revisions.reduce((largest, revision) =>
    jsonBytes(revision.spec) > jsonBytes(largest.spec) ? revision : largest,
  );
}

function refuseOverBudget(limit: number, pinned: readonly RevisionViews[]): never {
  const largest = largestRevision(pinned);
  throw new ActionableError(
    `The prototype web page would exceed ${limit} bytes even with only the latest revision of each variant and the revision shown first. Largest revision: variant ${largest.variant} revision ${largest.revision} (${jsonBytes(largest.spec)} bytes of spec JSON). Reduce the spec's repeated content or show fewer variants.`,
  );
}

/** What the budget kept: revisions in page order, and the inlined assets in slot order. */
interface Budgeted {
  readonly revisions: RevisionViews[];
  readonly images: readonly string[];
}

/** Assets a revision's views draw, in view and tree order, each once. */
function drawnAssets(revision: RevisionViews): string[] {
  return [...new Set(revision.screens.flat().flatMap((view) => view.draws.map((d) => d.asset)))];
}

/**
 * The bytes the page's data grows by per revision: its entry in `revisions` and each glyph it draws
 * that no kept revision drew before, each with the comma that separates it from the last one.
 */
function dataCharges() {
  let entries = 0;
  const glyphs = new Set<string>();
  const cost = (revision: RevisionViews) => {
    const fresh = [...revision.glyphs].filter(([key]) => !glyphs.has(key));
    const glyphBytes = fresh.reduce(
      (sum, [key, shapes], index) =>
        sum + jsonBytes(key) + 1 + jsonBytes(shapes) + (glyphs.size + index > 0 ? 1 : 0),
      0,
    );
    return jsonBytes(dataEntry(revision)) + (entries > 0 ? 1 : 0) + glyphBytes;
  };
  const charge = (revision: RevisionViews) => {
    entries += 1;
    for (const key of revision.glyphs.keys()) {
      glyphs.add(key);
    }
  };
  return { cost, charge };
}

/**
 * The pinned revisions always, then the images they draw; then older revisions newest first, each
 * while its data and history entry fit, followed by its images (#16528). A revision is kept whole:
 * the browser draws all of its views from its one spec. Each image is charged once, as the page
 * rule that inlines it; one that does not fit stays a placeholder. The shown revision's images go
 * first among the pinned. The budget is the page limit minus the shell (head, toolbar, script, the
 * shown view and the pinned revisions' history entries), so it counts exactly what the page holds.
 */
function budgetedRevisions(
  input: PrototypeWebPageInput,
  revisions: readonly RevisionViews[],
  shellBytes: number,
  {
    pinned,
    isShown,
    rules,
  }: {
    readonly pinned: Pinned;
    readonly isShown: (revision: RevisionViews) => boolean;
    /** Each inlinable image's page rule by asset id, in slot order. */
    readonly rules: ReadonlyMap<string, string>;
  },
): Budgeted {
  const limit = input.maxBytes ?? MAX_PROTOTYPE_WEB_PAGE_BYTES;
  let room = limit - shellBytes;
  const fits = (cost: number) => {
    const fit = cost <= room;
    room -= fit ? cost : 0;
    return fit;
  };
  const data = dataCharges();
  const isPinned = (revision: RevisionViews) => pinned(revision.variant, revision.revision);
  const latest = revisions.filter(isPinned);
  const pinnedBytes = latest.reduce((sum, revision) => {
    const cost = data.cost(revision);
    data.charge(revision);
    return sum + cost;
  }, 0);
  if (!fits(pinnedBytes)) {
    refuseOverBudget(limit, latest);
  }
  const images = new Set<string>();
  const considered = new Set<string>();
  const addImages = (revision: RevisionViews) => {
    for (const asset of drawnAssets(revision)) {
      const rule = rules.get(asset);
      if (rule !== undefined && !considered.has(asset)) {
        considered.add(asset);
        if (fits(Buffer.byteLength(rule))) {
          images.add(asset);
        }
      }
    }
  };
  const kept = new Set(latest);
  [...latest.filter(isShown), ...latest.filter((revision) => !isShown(revision))].forEach(
    addImages,
  );
  for (const revision of revisions.filter((entry) => !isPinned(entry))) {
    const history = historyEntryBytes(input, revision.variant, revision.revision);
    if (fits(data.cost(revision) + history)) {
      data.charge(revision);
      kept.add(revision);
      addImages(revision);
    }
  }
  // Keep the page's own order: variants in input order, revisions newest first.
  return {
    revisions: revisions.filter((revision) => kept.has(revision)),
    images: [...rules.keys()].filter((asset) => images.has(asset)),
  };
}

/**
 * Every asset the rendered views draw with the boxes it is drawn in, in the order the budget
 * considers images: the shown revision, the other pinned ones, then the rest newest first.
 */
function imageRequests(
  revisions: readonly RevisionViews[],
  isShown: (revision: RevisionViews) => boolean,
  isPinned: (revision: RevisionViews) => boolean,
  frame: string,
): PrototypeWebImageRequest[] {
  const screen = deviceFrameOrThrow(frame).screen;
  const ordered = [
    ...revisions.filter(isShown),
    ...revisions.filter((revision) => isPinned(revision) && !isShown(revision)),
    ...revisions.filter((revision) => !isPinned(revision)),
  ];
  const draws = new Map<string, WebImageDraw[]>();
  for (const revision of ordered) {
    for (const draw of revision.screens.flat().flatMap((view) => view.draws)) {
      draws.set(draw.asset, [...(draws.get(draw.asset) ?? []), draw]);
    }
  }
  const unique = (forAsset: readonly WebImageDraw[], fill: WebImageFillExtent) => [
    ...new Map(
      forAsset
        .map((draw) => webImageBox(draw, screen, fill))
        .map((box) => [JSON.stringify(box), box]),
    ).values(),
  ];
  return [...draws].map(([id, forAsset]) => {
    const boxes = unique(forAsset, "long");
    const compactBoxes = unique(forAsset, "short");
    return JSON.stringify(compactBoxes) === JSON.stringify(boxes)
      ? { id, boxes }
      : { id, boxes, compactBoxes };
  });
}

/**
 * The picker for a page holding these revisions: none unless one of them has a multi-screen stack,
 * else every screen the shown revision has in any orientation or posture (none or one hide it; the
 * runtime lists the shown view's own), so the shell never undercounts the final picker.
 */
function pickerFor(
  revisions: readonly RevisionViews[],
  shown: { variant: PrototypeWebVariant; revision: number },
): ScreenPicker {
  if (!revisions.some((revision) => revision.screens.length > 1)) {
    return undefined;
  }
  const current = revisions.find(
    (revision) => revision.variant === shown.variant.id && revision.revision === shown.revision,
  );
  const screens = (current?.screens ?? []).flat().flatMap((view) => view.screen ?? []);
  return [...new Set(screens)];
}

function chooseVariant(input: PrototypeWebPageInput): PrototypeWebVariant {
  const chosen =
    input.variant === undefined
      ? input.variants[0]
      : input.variants.find((variant) => variant.id === input.variant);
  if (!chosen || chosen.revisions.length === 0) {
    throw new ActionableError(
      `Unknown or empty prototype variant "${input.variant ?? ""}". Variants: ${input.variants.map((variant) => variant.id).join(", ")}`,
    );
  }
  return chosen;
}

/** Each image's inlining rule by asset id, in slot order; a repeated id keeps its first entry. */
function imageRules(images: readonly PrototypeWebImage[]): Map<string, string> {
  const rules = new Map<string, string>();
  for (const image of images) {
    if (!rules.has(image.id)) {
      rules.set(image.id, webImageRule(rules.size, image));
    }
  }
  return rules;
}

interface PageParts {
  readonly frame: PageFrame;
  /** The view shown first, drawn by the host: the no-script fallback and what thumbnails capture. */
  readonly view: string;
  /** The inlined revisions and what the page bundle draws their other views with. */
  readonly data: PrototypeWebPageData;
  /** Rules that inline the page's images, in slot order. */
  readonly images?: string;
  readonly history: WebElement | undefined;
  readonly screens: ScreenPicker;
}

function pageHtml(
  input: PrototypeWebPageInput,
  first: { variant: PrototypeWebVariant; revision: number },
  { frame, view, data, history, screens, images = "" }: PageParts,
): string {
  const body = `<body data-variant="${escapeAttribute(first.variant.id)}" data-revision="${first.revision}" data-platform="${escapeAttribute(frame.platform)}" data-orientation="${frame.orientation}"${frame.posture === undefined ? "" : ` data-posture="${escapeAttribute(frame.posture)}"`}${prototypeWeb3dBodyAttributes(frame.fold)}>${toHtml(toolbar(input, first.variant, screens, frame))}<div data-main=""><div data-viewport="" aria-label="Device preview"><div data-stage="">${view}</div></div>${history ? toHtml(history) : ""}</div><script type="application/json" data-prototype-page="">${prototypeWebPageJson(data)}</script><script>${PROTOTYPE_WEB_PAGE_SCRIPT}</script></body>`;
  const head = `<head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${cspFor(PROTOTYPE_WEB_PAGE_SCRIPT)}"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="icon" href="data:,"><title>${toHtml(input.title)}</title><style>${PAGE_CSS}${images}</style></head>`;
  return `<!doctype html><html lang="en">${head}${body}</html>\n`;
}

/**
 * One self-contained HTML page (#16346): the prototype in a device frame with animated rotate
 * (#16545), an opt-in 3D view (#16458), zoom and pan, a variant switcher and revision history. The
 * page inlines its revisions as spec JSON and one script, the page bundle, which draws each view in
 * the browser when it is first shown (#16528); the host draws only the view shown first. No
 * network: the CSP allows only that script, inline styles and `data:` images and fonts. The same
 * input yields the same bytes.
 */
export function buildPrototypeWebPage(input: PrototypeWebPageInput): PrototypeWebPage {
  return withActionableWebInput(() => assemblePrototypeWebPage(input));
}

/** The page's data for these revisions: their specs, and every glyph any of them drew. */
function pageData(
  input: PrototypeWebPageInput,
  frame: string,
  imageSlots: readonly string[],
  revisions: readonly RevisionViews[],
): PrototypeWebPageData {
  const glyphs = new Map(revisions.flatMap((revision) => [...revision.glyphs]));
  return {
    frame,
    ...(input.mode === undefined ? {} : { mode: input.mode }),
    ...(input.nowMs === undefined ? {} : { nowMs: input.nowMs }),
    ...(input.locale === undefined ? {} : { locale: input.locale }),
    ...(input.textSize === undefined ? {} : { textSize: input.textSize }),
    imageSlots,
    glyphs: Object.fromEntries([...glyphs].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
    revisions: revisions.map(dataEntry),
  };
}

function assemblePrototypeWebPage(input: PrototypeWebPageInput): PrototypeWebPage {
  const chosen = chooseVariant(input);
  const device = deviceFrameOrThrow(
    input.frame ?? defaultDeviceFrameId(input.platform ?? "android"),
  );
  const orientations = frameOrientations(device);
  const posture = defaultFramePosture(device);
  const postures = framePostures(device);
  const pageFrame: PageFrame = {
    platform: device.platform,
    orientation: orientations[0]!,
    rotates: orientations.length > 1,
    fold: prototypeWebFold(device),
    postures,
    ...(posture === undefined ? {} : { posture }),
  };
  // The default posture first, so a revision's first view is the one the page shows first.
  const frame: ViewFrame = {
    id: device.id,
    orientations,
    postures:
      posture === undefined ? [undefined] : [posture, ...postures.filter((p) => p !== posture)],
  };
  const shown = { variant: chosen, revision: input.revision ?? chosen.revisions.at(-1)!.revision };
  // The shell lists only the pinned revisions (each latest and the one shown first), which are
  // always kept; older entries are charged to their own revision in the budget.
  const pinned: Pinned = (variant, revision) =>
    (variant === chosen.id && revision === shown.revision) ||
    input.variants.some(
      (entry) => entry.id === variant && entry.revisions.at(-1)?.revision === revision,
    );
  const rules = imageRules(input.images ?? []);
  const slots = new Map([...rules.keys()].map((id, slot) => [id, slot]));
  const imageSlots = [...rules.keys()];
  // Every view is drawn here too: the budget reads the images they draw and the picker their screens.
  const rendered = input.variants.flatMap((variant) =>
    renderViews({ ...input, slots }, frame, variant),
  );
  const isShown = (revision: RevisionViews) =>
    revision.variant === chosen.id && revision.revision === shown.revision;
  const isPinned = (revision: RevisionViews) => pinned(revision.variant, revision.revision);
  const shownRevision = rendered.find(isShown);
  const first = shownRevision?.screens[0]?.find(
    (view) => view.orientation === pageFrame.orientation && view.posture === posture,
  );
  if (!shownRevision || !first) {
    throw new ActionableError(
      `Revision ${shown.revision} of variant ${chosen.id} is not in the page. Revisions: ${rendered
        .filter((revision) => revision.variant === chosen.id)
        .map((revision) => revision.revision)
        .join(", ")}`,
    );
  }
  // The first view is shown, so its `hidden` attribute is dropped.
  const view = first.html.replace(' hidden=""', "");
  // The shell's picker lists every screen of the shown revision, which the budget always keeps.
  const shellBytes = Buffer.byteLength(
    pageHtml(input, shown, {
      frame: pageFrame,
      view,
      data: pageData(input, device.id, imageSlots, []),
      history: revisionHistory(input, pinned, true),
      screens: pickerFor(rendered, shown),
    }),
  );
  const budgeted = budgetedRevisions(input, rendered, shellBytes, { pinned, isShown, rules });
  const { revisions } = budgeted;
  const inlined = new Set(budgeted.images);
  const kept = new Set(
    revisions.map((revision) => `${revision.variant}\u0000${revision.revision}`),
  );
  const html = pageHtml(input, shown, {
    frame: pageFrame,
    view,
    data: pageData(input, device.id, imageSlots, revisions),
    history: revisionHistory(input, (variant, revision) => kept.has(`${variant}\u0000${revision}`)),
    screens: pickerFor(revisions, shown),
    images: budgeted.images.map((id) => rules.get(id)!).join(""),
  });
  const inlinedRevisions = Object.fromEntries(
    input.variants.map((variant) => [
      variant.id,
      revisions
        .filter((revision) => revision.variant === variant.id)
        .map((revision) => revision.revision),
    ]),
  );
  return {
    html,
    sha256: createHash("sha256").update(html).digest("hex"),
    frame: device.id,
    // An image whose asset the page inlined is drawn, not a placeholder.
    unsupportedNodes: first.unsupported.filter(
      (node) => !(node.reason === "assetOverBudget" && inlined.has(node.asset ?? "")),
    ),
    inlinedRevisions,
    imageRequests: imageRequests(rendered, isShown, isPinned, device.id),
    inlinedImages: budgeted.images,
  };
}
