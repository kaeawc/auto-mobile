import { createHash } from "node:crypto";
import { ActionableError } from "../../../models";
import type { PrototypeColorMode } from "../prototypeContrast";
import { defaultDeviceFrameId, deviceFrameOrThrow } from "./deviceFrames";
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
import type { WebOrientation } from "./webFrame";
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
  prototypeWebWheelFactor,
  prototypeWebZoomScale,
} from "./webPageRuntime";
import { renderPrototypeStill } from "./webStill";
import type { UnsupportedWebNode } from "./webRender";
import type { WebStackScreens } from "./webStack";

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
  /** Total page budget; defaults to MAX_PROTOTYPE_WEB_PAGE_BYTES. */
  readonly maxBytes?: number;
}

export interface PrototypeWebPage {
  readonly html: string;
  readonly sha256: string;
  readonly frame: string;
  /** Unsupported nodes of the view shown first. */
  readonly unsupportedNodes: readonly UnsupportedWebNode[];
  /** Revisions inlined per variant, newest first; older ones are not in the page. */
  readonly inlinedRevisions: Readonly<Record<string, readonly number[]>>;
}

const RUNTIME_2D = `(${prototypeWebPageRuntime.toString()})({ zoomScale: ${prototypeWebZoomScale.toString()}, fitScale: ${prototypeWebFitScale.toString()}, wheelFactor: ${prototypeWebWheelFactor.toString()}, screenView: ${prototypeWebScreenView.toString()}, rotation: ${prototypeWebRotation.toString()}, animateTurn: ${prototypeWebAnimateTurn.toString()}, clockText: ${prototypeWebClockText.toString()}, clockDelay: ${prototypeWebClockDelay.toString()}, startClock: ${prototypeWebStartClock.toString()}, browserClock: ${prototypeWebBrowserClock.toString()} });`;
/** The opt-in 3D view (#16458) runs after the 2D runtime, so its pan handler is already bound. */
const RUNTIME_3D = `(${prototypeWeb3dRuntime.toString()})({ pose: ${prototypeWebPose.toString()}, orbit: ${prototypeWebOrbit.toString()}, hingeLine: ${prototypeWebHingeLine.toString()}, postureAt: ${prototypeWebPostureAt.toString()}, wrap: ${prototypeWeb3dWrap.toString()}, unwrap: ${prototypeWeb3dUnwrap.toString()}, bodyHinge: ${prototypeWeb3dBodyHinge.toString()}, orbitKey: ${prototypeWebOrbitKey.toString()}, dragOrbit: ${prototypeWeb3dDragOrbit.toString()}, leaves: ${prototypeWebLeaves.toString()}, flat: ${JSON.stringify(PROTOTYPE_WEB_FLAT_ORBIT)}, start: ${JSON.stringify(PROTOTYPE_WEB_START_ORBIT)} });`;
/** The page's script, whose hash the CSP pins. At most 150 KB uncompressed. */
export const PROTOTYPE_WEB_RUNTIME = `${RUNTIME_2D}\n${RUNTIME_3D}`;
export const MAX_PROTOTYPE_WEB_RUNTIME_BYTES = 150 * 1024;
export const MAX_PROTOTYPE_WEB_PAGE_BYTES = 2 * 1024 * 1024;

const ORIENTATIONS: readonly WebOrientation[] = ["portrait", "landscape"];

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
  /** The outermost stack's screen this view draws; only a multi-screen stack sets it. */
  readonly screen?: string;
  readonly html: string;
  readonly unsupported: readonly UnsupportedWebNode[];
}

/** One screen of one revision in both orientations: the unit the budget keeps or drops. */
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

