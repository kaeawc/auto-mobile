import { createHash } from "node:crypto";
import { ActionableError } from "../../../models";
import { logger } from "../../../utils/logger";
import { materialIconGlyphs } from "./materialIconGlyphs";
import type { PrototypeColorMode } from "../prototypeContrast";
import { defaultDeviceFrameId, deviceFrameOrThrow } from "./deviceFrames";
import { withActionableWebInput } from "./prototypeWebInputActionable";
import {
  PROTOTYPE_WEB_3D_CSS,
  PROTOTYPE_WEB_FLAT_ORBIT,
  PROTOTYPE_WEB_START_ORBIT,
  prototypeWeb3dBodyAttributes,
  prototypeWeb3dBodyHinge,
  prototypeWeb3dControls,
  prototypeWeb3dDragOrbit,
  prototypeWeb3dRuntime,
  prototypeWeb3dUnwrap,
  prototypeWeb3dWrap,
  prototypeWebFold,
  prototypeWebHingeLine,
  prototypeWebLeaves,
  prototypeWebOrbit,
  prototypeWebOrbitKey,
  prototypeWebPose,
  prototypeWebPostureAt,
  type PrototypeWebFold,
} from "./webDevice3d";
import { defaultFramePosture, framePostures } from "./webFold";
import { frameOrientations, type WebOrientation } from "./webFrame";
import { el, escapeAttribute, toHtml, type WebElement } from "./webNodes";
import {
  prototypeWebAnimateTurn,
  prototypeWebBrowserClock,
  prototypeWebClockDelay,
  prototypeWebClockText,
  prototypeWebFitScale,
  prototypeWebPageRuntime,
  prototypeWebRotation,
  prototypeWebScreenView,
  prototypeWebStartClock,
  prototypeWebViewMatches,
  prototypeWebWheelFactor,
  prototypeWebZoomScale,
} from "./webPageRuntime";
import { renderPrototypeStill } from "./webStill";
import { FADE_EDGES_PAGE_CSS } from "./webStylePolish";
import type { UnsupportedWebNode } from "./webRender";
import type { WebStackScreens } from "./webStack";
import {
  webImageBox,
  webImageRule,
  type PrototypeWebImage,
  type WebImageBox,
  type WebImageDraw,
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
  /** Encoded assets the page inlines while the budget allows; the first entry per id counts. */
  readonly images?: readonly PrototypeWebImage[];
}

