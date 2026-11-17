// Public types of @kaeawc/auto-mobile-prototype-web/element (#16454). Importing the entry
// registers <automobile-prototype>; test/features/prototype/web/prototypeWebPackage.typecheck.ts
// fails when these drift from packages/prototype-web/src/element.ts.
import type {
  PrototypeOrientation,
  PrototypeUnsupportedNode,
  PrototypeViewState,
  PrototypeWebError,
  PrototypeWebZoom,
} from "./index";

export declare const PROTOTYPE_ELEMENT_TAG: "automobile-prototype";

/** The attributes the element observes: `frame`, `orientation`, `zoom`, `mode`, `screen`, `controls`. */
export declare const PROTOTYPE_ELEMENT_ATTRIBUTES: readonly [
  "frame",
  "orientation",
  "zoom",
  "mode",
  "screen",
  "controls",
];

export type PrototypeElementAttribute = (typeof PROTOTYPE_ELEMENT_ATTRIBUTES)[number];

export type PrototypeElementEvent =
  | "render"
  | "screenchange"
  | "orientationchange"
  | "zoomchange"
  | "error";

/** `<automobile-prototype>`: a prototype drawn in a device frame inside its shadow root. */
export declare class AutomobilePrototypeElement extends HTMLElement {
  static get observedAttributes(): readonly string[];
  /** A prototype spec or embed envelope; set it here or in a child JSON script, never an attribute. */
  get spec(): unknown;
  set spec(value: unknown);
  /** The view drawn; `undefined` before the first draw. */
  get state(): PrototypeViewState | undefined;
  connectedCallback(): void;
  disconnectedCallback(): void;
  attributeChangedCallback(name: string): void;
}

export interface PrototypeElementEventMap {
  render: CustomEvent<{ readonly unsupportedNodes: readonly PrototypeUnsupportedNode[] }>;
  screenchange: CustomEvent<{ readonly screen: string }>;
  orientationchange: CustomEvent<{ readonly orientation: PrototypeOrientation }>;
  zoomchange: CustomEvent<{ readonly zoom: PrototypeWebZoom; readonly scale: number }>;
  error: CustomEvent<PrototypeWebError>;
}

declare global {
  interface HTMLElementTagNameMap {
    "automobile-prototype": AutomobilePrototypeElement;
  }
}
