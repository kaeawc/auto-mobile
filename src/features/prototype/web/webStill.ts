import { prototypeSpecForDevice } from "../prototypeComponents";
import { prototypeRolePalette, type PrototypeColorMode } from "../prototypeContrast";
import { record, type Raw } from "../prototypeTemplate";
import { defaultDeviceFrameId, deviceFrameOrThrow } from "./deviceFrames";
import { renderDeviceFrame, type WebOrientation } from "./webFrame";
import { el, type WebElement } from "./webNodes";
import { renderWebNode, type UnsupportedWebNode, type WebRenderScope } from "./webRender";
import { cssColor } from "./webStyle";

export interface PrototypeStillOptions {
  /** A device frame id; defaults to the platform's default frame. */
  readonly frame?: string;
  readonly platform?: "android" | "ios";
  readonly orientation?: WebOrientation;
  readonly mode?: PrototypeColorMode;
  /** The clock derived relative times read; fixed so the same input renders the same bytes. */
  readonly nowMs?: number;
}

export interface PrototypeStill {
  readonly element: WebElement;
  readonly frame: string;
  readonly unsupportedNodes: readonly UnsupportedWebNode[];
}

const GRAVITY_ALIGN: Readonly<Record<string, [string, string]>> = {
  topStart: ["start", "start"],
  topCenter: ["start", "center"],
  topEnd: ["start", "end"],
  centerStart: ["center", "start"],
  center: ["center", "center"],
  centerEnd: ["center", "end"],
  bottomStart: ["end", "start"],
  bottomCenter: ["end", "center"],
  bottomEnd: ["end", "end"],
};

const LAYER = { position: "absolute", inset: "0", display: "flex", "flex-direction": "column" };

function sheetWindow(placement: Raw, children: WebElement[]): WebElement {
  const height = typeof placement.height === "number" ? placement.height : 0;
  const sheet = el(
    "div",
    { style: { display: "flex", "flex-direction": "column", height: `${height}px` } },
    children,
  );
  const edge = placement.edge === "top" ? "flex-start" : "flex-end";
  return el(
    "div",
    { attrs: { "data-window": "sheet" }, style: { ...LAYER, "justify-content": edge } },
    [sheet],
  );
}

function floatingWindow(placement: Raw, children: WebElement[]): WebElement {
  const [vertical, horizontal] = GRAVITY_ALIGN[String(placement.gravity)] ?? ["center", "center"];
  const offset = record(placement.offset);
  const x = typeof offset?.x === "number" ? offset.x : 0;
  const y = typeof offset?.y === "number" ? offset.y : 0;
  const floating = el("div", { style: { transform: `translate(${x}px, ${y}px)` } }, children);
  return el(
    "div",
    {
      attrs: { "data-window": "floating" },
      style: { ...LAYER, display: "grid", "align-items": vertical, "justify-items": horizontal },
    },
    [floating],
  );
}

/**
 * Window placement inside the screen: fullscreen fills it; a sheet is `height` dp at its `edge`;
 * a floating window sits at its `gravity`, moved by its `offset`.
 */
function placed(spec: unknown, content: WebElement | undefined): WebElement {
  const placement = record(record(record(spec)?.window)?.placement) ?? {};
  const children = content ? [content] : [];
  if (placement.type === "sheet") {
    return sheetWindow(placement, children);
  }
  if (placement.type === "floating") {
    return floatingWindow(placement, children);
  }
  return el("div", { attrs: { "data-window": "fullscreen" }, style: LAYER }, children);
}

function stillScope(
  expanded: unknown,
  options: PrototypeStillOptions,
  platform: "android" | "ios",
): WebRenderScope {
  const mode = options.mode ?? "light";
  const spec = record(expanded) ?? {};
  return {
    style: { mode, palette: prototypeRolePalette(expanded, mode), parentAxis: "column" },
    condition: { state: record(spec.state) ?? {}, platform },
    data: spec.data,
    spec,
    format: { locale: "en-US", timeZone: "UTC", nowMs: options.nowMs ?? 0 },
    instances: [],
    inBox: false,
    unsupported: [],
  };
}

export function renderPrototypeStill(
  spec: unknown,
  options: PrototypeStillOptions = {},
): PrototypeStill {
  const frame = deviceFrameOrThrow(
    options.frame ?? defaultDeviceFrameId(options.platform ?? "android"),
  );
  const expanded = prototypeSpecForDevice(spec);
  const scope = stillScope(expanded, options, frame.platform);
  const root = renderWebNode(record(expanded)?.root, scope, "root");
  const dark = scope.style.mode === "dark";
  const textColor = cssColor("onSurface", scope.style) ?? (dark ? "#e6e0e9" : "#1d1b20");
  const element = renderDeviceFrame(
    frame,
    options.orientation ?? "portrait",
    { dark, textColor },
    placed(expanded, root),
  );
  return { element, frame: frame.id, unsupportedNodes: scope.unsupported };
}
