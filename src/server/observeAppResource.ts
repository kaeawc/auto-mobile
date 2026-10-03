import type { ObserveResult } from "../models/ObserveResult";
import type { ElementBounds } from "../models/ElementBounds";
import { DefaultElementParser } from "../features/utility/ElementParser";
import { ResourceRegistry } from "./resourceRegistry";
import type { ResourceContent, ResourceReadContext } from "./resourceRegistry";
import { RealObserveScreen } from "../features/observe/ObserveScreen";
import { logger } from "../utils/logger";
import { resolveActiveSessionDevice, type ActiveSessionResolver } from "./activeSessionDevice";
import { getScreenshotStateStore } from "../features/observe/screenshot/ScreenshotStateRegistry";
import { readRetainedScreenshot } from "./retainedScreenshot";

/**
 * MCP Apps UI resource for `observe` (issue #4669). `observe` returns screen
 * state as data; this renders that same payload as a self-contained, inline HTML
 * "App" with view-hierarchy bounding boxes and the retained capture screenshot for
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
 * Pure: same input → same output. A supported image data URI is
 * inlined as the SVG backdrop; other values are ignored to preserve the
 * no-external-hosts invariant.
 */
export type ObserveAppScreenshot =
  | { dataUri: string; expiresAt: number }
  | { omittedReason: string };

function renderScreenshot(options: {
  screenshot?: ObserveAppScreenshot;
  width: number;
  height: number;
}) {
  const { screenshot, width, height } = options;
  const screenshotDataUri = screenshot && "dataUri" in screenshot ? screenshot.dataUri : undefined;

  const hasScreenshot =
    typeof screenshotDataUri === "string" &&
    /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(screenshotDataUri);
  const image = hasScreenshot
    ? `<image href="${escapeHtml(screenshotDataUri!)}" x="0" y="0" width="${fmt(width)}" height="${fmt(height)}" preserveAspectRatio="none"/>`
    : "";

  const expires =
    hasScreenshot && screenshot && "expiresAt" in screenshot
      ? ` data-expires-at="${escapeHtml(String(screenshot.expiresAt))}"`
      : "";
  const omittedReason =
    screenshot && "omittedReason" in screenshot
      ? screenshot.omittedReason
      : "Screenshot for this capture is not available";
  const screenshotNote = hasScreenshot ? "" : `<p class="am-note">${escapeHtml(omittedReason)}</p>`;

  return { image, screenshotNote, hasScreenshot, expires };
}