/** An asset the page draws and the pixel boxes it is drawn in, to encode it at the right size. */
export interface PrototypeWebImageRequest {
  readonly id: string;
  readonly boxes: readonly WebImageBox[];
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

const RUNTIME_2D = `(${prototypeWebPageRuntime.toString()})({ zoomScale: ${prototypeWebZoomScale.toString()}, fitScale: ${prototypeWebFitScale.toString()}, wheelFactor: ${prototypeWebWheelFactor.toString()}, screenView: ${prototypeWebScreenView.toString()}, viewMatches: ${prototypeWebViewMatches.toString()}, rotation: ${prototypeWebRotation.toString()}, animateTurn: ${prototypeWebAnimateTurn.toString()}, clockText: ${prototypeWebClockText.toString()}, clockDelay: ${prototypeWebClockDelay.toString()}, startClock: ${prototypeWebStartClock.toString()}, browserClock: ${prototypeWebBrowserClock.toString()} });`;
/** The opt-in 3D view (#16458) runs after the 2D runtime, so its pan handler is already bound. */
const RUNTIME_3D = `(${prototypeWeb3dRuntime.toString()})({ pose: ${prototypeWebPose.toString()}, orbit: ${prototypeWebOrbit.toString()}, hingeLine: ${prototypeWebHingeLine.toString()}, postureAt: ${prototypeWebPostureAt.toString()}, wrap: ${prototypeWeb3dWrap.toString()}, unwrap: ${prototypeWeb3dUnwrap.toString()}, bodyHinge: ${prototypeWeb3dBodyHinge.toString()}, orbitKey: ${prototypeWebOrbitKey.toString()}, dragOrbit: ${prototypeWeb3dDragOrbit.toString()}, leaves: ${prototypeWebLeaves.toString()}, flat: ${JSON.stringify(PROTOTYPE_WEB_FLAT_ORBIT)}, start: ${JSON.stringify(PROTOTYPE_WEB_START_ORBIT)} });`;
/** The page's script, whose hash the CSP pins. At most 150 KB uncompressed. */
export const PROTOTYPE_WEB_RUNTIME = `${RUNTIME_2D}\n${RUNTIME_3D}`;
export const MAX_PROTOTYPE_WEB_RUNTIME_BYTES = 150 * 1024;
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

interface RenderedView {
  readonly variant: string;
  readonly revision: number;
  readonly orientation: WebOrientation;
  /** The foldable posture this view draws; absent for a frame without postures. */
  readonly posture?: string;
  /** The outermost stack's screen this view draws; only a multi-screen stack sets it. */
  readonly screen?: string;
  readonly html: string;
  readonly unsupported: readonly UnsupportedWebNode[];
  readonly draws: readonly WebImageDraw[];
}

/**
 * One screen of one revision in each of the frame's orientations and every posture: the unit the
 * budget keeps or drops.
 */
type ScreenGroup = readonly RenderedView[];

/** One revision's screen groups, its start screen first. */
interface RevisionViews {
  readonly variant: string;
  readonly revision: number;
  readonly screens: readonly ScreenGroup[];
}

/**
 * The screens the picker offers for a still's outermost stack: its start, then the others in
 * key order. A stack with one screen, or a start that is not one of them, offers none.
 */
function pickerScreens(stack: WebStackScreens | undefined): string[] {
  if (!stack || stack.screens.length < 2 || !stack.screens.includes(stack.start)) {
    return [];
  }
  return [stack.start, ...stack.screens.filter((screen) => screen !== stack.start)];
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

/** Where a view sits among the page's dimensions besides variant and revision. */
interface ViewAt {
  readonly orientation: WebOrientation;
  readonly posture: string | undefined;
}

function renderView(
  input: PrototypeWebPageInput & { readonly slots: ReadonlyMap<string, number> },
  frame: string,
  at: { variant: string; revision: PrototypeWebRevision; screen?: string },
  { orientation, posture }: ViewAt,
): RenderedView & { stack?: WebStackScreens } {
  const still = renderPrototypeStill(at.revision.spec, {
    frame,
    orientation,
    ...(posture === undefined ? {} : { posture }),
    mode: input.mode,
    nowMs: input.nowMs,
    imageSlots: input.slots,
    ...(input.locale === undefined ? {} : { locale: input.locale }),
    ...(input.textSize === undefined ? {} : { textSize: input.textSize }),
    logger,
    glyphs: materialIconGlyphs(),
    ...(at.screen === undefined ? {} : { screen: at.screen }),
  });
  const view = el(
    "div",
    {
      attrs: {
        "data-view": "",
        "data-variant": at.variant,
        "data-revision": String(at.revision.revision),
        "data-orientation": orientation,
        ...(posture === undefined ? {} : { "data-posture": posture }),
        ...(at.screen === undefined ? {} : { "data-screen": at.screen }),
        hidden: "",
      },
    },
    [still.element],
  );
  return {
    variant: at.variant,
    revision: at.revision.revision,
    orientation,
    ...(posture === undefined ? {} : { posture }),
    ...(at.screen === undefined ? {} : { screen: at.screen }),
    html: toHtml(view),
    unsupported: still.unsupportedNodes,
    draws: still.imageDraws,
    ...(still.stack ? { stack: still.stack } : {}),
  };
}

/** Every posture and orientation, the default posture's first orientation first. */
function viewPoints(frame: ViewFrame): ViewAt[] {
  return frame.postures.flatMap((posture) =>
    frame.orientations.map((orientation) => ({ orientation, posture })),
  );
}

/**
 * One orientation and posture's views of a revision: its start view first, then its other screens.
 * Each still finds its own stack, since a `visibleWhen` on orientation or posture can show a
 * different stack (or none) in each.
 */
function pointViews(
  input: PrototypeWebPageInput & { readonly slots: ReadonlyMap<string, number> },
  frame: string,
  at: { variant: string; revision: PrototypeWebRevision },
  point: ViewAt,
): RenderedView[] {
  const probe = renderView(input, frame, at, point);
  const screens = pickerScreens(probe.stack);
  return screens.length === 0
    ? [probe]
    : screens.map((screen) => renderView(input, frame, { ...at, screen }, point));
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
    const perPoint = viewPoints(frame).map((point) => pointViews(input, frame.id, at, point));
    const count = Math.max(...perPoint.map((views) => views.length));
    const groups = Array.from({ length: count }, (_, index) =>
      perPoint.flatMap((views) => views.slice(index, index + 1)),
    );
    return { variant: variant.id, revision: revision.revision, screens: groups };
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

const groupBytes = (group: ScreenGroup) =>
  group.reduce((sum, view) => sum + Buffer.byteLength(view.html), 0);

/** The first view is shown, so its `hidden` attribute is dropped from the page. */
const HIDDEN_ATTRIBUTE_BYTES = Buffer.byteLength(' hidden=""');

/** The view of these groups with the most HTML bytes. */
export function largestPinnedView<V extends { readonly html: string }>(
  groups: readonly (readonly V[])[],
): V {
  return groups
    .flat()
    .reduce((largest, view) =>
      Buffer.byteLength(view.html) > Buffer.byteLength(largest.html) ? view : largest,
    );
}

function refuseOverBudget(limit: number, pinned: readonly RevisionViews[]): never {
  const largest = largestPinnedView(pinned.map((revision) => revision.screens[0]!));
  throw new ActionableError(
    `The prototype web page would exceed ${limit} bytes even with only the latest revision of each variant and the revision shown first. Largest view: variant ${largest.variant} revision ${largest.revision} (${Buffer.byteLength(largest.html)} bytes). Reduce the spec's repeated content or show fewer variants.`,
  );
}

/** What the budget kept: revisions with their screens, and the inlined assets in slot order. */
interface Budgeted {
  readonly revisions: RevisionViews[];
  readonly images: readonly string[];
}

/** Assets a revision's kept screens draw, in view and tree order, each once. */
function drawnAssets(groups: readonly ScreenGroup[]): string[] {
  return [
    ...new Set(groups.flatMap((group) => group.flatMap((view) => view.draws.map((d) => d.asset)))),
  ];
}

/**
 * The pinned revisions' start screens always, then the images they draw; then each of their other
 * screens while it fits, followed by its images; then older revisions newest first, each while its
 * start screen and history entry fit, followed by its images, then its other screens in the same
 * way. Each image is charged once, as the page rule that inlines it; one that does not fit stays a
 * placeholder. The shown revision's images go first among the pinned. The budget is the page limit
 * minus the shell (head, toolbar, script and the pinned revisions' history entries), so it counts
 * exactly what the final page holds.
 */
function budgetedViews(
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
  let room = limit - shellBytes + HIDDEN_ATTRIBUTE_BYTES;
  const fits = (cost: number) => {
    const fit = cost <= room;
    room -= fit ? cost : 0;
    return fit;
  };
  const isPinned = (revision: RevisionViews) => pinned(revision.variant, revision.revision);
  const latest = revisions.filter(isPinned);
  if (!fits(latest.reduce((sum, revision) => sum + groupBytes(revision.screens[0]!), 0))) {
    refuseOverBudget(limit, latest);
  }
  const images = new Set<string>();
  const considered = new Set<string>();
  const addImages = (groups: readonly ScreenGroup[]) => {
    for (const asset of drawnAssets(groups)) {
      const rule = rules.get(asset);
      if (rule !== undefined && !considered.has(asset)) {
        considered.add(asset);
        if (fits(Buffer.byteLength(rule))) {
          images.add(asset);
        }
      }
    }
  };
  const kept = new Map(latest.map((revision) => [revision, [revision.screens[0]!]]));
  // Each screen's images are charged before the next screen, so a later screen cannot take the
  // room an earlier kept screen's image needs.
  const addScreens = (revision: RevisionViews) => {
    for (const group of revision.screens.slice(1)) {
      if (fits(groupBytes(group))) {
        kept.get(revision)!.push(group);
        addImages([group]);
      }
    }
  };
  [...latest.filter(isShown), ...latest.filter((revision) => !isShown(revision))].forEach(
    (revision) => addImages([revision.screens[0]!]),
  );
  latest.forEach(addScreens);
  for (const revision of revisions.filter((entry) => !isPinned(entry))) {
    const history = historyEntryBytes(input, revision.variant, revision.revision);
    if (fits(groupBytes(revision.screens[0]!) + history)) {
      kept.set(revision, [revision.screens[0]!]);
      addImages([revision.screens[0]!]);
      addScreens(revision);
    }
  }
  // Keep the page's own order: variants in input order, revisions newest first, start first.
  return {
    revisions: revisions
      .filter((revision) => kept.has(revision))
      .map((revision) => ({ ...revision, screens: kept.get(revision)! })),
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
  const boxes = new Map<string, Map<string, WebImageBox>>();
  for (const revision of ordered) {
    for (const draw of revision.screens.flat().flatMap((view) => view.draws)) {
      const box = webImageBox(draw, screen);
      const forAsset = boxes.get(draw.asset) ?? new Map<string, WebImageBox>();
      forAsset.set(JSON.stringify(box), box);
      boxes.set(draw.asset, forAsset);
    }
  }
  return [...boxes].map(([id, unique]) => ({ id, boxes: [...unique.values()] }));
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
  readonly views: string;
  /** Rules that inline the page's images, in slot order. */
  readonly images?: string;
  readonly history: WebElement | undefined;
  readonly screens: ScreenPicker;
}

function pageHtml(
  input: PrototypeWebPageInput,
  first: { variant: PrototypeWebVariant; revision: number },
  { frame, views, history, screens, images = "" }: PageParts,
): string {
  const body = `<body data-variant="${escapeAttribute(first.variant.id)}" data-revision="${first.revision}" data-platform="${escapeAttribute(frame.platform)}" data-orientation="${frame.orientation}"${frame.posture === undefined ? "" : ` data-posture="${escapeAttribute(frame.posture)}"`}${prototypeWeb3dBodyAttributes(frame.fold)}>${toHtml(toolbar(input, first.variant, screens, frame))}<div data-main=""><div data-viewport="" aria-label="Device preview"><div data-stage="">${views}</div></div>${history ? toHtml(history) : ""}</div><script>${PROTOTYPE_WEB_RUNTIME}</script></body>`;
  const head = `<head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${cspFor(PROTOTYPE_WEB_RUNTIME)}"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="icon" href="data:,"><title>${toHtml(input.title)}</title><style>${PAGE_CSS}${images}</style></head>`;
  return `<!doctype html><html lang="en">${head}${body}</html>\n`;
}

/**
 * One self-contained HTML page (#16346): the prototype in a device frame with animated rotate
 * (#16545), an opt-in 3D view (#16458), zoom and pan, a variant switcher and revision history. Every view is pre-rendered; the inlined script
 * only switches between them. No network: the CSP allows only that script, inline styles and
 * `data:` images and fonts. The same input yields the same bytes.
 */
export function buildPrototypeWebPage(input: PrototypeWebPageInput): PrototypeWebPage {
  return withActionableWebInput(() => assemblePrototypeWebPage(input));
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
  const rendered = input.variants.flatMap((variant) =>
    renderViews({ ...input, slots }, frame, variant),
  );
  const isShown = (revision: RevisionViews) =>
    revision.variant === chosen.id && revision.revision === shown.revision;
  const isPinned = (revision: RevisionViews) => pinned(revision.variant, revision.revision);
  // The shell's picker lists every screen of the shown revision. A dropped screen removes an
  // option longer than the `hidden` attribute it may add, so the page never outgrows the budget.
  const shellBytes = Buffer.byteLength(
    pageHtml(input, shown, {
      frame: pageFrame,
      views: "",
      history: revisionHistory(input, pinned, true),
      screens: pickerFor(rendered, shown),
    }),
  );
  const budgeted = budgetedViews(input, rendered, shellBytes, { pinned, isShown, rules });
  const { revisions } = budgeted;
  const inlined = new Set(budgeted.images);
  const views = revisions.flatMap((revision) => revision.screens.flat());
  const first = views.find(
    (view) =>
      view.variant === chosen.id &&
      view.revision === shown.revision &&
      view.orientation === pageFrame.orientation &&
      view.posture === posture,
  );
  if (!first) {
    throw new ActionableError(
      `Revision ${shown.revision} of variant ${chosen.id} is not in the page. Inlined revisions: ${revisions
        .filter((revision) => revision.variant === chosen.id)
        .map((revision) => revision.revision)
        .join(", ")}`,
    );
  }
  const viewsHtml = views
    .map((view) => (view === first ? view.html.replace(' hidden=""', "") : view.html))
    .join("");
  const kept = new Set(
    revisions.map((revision) => `${revision.variant}\u0000${revision.revision}`),
  );
  const html = pageHtml(input, shown, {
    frame: pageFrame,
    views: viewsHtml,
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
