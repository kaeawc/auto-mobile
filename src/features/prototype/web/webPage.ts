import { createHash } from "node:crypto";
import { ActionableError } from "../../../models";
import type { PrototypeColorMode } from "../prototypeContrast";
import { defaultDeviceFrameId, deviceFrameOrThrow } from "./deviceFrames";
import type { WebOrientation } from "./webFrame";
import { el, escapeAttribute, toHtml, type WebElement } from "./webNodes";
import {
  prototypeWebFitScale,
  prototypeWebPageRuntime,
  prototypeWebWheelFactor,
  prototypeWebZoomScale,
} from "./webPageRuntime";
import { renderPrototypeStill } from "./webStill";
import type { UnsupportedWebNode } from "./webRender";

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

/** The page's script, whose hash the CSP pins. At most 150 KB uncompressed. */
export const PROTOTYPE_WEB_RUNTIME = `(${prototypeWebPageRuntime.toString()})({ zoomScale: ${prototypeWebZoomScale.toString()}, fitScale: ${prototypeWebFitScale.toString()}, wheelFactor: ${prototypeWebWheelFactor.toString()} });`;
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
  "[hidden]{display:none!important}",
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
  readonly html: string;
  readonly unsupported: readonly UnsupportedWebNode[];
}

function renderViews(input: PrototypeWebPageInput, frame: string, variant: PrototypeWebVariant) {
  return [...variant.revisions].reverse().map((revision) =>
    ORIENTATIONS.map((orientation): RenderedView => {
      const still = renderPrototypeStill(revision.spec, {
        frame,
        orientation,
        mode: input.mode,
        nowMs: input.nowMs,
      });
      const view = el(
        "div",
        {
          attrs: {
            "data-view": "",
            "data-variant": variant.id,
            "data-revision": String(revision.revision),
            "data-orientation": orientation,
            hidden: "",
          },
        },
        [still.element],
      );
      return {
        variant: variant.id,
        revision: revision.revision,
        orientation,
        html: toHtml(view),
        unsupported: still.unsupportedNodes,
      };
    }),
  );
}

