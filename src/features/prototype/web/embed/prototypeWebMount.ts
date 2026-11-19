import { defaultDeviceFrameId } from "../deviceFrames";
import type { WebOrientation } from "../webFrame";
import { prototypeWebFitScale } from "../webPageRuntime";
import { FADE_EDGES_PAGE_CSS } from "../webStylePolish";
import { buildPrototypeDom } from "./prototypeWebDom";
import { markupGlyphParser, type PrototypeGlyphParser } from "./prototypeWebGlyphs";
import { PrototypeWebRefusal } from "./prototypeWebInput";
import {
  mergePrototypeMountOptions,
  prototypeWebControls,
  prototypeWebNextOrientation,
  prototypeWebViewEvents,
  prototypeWebZoomOption,
  prototypeWebZoomStep,
  type PrototypeMountOptions,
  type PrototypeViewState,
} from "./prototypeWebMountState";
import {
  renderPrototype,
  type PrototypeRenderOptions,
  type PrototypeRendered,
} from "./prototypeWebRender";

export interface PrototypeMountHandle {
  /** Redraws with these options over the current ones. */
  update(options: Partial<PrototypeMountOptions>): void;
  /** Removes everything `mount` drew and its listeners; later calls do nothing. */
  destroy(): void;
  readonly state: PrototypeViewState;
}

const SHELL_CSS = [
  ":host{display:block;position:relative;height:640px;contain:content}",
  "*{box-sizing:border-box}",
  "[data-shell]{display:flex;flex-direction:column;height:100%;font:14px system-ui,-apple-system,Roboto,sans-serif}",
  "[data-toolbar]{display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:8px}",
  "[data-toolbar] button,[data-toolbar] select{font:inherit;padding:4px 10px}",
  "[data-viewport]{flex:1;min-height:0;position:relative;overflow:hidden}",
  "[data-stage]{position:absolute;left:50%;top:50%;transform-origin:center}",
  "[data-error]{margin:16px;padding:12px;border:1px solid #b3261e;border-radius:8px;color:#b3261e;background:#fff}",
  "[hidden]{display:none!important}",
  FADE_EDGES_PAGE_CSS,
].join("");

interface Shell {
  readonly toolbar: HTMLElement;
  readonly rotate: HTMLButtonElement;
  readonly zoom: HTMLElement;
  readonly zoomLabel: HTMLElement;
  readonly zoomOut: HTMLButtonElement;
  readonly zoomIn: HTMLButtonElement;
  readonly zoomFit: HTMLButtonElement;
  readonly screenLabel: HTMLElement;
  readonly screen: HTMLSelectElement;
  readonly viewport: HTMLElement;
  readonly stage: HTMLElement;
}

function button(document: Document, control: string, label: string, text: string) {
  const element = document.createElement("button");
  element.type = "button";
  element.setAttribute("data-control", control);
  element.setAttribute("aria-label", label);
  element.textContent = text;
  return element;
}

function buildShell(document: Document): Shell & { readonly root: HTMLElement } {
  const root = document.createElement("div");
  root.setAttribute("data-shell", "");
  const toolbar = document.createElement("div");
  toolbar.setAttribute("data-toolbar", "");
  toolbar.setAttribute("role", "toolbar");
  const rotate = button(document, "rotate", "Rotate", "Rotate");
  const zoom = document.createElement("span");
  const zoomOut = button(document, "zoom-out", "Zoom out", "−");
  const zoomLabel = document.createElement("output");
  const zoomIn = button(document, "zoom-in", "Zoom in", "+");
  const zoomFit = button(document, "zoom-fit", "Fit", "Fit");
  zoom.append(zoomOut, zoomLabel, zoomIn, zoomFit);
  const screenLabel = document.createElement("label");
  const screen = document.createElement("select");
  screen.setAttribute("data-control", "screen");
  screenLabel.append("Screen ", screen);
  toolbar.append(rotate, zoom, screenLabel);
  const viewport = document.createElement("div");
  viewport.setAttribute("data-viewport", "");
  const stage = document.createElement("div");
  stage.setAttribute("data-stage", "");
  viewport.append(stage);
  root.append(toolbar, viewport);
  return {
    root,
    toolbar,
    rotate,
    zoom,
    zoomLabel,
    zoomOut,
    zoomIn,
    zoomFit,
    screenLabel,
    screen,
    viewport,
    stage,
  };
}