export function renderObserveAppHtml(options: {
  observe?: ObserveResult;
  screenshot?: ObserveAppScreenshot;
}): string {
  const { observe = {} as ObserveResult, screenshot } = options;
  const boxes = collectOverlayBoxes(observe);
  const { width, height } = resolveScreenSize(observe, boxes);
  const state = boxes.length > 0 ? "observe" : "empty";
  const { image, screenshotNote, hasScreenshot, expires } = renderScreenshot({
    screenshot,
    width,
    height,
  });
  const identity = `data-device-id="${escapeHtml(observe.deviceId ?? "")}" data-observation-id="${escapeHtml(observe.observationId ?? "")}"`;

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
.am-empty, .am-note { opacity:.75; }
</style>
</head>
<body>
<div class="am-stage" data-observe-app="${state}" data-screenshot="${hasScreenshot ? "present" : "omitted"}" ${identity}${expires}>
${emptyNote}
${screenshotNote}
<svg class="am-canvas" viewBox="0 0 ${fmt(width)} ${fmt(height)}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="observe screen overlay">
${image}
${rects}
</svg>
</div>
</body>
</html>`;
}

/** One session-bound observation and its exact capture's optional screenshot. */
export interface ObserveAppDataSource {
  getObservation(context: ResourceReadContext): Promise<
    | {
        observe: ObserveResult;
        screenshot: ObserveAppScreenshot;
      }
    | undefined
  >;
}

export interface ObserveAppDependencies {
  resolveActiveSession: ActiveSessionResolver;
  getCachedResult(deviceId: string): ObserveResult | undefined;
  getScreenshotPath(deviceId: string, observationId: string): string | undefined;
  isScreenshotPending(deviceId: string, observationId: string): boolean;
  readScreenshot(path: string): ReturnType<typeof readRetainedScreenshot>;
}

const defaultDependencies: ObserveAppDependencies = {
  resolveActiveSession: resolveActiveSessionDevice,
  getCachedResult: (deviceId) => RealObserveScreen.getRecentCachedResultForDevice(deviceId),
  getScreenshotPath: (deviceId, observationId) =>
    RealObserveScreen.getRecentCachedScreenshotPathForObservation(deviceId, observationId),
  isScreenshotPending: (deviceId, observationId) =>
    getScreenshotStateStore().isObservationPending(deviceId, observationId),
  readScreenshot: (path) => readRetainedScreenshot({ path }),
};

const unavailable = { omittedReason: "Screenshot for this capture is no longer available" };

async function getCaptureScreenshot(options: {
  deviceId: string;
  observationId?: string;
  dependencies: ObserveAppDependencies;
}): Promise<ObserveAppScreenshot> {
  const { deviceId, observationId, dependencies } = options;
  if (!observationId || dependencies.getCachedResult(deviceId)?.observationId !== observationId) {
    return unavailable;
  }
  if (dependencies.isScreenshotPending(deviceId, observationId)) {
    return { omittedReason: "Screenshot for this capture is still pending" };
  }
  const path = dependencies.getScreenshotPath(deviceId, observationId);
  if (!path) {
    return {
      omittedReason: "Screenshot for this capture was not captured or is no longer available",
    };
  }
  try {
    const image = await dependencies.readScreenshot(path);
    if (dependencies.getCachedResult(deviceId)?.observationId !== observationId) {
      return unavailable;
    }
    return { dataUri: `data:${image.mimeType};base64,${image.data}`, expiresAt: image.expiresAt };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      // Retention cannot restore a file that was externally removed; omission is expected.
      logger.debug("[ObserveAppResource] screenshot no longer retained", error);
    } else {
      logger.warn("[ObserveAppResource] Failed to read capture screenshot", error);
    }
    return unavailable;
  }
}

function resolveReadableSession(options: {
  context: ResourceReadContext;
  dependencies: ObserveAppDependencies;
}) {
  const { context, dependencies } = options;
  const sessionUuid = context.sessionUuid;
  // As with session resources, the registry's current binding is trusted when no
  // ownership predicate is supplied. An explicit ownership denial fails closed.
  if (!sessionUuid || context.signal?.aborted || context.ownsSession?.(sessionUuid) === false) {
    return undefined;
  }
  return dependencies.resolveActiveSession(sessionUuid);
}

export function createObserveAppDataSource(
  options: {
    dependencies?: ObserveAppDependencies;
  } = {},
): ObserveAppDataSource {
  const dependencies = options.dependencies ?? defaultDependencies;
  return {
    async getObservation(context) {
      const session = resolveReadableSession({ context, dependencies });
      if (!session) {
        return undefined;
      }
      const { deviceId } = session.device;
      const observe = dependencies.getCachedResult(deviceId);
      if (!observe || (observe.deviceId !== undefined && observe.deviceId !== deviceId)) {
        return undefined;
      }
      const screenshot = await getCaptureScreenshot({
        deviceId,
        observationId: observe.observationId,
        dependencies,
      });
      const currentSession = resolveReadableSession({ context, dependencies });
      if (
        !currentSession ||
        currentSession.device.deviceId !== deviceId ||
        currentSession.incarnation !== session.incarnation
      ) {
        return undefined;
      }
      return { observe: { ...observe, deviceId }, screenshot };
    },
  };
}

async function buildAppContent(options: {
  dataSource: ObserveAppDataSource;
  context: ResourceReadContext;
}): Promise<ResourceContent> {
  const observation = await options.dataSource.getObservation(options.context);
  return {
    uri: OBSERVE_APP_RESOURCE_URI,
    mimeType: MCP_APP_MIME_TYPE,
    text: renderObserveAppHtml(
      observation ?? {
        screenshot: {
          omittedReason:
            "No session-bound observation is available. Run observe in an active device session.",
        },
      },
    ),
  };
}

/** Register the `ui://automobile/observe` App resource. */
export function registerObserveAppResource(
  options: {
    dataSource?: ObserveAppDataSource;
  } = {},
): void {
  const dataSource = options.dataSource ?? createObserveAppDataSource();
  ResourceRegistry.register(
    OBSERVE_APP_RESOURCE_URI,
    "Observe App UI",
    "MCP App view of the observe result for the reading session with view-hierarchy bounding boxes; includes the screenshot of that exact capture when it is still retained.",
    MCP_APP_MIME_TYPE,
    (context = {}) => buildAppContent({ dataSource, context }),
  );
}
