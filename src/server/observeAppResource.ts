import type { ObserveResult } from "../models/ObserveResult";
import type { ElementBounds } from "../models/ElementBounds";
import { DefaultElementParser } from "../features/utility/ElementParser";
import { ResourceRegistry } from "./resourceRegistry";
import type { ResourceContent } from "./resourceRegistry";
import { RealObserveScreen } from "../features/observe/ObserveScreen";
import { logger } from "../utils/logger";

/**
 * MCP Apps UI resource for `observe` (issue #4669). `observe` returns screen
 * state as data; this renders that same payload as a self-contained, inline HTML
 * "App" — the screenshot with the view-hierarchy bounding boxes overlaid — for
 * Apps-capable hosts. It is purely additive: the tool's data result is unchanged
 * and non-Apps hosts simply ignore the `_meta.ui.resourceUri` pointer.
 *
 * The body is fully self-contained (inline CSS + SVG, no external hosts, no
 * scripts) to mirror the repo's artifact CSP posture. Interactive tap-target
 * selection is a deliberate follow-up, not part of this resource.
 */
export const OBSERVE_APP_RESOURCE_URI = "ui://automobile/observe";

/** The MCP Apps content profile (spec 2026-01-26). */
export const MCP_APP_MIME_TYPE = "text/html;profile=mcp-app";

// A single deterministic parser instance — flattenViewHierarchy is pure.
const elementParser = new DefaultElementParser();

interface OverlayBox {
  bounds: ElementBounds;
  label: string;
}

// HTML/attribute escaping — labels come from device text/resource-id and must
// never break the markup or smuggle in active content.
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Integers stay integers; fractional iOS point coordinates (issue #3206) keep up
// to 3 decimals without trailing-zero noise.
function fmt(n: number): string {
  if (!Number.isFinite(n)) {
    return "0";
  }
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(3)));
}

function collectOverlayBoxes(observe: ObserveResult): OverlayBox[] {
  if (!observe.viewHierarchy) {
    return [];
  }
  return elementParser
    .flattenViewHierarchy(observe.viewHierarchy)
    .filter((entry) => entry.element?.bounds)
    .map((entry) => {
      const element = entry.element;
      const label =
        entry.text ||
        (element["resource-id"] as string | undefined) ||
        (element["content-desc"] as string | undefined) ||
        (element.class as string | undefined) ||
        "";
      return { bounds: element.bounds, label };
    });
}

// Bounds coordinate space (the units the flattened bounds are in). The SVG
// viewBox is set to this space so overlay rects align to the screenshot
// regardless of the screenshot's physical pixel resolution.
function resolveScreenSize(
  observe: ObserveResult,
  boxes: OverlayBox[],
): { width: number; height: number } {
  const vh = observe.viewHierarchy;
  if (vh?.screenWidth && vh?.screenHeight) {
    return { width: vh.screenWidth, height: vh.screenHeight };
  }
  if (observe.screenSize?.width && observe.screenSize?.height) {
    return { width: observe.screenSize.width, height: observe.screenSize.height };
  }
  // Last resort: bound the boxes we have so the overlay is still viewable.
  const maxRight = boxes.reduce((m, b) => Math.max(m, b.bounds.right), 0);
  const maxBottom = boxes.reduce((m, b) => Math.max(m, b.bounds.bottom), 0);
  return { width: maxRight || 1, height: maxBottom || 1 };
}

/**
 * Render the observe payload as a self-contained MCP App HTML document.
 * Pure: same input → same output. `screenshotDataUri`, when a `data:` URI, is
 * inlined as the SVG backdrop; any non-`data:` value is ignored to preserve the
 * no-external-hosts invariant.
 */
