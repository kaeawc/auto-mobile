import type { PrototypeMountHandle } from "./prototypeWebMount";
import type {
  PrototypeMountEvents,
  PrototypeMountOptions,
  PrototypeWebControl,
} from "./prototypeWebMountState";

/**
 * The logic of `<automobile-prototype>` (#16454), a thin layer over `mount`: attributes set the
 * scalar options, the spec comes only from the `spec` property or a child
 * `<script type="application/json">`, and `mount`'s callbacks become `CustomEvent`s. The element
 * class in `packages/prototype-web/src/element.ts` only forwards its lifecycle here, so this runs
 * without a DOM under test.
 */
export const PROTOTYPE_ELEMENT_TAG = "automobile-prototype";

/** The attributes the element observes, one per scalar option. */
export const PROTOTYPE_ELEMENT_ATTRIBUTES = [
  "frame",
  "orientation",
  "zoom",
  "mode",
  "screen",
  "controls",
] as const;

export type PrototypeElementAttribute = (typeof PROTOTYPE_ELEMENT_ATTRIBUTES)[number];

/** The events the element dispatches, each carrying its `mount` callback's detail. */
export type PrototypeElementEvent =
  | "render"
  | "screenchange"
  | "orientationchange"
  | "zoomchange"
  | "error";

/** What the controller needs of the element. */
export interface PrototypeElementHost {
  getAttribute(name: string): string | null;
  /** The text of the first child `<script type="application/json">`, if there is one. */
  childSpecText(): string | null;
  /**
   * Calls `changed` when the element's children change, and once more when the document finishes
   * parsing, until the returned stop is called. The parser may connect the element before its JSON
   * script child arrives.
   */
  watchChildren(changed: () => void): () => void;
  /** Whether the HTML parser may still be streaming the element's children in. */
  parsing(): boolean;
}

export interface PrototypeElementDeps {
  readonly mount: (options: PrototypeMountOptions) => PrototypeMountHandle;
  readonly dispatch: (type: PrototypeElementEvent, detail: unknown) => void;
}

type AttributeOptions = Pick<
  PrototypeMountOptions,
  "frame" | "orientation" | "zoom" | "mode" | "screen" | "controls"
>;

const CONTROLS: readonly PrototypeWebControl[] = ["rotate", "zoom", "screen"];
const OFF = new Set(["false", "none"]);

function oneOf<T extends string>(value: string | null, values: readonly T[]): T | undefined {
  return values.find((candidate) => candidate === value);
}

function zoomOf(value: string | null): PrototypeMountOptions["zoom"] {
  if (value === null) {
    return undefined;
  }
  const scale = Number(value.trim());
  return value.trim() !== "" && Number.isFinite(scale) ? scale : "fit";
}

function controlsOf(value: string | null): PrototypeMountOptions["controls"] {
  if (value === null) {
    return undefined;
  }
  if (OFF.has(value.trim())) {
    return false;
  }
  const names = value.split(/[\s,]+/);
  return CONTROLS.filter((control) => names.includes(control));
}

/**
 * The scalar options the element's attributes set; an absent attribute sets none. `frame` and
 * `controls` take `false` or `none` to turn them off; `controls` lists names separated by spaces
 * or commas. An unrecognized `orientation` or `mode` is ignored; `zoom` is `fit` or a number.
 */
export function prototypeElementOptions(
  read: (name: PrototypeElementAttribute) => string | null,
): AttributeOptions {
  const frame = read("frame");
  const orientation = oneOf(read("orientation"), ["portrait", "landscape"] as const);
  const mode = oneOf(read("mode"), ["light", "dark", "system"] as const);
  const screen = read("screen");
  const zoom = zoomOf(read("zoom"));
  const controls = controlsOf(read("controls"));
  return {
    ...(frame === null ? {} : { frame: OFF.has(frame.trim()) ? false : frame.trim() }),
    ...(orientation ? { orientation } : {}),
    ...(zoom === undefined ? {} : { zoom }),
    ...(mode ? { mode } : {}),
    ...(screen === null ? {} : { screen }),
    ...(controls === undefined ? {} : { controls }),
  };
}

/** The spec a child script holds: its parsed JSON, or `undefined` (an `invalidInput` refusal). */
export function prototypeElementScriptSpec(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    // Unparseable JSON draws mount's invalidInput error view and `error` event instead.
    void error;
    return undefined;
  }
}

