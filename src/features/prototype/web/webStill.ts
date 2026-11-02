import { prototypeSpecForDevice } from "../prototypeComponents";
import { prototypeRolePalette, type PrototypeColorMode } from "../prototypeContrast";
import { record } from "../prototypeTemplate";
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

/** Window placement inside the screen: fullscreen fills it, a sheet sits at the bottom edge. */
function placed(spec: unknown, content: WebElement | undefined): WebElement {
  const placement = record(record(record(spec)?.window)?.placement)?.type;
  const layer = { position: "absolute", inset: "0", display: "flex", "flex-direction": "column" };
  if (placement === "sheet") {
    return el(
      "div",
      { attrs: { "data-window": "sheet" }, style: { ...layer, "justify-content": "flex-end" } },
      content ? [content] : [],
    );
  }
  if (placement === "floating") {
    return el(
      "div",
      {
        attrs: { "data-window": "floating" },
        style: { ...layer, "align-items": "center", "justify-content": "center" },
      },
      content ? [content] : [],
    );
  }
  return el(
    "div",
    { attrs: { "data-window": "fullscreen" }, style: layer },
    content ? [content] : [],
  );
}

/**
 * The prototype as a still screen inside a device frame (#16346): the spec's own state and data,
 * the stack's start screen, no actions run. Unsupported nodes draw as labelled placeholders and
 * are listed so the page never looks complete when it is not.
 */
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