export function renderObserveAppHtml(observe: ObserveResult, screenshotDataUri?: string): string {
  const boxes = collectOverlayBoxes(observe);
  const { width, height } = resolveScreenSize(observe, boxes);
  const state = boxes.length > 0 ? "observe" : "empty";

  const hasScreenshot =
    typeof screenshotDataUri === "string" && screenshotDataUri.startsWith("data:");
  const image = hasScreenshot
    ? `<image href="${escapeHtml(screenshotDataUri!)}" x="0" y="0" width="${fmt(width)}" height="${fmt(height)}" preserveAspectRatio="none"/>`
    : "";

  const rects = boxes
    .map(({ bounds, label }) => {
      const w = Math.max(0, bounds.right - bounds.left);
      const h = Math.max(0, bounds.bottom - bounds.top);
      const title = label ? `<title>${escapeHtml(label)}</title>` : "";
      return `<rect class="am-box" x="${fmt(bounds.left)}" y="${fmt(bounds.top)}" width="${fmt(w)}" height="${fmt(h)}">${title}</rect>`;
    })
    .join("");

  const emptyNote =
    state === "empty"
      ? `<p class="am-empty">No view hierarchy to display. Run <code>observe</code> to capture screen state.</p>`
      : "";

  // Theme-aware, responsive, and fully inline. No scripts, no external refs.
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>AutoMobile — observe</title>
<style>
:root { color-scheme: light dark; --am-bg:#f6f7f9; --am-fg:#1b1f24; --am-box:#2f6feb; --am-backdrop:#e7e9ee; }
@media (prefers-color-scheme: dark) { :root { --am-bg:#0f1216; --am-fg:#e6e8eb; --am-box:#6ea8ff; --am-backdrop:#1b1f24; } }
:root[data-theme="light"] { --am-bg:#f6f7f9; --am-fg:#1b1f24; --am-box:#2f6feb; --am-backdrop:#e7e9ee; }
:root[data-theme="dark"] { --am-bg:#0f1216; --am-fg:#e6e8eb; --am-box:#6ea8ff; --am-backdrop:#1b1f24; }
* { box-sizing: border-box; }
body { margin:0; padding:12px; background:var(--am-bg); color:var(--am-fg); font:14px/1.4 system-ui, sans-serif; }
.am-stage { max-width:100%; margin:0 auto; }
svg.am-canvas { width:100%; height:auto; max-width:100%; display:block; background:var(--am-backdrop); border-radius:8px; }
rect.am-box { fill:transparent; stroke:var(--am-box); stroke-width:1.5; vector-effect:non-scaling-stroke; }
rect.am-box:hover { fill:color-mix(in srgb, var(--am-box) 18%, transparent); }
.am-empty { opacity:.75; }
</style>
</head>
<body>
<div class="am-stage" data-observe-app="${state}">
${emptyNote}
<svg class="am-canvas" viewBox="0 0 ${fmt(width)} ${fmt(height)}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="observe screen overlay">
${image}
${rects}
</svg>
</div>
</body>
</html>`;
}

/** Source of the latest observe payload + screenshot for the App resource. */
export interface ObserveAppDataSource {
  getLatestObserve(): Promise<ObserveResult | undefined>;
  getLatestScreenshotDataUri(): Promise<string | undefined>;
}

// Production source: the in-memory observe cache. The screenshot is deliberately
// NOT embedded yet: `getRecentCachedResult()` (hierarchy) and the cached
// screenshot are independent process-global getters with no capture-identity
// link and no deviceId on `ObserveResult`, so pairing them could overlay bounds
// on a stale — or, under multi-device, a different device's — image. The overlay
// renders on the themed backdrop until a correlated screenshot source exists;
// the renderer already accepts a `data:` URI for when it does. Follow-up: #4682.
const defaultDataSource: ObserveAppDataSource = {
  getLatestObserve: async () => RealObserveScreen.getRecentCachedResult(),
  getLatestScreenshotDataUri: async () => undefined,
};

async function buildAppContent(dataSource: ObserveAppDataSource): Promise<ResourceContent> {
  const observe = await dataSource.getLatestObserve();
  if (!observe) {
    return {
      uri: OBSERVE_APP_RESOURCE_URI,
      mimeType: MCP_APP_MIME_TYPE,
      text: renderObserveAppHtml({} as ObserveResult),
    };
  }
  let screenshotDataUri: string | undefined;
  try {
    screenshotDataUri = await dataSource.getLatestScreenshotDataUri();
  } catch (error) {
    // Screenshot is optional garnish; the overlay still renders without it.
    logger.debug(`[ObserveAppResource] screenshot unavailable: ${error}`);
  }
  return {
    uri: OBSERVE_APP_RESOURCE_URI,
    mimeType: MCP_APP_MIME_TYPE,
    text: renderObserveAppHtml(observe, screenshotDataUri),
  };
}

/** Register the `ui://automobile/observe` App resource. */
export function registerObserveAppResource(
  dataSource: ObserveAppDataSource = defaultDataSource,
): void {
  ResourceRegistry.register(
    OBSERVE_APP_RESOURCE_URI,
    "Observe App UI",
    "Interactive MCP App view of the latest observe result: screenshot with the view-hierarchy overlaid.",
    MCP_APP_MIME_TYPE,
    () => buildAppContent(dataSource),
  );
}