function renderView(
  input: PrototypeWebPageInput,
  frame: string,
  at: { variant: string; revision: PrototypeWebRevision; screen?: string },
  orientation: WebOrientation,
): RenderedView & { stack?: WebStackScreens } {
  const still = renderPrototypeStill(at.revision.spec, {
    frame,
    orientation,
    mode: input.mode,
    nowMs: input.nowMs,
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
    ...(at.screen === undefined ? {} : { screen: at.screen }),
    html: toHtml(view),
    unsupported: still.unsupportedNodes,
    ...(still.stack ? { stack: still.stack } : {}),
  };
}

/**
 * Each revision newest first, one group of both orientations per screen of its outermost stack
 * (just one group without a multi-screen stack). The default portrait still finds the screens.
 */
function renderViews(
  input: PrototypeWebPageInput,
  frame: string,
  variant: PrototypeWebVariant,
): RevisionViews[] {
  return [...variant.revisions].reverse().map((revision) => {
    const probe = renderView(input, frame, { variant: variant.id, revision }, "portrait");
    const screens = pickerScreens(probe.stack);
    const groups =
      screens.length === 0
        ? [[probe, renderView(input, frame, { variant: variant.id, revision }, "landscape")]]
        : screens.map((screen) =>
            ORIENTATIONS.map((orientation) =>
              renderView(input, frame, { variant: variant.id, revision, screen }, orientation),
            ),
          );
    return { variant: variant.id, revision: revision.revision, screens: groups };
  });
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

/** Watches and TVs never rotate (prototype-web-frames-v2.md); every other form factor does. */
export function prototypeWebFrameRotates(formFactor: string): boolean {
  return formFactor !== "watch" && formFactor !== "tv";
}

/** The frame facts the page shell needs: the platform's rotation and whether the device rotates. */
interface PageFrame {
  readonly platform: string;
  /** A device that never rotates gets no rotate control. */
  readonly rotates: boolean;
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

/**
 * The pinned revisions' start screens always; then their other screens while they fit; then older
 * revisions newest first, each while its start screen and history entry fit, followed by its other
 * screens while they fit. The budget is the page limit minus the shell (head, toolbar, script and
 * the pinned revisions' history entries), so it counts exactly what the final page holds.
 */
function budgetedViews(
  input: PrototypeWebPageInput,
  revisions: readonly RevisionViews[],
  shellBytes: number,
  pinned: Pinned,
): RevisionViews[] {
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
  const kept = new Map(latest.map((revision) => [revision, [revision.screens[0]!]]));
  const addScreens = (revision: RevisionViews) =>
    kept
      .get(revision)!
      .push(...revision.screens.slice(1).filter((group) => fits(groupBytes(group))));
  latest.forEach(addScreens);
  for (const revision of revisions.filter((entry) => !isPinned(entry))) {
    const history = historyEntryBytes(input, revision.variant, revision.revision);
    if (fits(groupBytes(revision.screens[0]!) + history)) {
      kept.set(revision, [revision.screens[0]!]);
      addScreens(revision);
    }
  }
  // Keep the page's own order: variants in input order, revisions newest first, start first.
  return revisions
    .filter((revision) => kept.has(revision))
    .map((revision) => ({ ...revision, screens: kept.get(revision)! }));
}

/**
 * The picker for a page holding these revisions: none unless one of them has a multi-screen stack,
 * else the shown revision's screens (none or one hide it; the runtime lists each revision's own).
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
  return (current?.screens ?? []).flatMap((group) => (group[0]?.screen ? [group[0].screen] : []));
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

interface PageParts {
  readonly frame: PageFrame;
  readonly views: string;
  readonly history: WebElement | undefined;
  readonly screens: ScreenPicker;
}

function pageHtml(
  input: PrototypeWebPageInput,
  first: { variant: PrototypeWebVariant; revision: number },
  { frame, views, history, screens }: PageParts,
): string {
  const body = `<body data-variant="${escapeAttribute(first.variant.id)}" data-revision="${first.revision}" data-platform="${escapeAttribute(frame.platform)}"${prototypeWeb3dBodyAttributes(frame.fold)}>${toHtml(toolbar(input, first.variant, screens, frame))}<div data-main=""><div data-viewport="" aria-label="Device preview"><div data-stage="">${views}</div></div>${history ? toHtml(history) : ""}</div><script>${PROTOTYPE_WEB_RUNTIME}</script></body>`;
  const head = `<head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${cspFor(PROTOTYPE_WEB_RUNTIME)}"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${toHtml(input.title)}</title><style>${PAGE_CSS}</style></head>`;
  return `<!doctype html><html lang="en">${head}${body}</html>\n`;
}

/**
 * One self-contained HTML page (#16346): the prototype in a device frame with animated rotate
 * (#16545), an opt-in 3D view (#16458), zoom and pan, a variant switcher and revision history. Every view is pre-rendered; the inlined script
 * only switches between them. No network: the CSP allows only that script, inline styles and
 * `data:` images and fonts. The same input yields the same bytes.
 */
export function buildPrototypeWebPage(input: PrototypeWebPageInput): PrototypeWebPage {
  const chosen = chooseVariant(input);
  const device = deviceFrameOrThrow(
    input.frame ?? defaultDeviceFrameId(input.platform ?? "android"),
  );
  const frame = device.id;
  const pageFrame: PageFrame = {
    platform: device.platform,
    rotates: prototypeWebFrameRotates(device.formFactor),
    fold: prototypeWebFold(device),
  };
  const shown = { variant: chosen, revision: input.revision ?? chosen.revisions.at(-1)!.revision };
  // The shell lists only the pinned revisions (each latest and the one shown first), which are
  // always kept; older entries are charged to their own revision in the budget.
  const pinned: Pinned = (variant, revision) =>
    (variant === chosen.id && revision === shown.revision) ||
    input.variants.some(
      (entry) => entry.id === variant && entry.revisions.at(-1)?.revision === revision,
    );
  const rendered = input.variants.flatMap((variant) => renderViews(input, frame, variant));
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
  const revisions = budgetedViews(input, rendered, shellBytes, pinned);
  const views = revisions.flatMap((revision) => revision.screens.flat());
  const first = views.find(
    (view) =>
      view.variant === chosen.id &&
      view.revision === shown.revision &&
      view.orientation === "portrait",
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
    frame,
    unsupportedNodes: first.unsupported,
    inlinedRevisions,
  };
}