function errorView(document: Document, refusal: PrototypeWebRefusal): HTMLElement {
  const view = document.createElement("div");
  view.setAttribute("data-error", refusal.error.code);
  view.setAttribute("role", "alert");
  view.append(refusal.error.message);
  return view;
}

function screenOptions(document: Document, select: HTMLSelectElement, state: PrototypeViewState) {
  select.replaceChildren(
    ...state.screens.map((screen) => {
      const option = document.createElement("option");
      option.value = screen;
      option.textContent = screen;
      option.selected = screen === state.screen;
      return option;
    }),
  );
}

/** Shows each control that applies to the view drawn, and hides the toolbar when none does. */
function syncControls(
  shell: Shell,
  options: PrototypeMountOptions,
  state: PrototypeViewState,
  canRotate: boolean,
) {
  const controls = prototypeWebControls(options.controls);
  const drawn = state.error === undefined;
  shell.rotate.hidden = !drawn || !controls.has("rotate") || !canRotate;
  shell.zoom.hidden = !drawn || !controls.has("zoom");
  shell.zoomLabel.textContent = `${Math.round(state.scale * 100)}%`;
  shell.screenLabel.hidden = !drawn || !controls.has("screen") || state.screens.length < 2;
  shell.screen.replaceChildren();
  if (!shell.screenLabel.hidden) {
    screenOptions(shell.stage.ownerDocument, shell.screen, state);
  }
  shell.toolbar.hidden = shell.rotate.hidden && shell.zoom.hidden && shell.screenLabel.hidden;
}

function fitScale(shell: Shell): number {
  const viewport = shell.viewport.getBoundingClientRect();
  return prototypeWebFitScale(viewport, {
    width: shell.stage.offsetWidth,
    height: shell.stage.offsetHeight,
  });
}

function placeStage(shell: Shell, scale: number) {
  shell.stage.style.setProperty("transform", `translate(-50%, -50%) scale(${scale})`);
}

function renderOptions(
  options: PrototypeMountOptions,
  mode: "light" | "dark",
  parseGlyph: PrototypeGlyphParser | undefined,
): PrototypeRenderOptions {
  return {
    ...(options.frame === undefined ? {} : { frame: options.frame }),
    ...(options.orientation ? { orientation: options.orientation } : {}),
    mode,
    ...(options.screen === undefined ? {} : { screen: options.screen }),
    ...(options.locale === undefined ? {} : { locale: options.locale }),
    ...(options.textSize === undefined ? {} : { textSize: options.textSize }),
    ...(parseGlyph ? { parseGlyph } : {}),
  };
}

/**
 * The frame `state` names while refused: the option's id, as a drawn view would. A page script
 * can pass anything, so a `null` or id-less object names the default frame rather than throwing.
 */
export function prototypeWebRefusedFrame(frame: PrototypeMountOptions["frame"]): string | false {
  if (typeof frame === "object" && frame !== null) {
    return typeof frame.id === "string" ? frame.id : defaultDeviceFrameId("android");
  }
  return frame ?? defaultDeviceFrameId("android");
}

/** The view state while the error view is drawn. */
function refusedState(
  options: PrototypeMountOptions,
  view: Pick<PrototypeViewState, "zoom" | "mode">,
  refusal: PrototypeWebRefusal,
): PrototypeViewState {
  return {
    frame: prototypeWebRefusedFrame(options.frame),
    orientation: options.orientation ?? "portrait",
    ...view,
    scale: 1,
    screens: [],
    unsupportedNodes: [],
    error: refusal.error,
  };
}

function renderedState(
  rendered: PrototypeRendered,
  view: Pick<PrototypeViewState, "zoom" | "mode" | "scale">,
): PrototypeViewState {
  return {
    frame: rendered.frame,
    orientation: rendered.orientation,
    ...view,
    ...(rendered.stack ? { screen: rendered.stack.screen } : {}),
    screens: rendered.stack?.screens ?? [],
    unsupportedNodes: rendered.unsupportedNodes,
  };
}

function colorMode(options: PrototypeMountOptions, dark: MediaQueryList | undefined) {
  if (options.mode === "light" || options.mode === "dark") {
    return options.mode;
  }
  return dark?.matches ? "dark" : "light";
}

/**
 * Draws a prototype into a shadow root on `host` (#16453): the device frame, the chosen controls
 * and, for a spec or envelope it refuses, an error view and an `error` event.
 */