function toolbar(input: PrototypeWebPageInput, chosen: PrototypeWebVariant): WebElement {
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
      button("rotate", "Rotate device", "Rotate"),
      button("zoom-out", "Zoom out", "−"),
      el("span", { attrs: { "data-control": "zoom-level", "aria-live": "polite" } }, ["100%"]),
      button("zoom-in", "Zoom in", "+"),
      button("zoom-fit", "Fit to window", "Fit"),
      ...variants,
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

function revisionHistory(
  input: PrototypeWebPageInput,
  included: (variant: string, revision: number) => boolean,
): WebElement {
  const items = input.variants.flatMap((variant) =>
    [...variant.revisions]
      .reverse()
      .filter((revision) => included(variant.id, revision.revision))
      .map((revision) => historyEntry(variant.id, revision)),
  );
  return el(
    "ul",
    { attrs: { "data-control": "revisions", "aria-label": "Revision history" } },
    items,
  );
}

function isLatest(input: PrototypeWebPageInput, group: readonly RenderedView[]): boolean {
  return input.variants.some(
    (variant) =>
      variant.id === group[0]?.variant && variant.revisions.at(-1)?.revision === group[0].revision,
  );
}

const groupBytes = (group: readonly RenderedView[]) =>
  group.reduce((sum, view) => sum + Buffer.byteLength(view.html), 0);

/** The first view is shown, so its `hidden` attribute is dropped from the page. */
const HIDDEN_ATTRIBUTE_BYTES = Buffer.byteLength(' hidden=""');

/**
 * Every variant's latest revision, then older revisions newest first while they fit. The budget
 * is the page limit minus the shell (head, toolbar, script and the latest revisions' history
 * entries); an older revision costs its views plus its own history entry, so the budget counts
 * exactly what the final page holds.
 */
function budgetedViews(input: PrototypeWebPageInput, frame: string, shellBytes: number) {
  const groups = input.variants.flatMap((variant) => renderViews(input, frame, variant));
  const limit = input.maxBytes ?? MAX_PROTOTYPE_WEB_PAGE_BYTES;
  const budget = limit - shellBytes + HIDDEN_ATTRIBUTE_BYTES;
  const latest = groups.filter((group) => isLatest(input, group));
  let used = latest.reduce((sum, group) => sum + groupBytes(group), 0);
  if (used > budget) {
    const largest = [...latest].sort((a, b) => groupBytes(b) - groupBytes(a))[0]![0]!;
    throw new ActionableError(
      `The prototype web page would exceed ${limit} bytes even with only the latest revision of each variant. Largest view: variant ${largest.variant} revision ${largest.revision} (${Buffer.byteLength(largest.html)} bytes). Reduce the spec's repeated content or show fewer variants.`,
    );
  }
  const older = groups.filter((group) => !isLatest(input, group));
  const kept = new Set(latest);
  for (const group of older) {
    const cost =
      groupBytes(group) + historyEntryBytes(input, group[0]!.variant, group[0]!.revision);
    if (used + cost <= budget) {
      kept.add(group);
      used += cost;
    }
  }
  // Keep the page's own order: variants in input order, revisions newest first.
  return groups.filter((group) => kept.has(group));
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

function pageHtml(
  input: PrototypeWebPageInput,
  first: { variant: PrototypeWebVariant; revision: number },
  views: string,
  history: WebElement,
): string {
  const body = `<body data-variant="${escapeAttribute(first.variant.id)}" data-revision="${first.revision}">${toHtml(toolbar(input, first.variant))}<div data-main=""><div data-viewport="" aria-label="Device preview"><div data-stage="">${views}</div></div>${toHtml(history)}</div><script>${PROTOTYPE_WEB_RUNTIME}</script></body>`;
  const head = `<head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${cspFor(PROTOTYPE_WEB_RUNTIME)}"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${toHtml(input.title)}</title><style>${PAGE_CSS}</style></head>`;
  return `<!doctype html><html lang="en">${head}${body}</html>\n`;
}

/**
 * One self-contained HTML page (#16346): the prototype in a device frame with rotate, zoom and
 * pan, a variant switcher and revision history. Every view is pre-rendered; the inlined script
 * only switches between them. No network: the CSP allows only that script, inline styles and
 * `data:` images and fonts. The same input yields the same bytes.
 */
export function buildPrototypeWebPage(input: PrototypeWebPageInput): PrototypeWebPage {
  const chosen = chooseVariant(input);
  const frame = deviceFrameOrThrow(
    input.frame ?? defaultDeviceFrameId(input.platform ?? "android"),
  ).id;
  const shown = { variant: chosen, revision: input.revision ?? chosen.revisions.at(-1)!.revision };
  // The shell lists only the latest revisions, which are always kept; older entries are charged
  // to their own revision in the budget.
  const latestRevision = (variant: string, revision: number) =>
    input.variants.some(
      (entry) => entry.id === variant && entry.revisions.at(-1)?.revision === revision,
    );
  const shellBytes = Buffer.byteLength(
    pageHtml(input, shown, "", revisionHistory(input, latestRevision)),
  );
  const groups = budgetedViews(input, frame, shellBytes);
  const views = groups.flat();
  const first = views.find(
    (view) =>
      view.variant === chosen.id &&
      view.revision === shown.revision &&
      view.orientation === "portrait",
  );
  if (!first) {
    throw new ActionableError(
      `Revision ${shown.revision} of variant ${chosen.id} is not in the page. Inlined revisions: ${groups
        .filter((group) => group[0]?.variant === chosen.id)
        .map((group) => group[0]!.revision)
        .join(", ")}`,
    );
  }
  const viewsHtml = views
    .map((view) => (view === first ? view.html.replace(' hidden=""', "") : view.html))
    .join("");
  const kept = new Set(views.map((view) => `${view.variant}\u0000${view.revision}`));
  const html = pageHtml(
    input,
    shown,
    viewsHtml,
    revisionHistory(input, (variant, revision) => kept.has(`${variant}\u0000${revision}`)),
  );
  const inlinedRevisions = Object.fromEntries(
    input.variants.map((variant) => [
      variant.id,
      groups.filter((group) => group[0]?.variant === variant.id).map((group) => group[0]!.revision),
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