/** `mount` callbacks that dispatch the element's events. */
function eventCallbacks(dispatch: PrototypeElementDeps["dispatch"]): PrototypeMountEvents {
  return {
    onRender: (detail) => dispatch("render", detail),
    onScreenChange: (detail) => dispatch("screenchange", detail),
    onOrientationChange: (detail) => dispatch("orientationchange", detail),
    onZoomChange: (detail) => dispatch("zoomchange", detail),
    onError: (detail) => dispatch("error", detail),
  };
}

/** Drives one element: mounts while connected with a spec, updates on attribute or spec change. */
export class PrototypeElementController {
  private handle: PrototypeMountHandle | undefined;
  private propertySpec: { readonly value: unknown } | undefined;
  private connected = false;
  private attributeKeys: readonly string[] = [];
  // Events `mount` fires while it draws, before its handle is stored: delivered once it is, so a
  // listener that sets the spec or removes the element acts on the mounted view.
  private queued: [PrototypeElementEvent, unknown][] | undefined;
  private stopWatching: (() => void) | undefined;

  constructor(
    private readonly host: PrototypeElementHost,
    private readonly deps: PrototypeElementDeps,
  ) {}

  /** The spec drawn: the property's, else the child script's; `undefined` when there is none. */
  get spec(): unknown {
    return this.propertySpec ? this.propertySpec.value : this.scriptSpec()?.value;
  }

  set spec(value: unknown) {
    this.propertySpec = { value };
    // mount's update drops an undefined option, so clearing the spec mounts afresh: it draws the
    // invalidInput error view rather than keeping the previous prototype.
    if (this.handle && value !== undefined) {
      this.handle.update({ spec: value });
    } else {
      this.remount();
    }
  }

  get state(): PrototypeMountHandle["state"] | undefined {
    return this.handle?.state;
  }

  connect(): void {
    this.connected = true;
    this.draw();
    // Connected with no spec yet: draw once a child JSON script arrives. While the parser may still
    // be streaming its text in, wait until it parses; after that, invalid JSON draws the error view.
    if (this.connected && !this.handle && !this.stopWatching) {
      this.stopWatching = this.host.watchChildren(() => {
        if (!this.host.parsing() || this.scriptSpec()?.value !== undefined) {
          this.draw();
        }
      });
    }
  }

  disconnect(): void {
    this.connected = false;
    this.unwatch();
    this.handle?.destroy();
    this.handle = undefined;
  }

  private unwatch(): void {
    this.stopWatching?.();
    this.stopWatching = undefined;
  }

  /**
   * Applies the one attribute that changed. Only its option is passed on, so `mount` keeps the
   * orientation and zoom the toolbar chose when an unrelated attribute changes.
   */
  attributeChanged(name: string): void {
    if (!this.handle) {
      return;
    }
    const options = this.attributeOptions();
    const keys = Object.keys(options);
    // mount's update keeps an option it is not given, so a removed attribute needs a fresh mount.
    if (this.attributeKeys.some((key) => !keys.includes(key))) {
      this.remount();
      return;
    }
    this.attributeKeys = keys;
    const attribute = PROTOTYPE_ELEMENT_ATTRIBUTES.find((known) => known === name);
    if (attribute && options[attribute] !== undefined) {
      this.handle.update({ [attribute]: options[attribute] });
    }
  }

  private scriptSpec(): { readonly value: unknown } | undefined {
    const text = this.host.childSpecText();
    return text === null ? undefined : { value: prototypeElementScriptSpec(text) };
  }

  private attributeOptions(): AttributeOptions {
    return prototypeElementOptions((name) => this.host.getAttribute(name));
  }

  private remount(): void {
    this.handle?.destroy();
    this.handle = undefined;
    this.draw();
  }

  private draw(): void {
    const source = this.propertySpec ?? this.scriptSpec();
    if (!this.connected || this.handle || !source) {
      return;
    }
    this.unwatch();
    const options = this.attributeOptions();
    this.attributeKeys = Object.keys(options);
    const queued: [PrototypeElementEvent, unknown][] = [];
    this.queued = queued;
    try {
      this.handle = this.deps.mount({
        spec: source.value,
        ...options,
        ...eventCallbacks((type, detail) => this.dispatch(type, detail)),
      });
    } finally {
      this.queued = undefined;
    }
    queued.forEach(([type, detail]) => this.deps.dispatch(type, detail));
  }

  private dispatch(type: PrototypeElementEvent, detail: unknown): void {
    if (this.queued) {
      this.queued.push([type, detail]);
    } else {
      this.deps.dispatch(type, detail);
    }
  }
}