export function mount(host: HTMLElement, initial: PrototypeMountOptions): PrototypeMountHandle {
  const document = host.ownerDocument;
  const window = document.defaultView;
  const root = host.shadowRoot ?? host.attachShadow({ mode: "open" });
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(SHELL_CSS);
  root.adoptedStyleSheets = [sheet];
  const shell = buildShell(document);
  root.replaceChildren(shell.root);
  const dark = window?.matchMedia?.("(prefers-color-scheme: dark)");
  const parseGlyph =
    window && "DOMParser" in window ? markupGlyphParser(new window.DOMParser()) : undefined;
  let options = initial;
  let state: PrototypeViewState | undefined;
  let orientations: readonly WebOrientation[] = [];
  let destroyed = false;
  // A zoom the controls chose: kept as stepped (a fitted scale below 50% may stay there) until an
  // update sets the zoom option again.
  let chosenZoom: PrototypeViewState["zoom"] | undefined;

  const applyScale = (zoom: PrototypeViewState["zoom"]) => {
    const scale = zoom === "fit" ? fitScale(shell) : zoom;
    placeStage(shell, scale);
    return scale;
  };

  const draw = () => {
    const before = state;
    const mode = colorMode(options, dark);
    const zoom = chosenZoom ?? prototypeWebZoomOption(options.zoom);
    try {
      const rendered = renderPrototype(options.spec, renderOptions(options, mode, parseGlyph));
      shell.stage.replaceChildren(buildPrototypeDom(document, rendered.element) as Node);
      orientations = rendered.orientations;
      state = renderedState(rendered, { zoom, mode, scale: applyScale(zoom) });
    } catch (error) {
      if (!(error instanceof PrototypeWebRefusal)) {
        throw error;
      }
      // A refusal is the documented outcome: the error view and `error` event report it.
      placeStage(shell, 1);
      shell.stage.replaceChildren(errorView(document, error));
      orientations = [];
      state = refusedState(options, { zoom, mode }, error);
    }
    syncControls(shell, options, state, orientations.length > 1);
    prototypeWebViewEvents(before, state, options);
  };

  const setZoom = (zoom: PrototypeViewState["zoom"]) => {
    if (!state || state.error) {
      return;
    }
    chosenZoom = zoom;
    const before = state;
    const scale = applyScale(zoom);
    state = { ...state, zoom, scale };
    syncControls(shell, options, state, orientations.length > 1);
    if (before.zoom !== zoom || before.scale !== scale) {
      options.onZoomChange?.({ zoom, scale });
    }
  };

  const update = (next: Partial<PrototypeMountOptions>) => {
    if (destroyed) {
      return;
    }
    if (next.zoom !== undefined) {
      chosenZoom = undefined;
    }
    options = mergePrototypeMountOptions(options, next);
    draw();
  };

  shell.rotate.addEventListener("click", () => {
    const orientation = state && prototypeWebNextOrientation(state.orientation, orientations);
    if (orientation) {
      update({ orientation });
    }
  });
  shell.zoomIn.addEventListener(
    "click",
    () => state && setZoom(prototypeWebZoomStep(state.scale, 1)),
  );
  shell.zoomOut.addEventListener(
    "click",
    () => state && setZoom(prototypeWebZoomStep(state.scale, -1)),
  );
  shell.zoomFit.addEventListener("click", () => setZoom("fit"));
  shell.screen.addEventListener("change", () => update({ screen: shell.screen.value }));
  const followSystem = () => {
    if ((options.mode ?? "system") === "system") {
      draw();
    }
  };
  dark?.addEventListener("change", followSystem);
  const resize =
    window && "ResizeObserver" in window
      ? new window.ResizeObserver(() => {
          if (state && !state.error && state.zoom === "fit") {
            setZoom("fit");
          }
        })
      : undefined;
  resize?.observe(shell.viewport);

  draw();
  return {
    update,
    destroy() {
      if (destroyed) {
        return;
      }
      destroyed = true;
      resize?.disconnect();
      dark?.removeEventListener("change", followSystem);
      root.replaceChildren();
      root.adoptedStyleSheets = [];
    },
    get state(): PrototypeViewState {
      if (!state) {
        throw new Error("prototype-web: mount drew no view");
      }
      return state;
    },
  };
}
