// The @kaeawc/auto-mobile-prototype-web/element entry (#16454): importing it registers
// <automobile-prototype>. The element forwards its lifecycle to PrototypeElementController in
// src/features/prototype/web/embed/, which holds the logic and its unit tests.
import { mount } from "../../../src/features/prototype/web/embed/prototypeWebMount";
import {
  PROTOTYPE_ELEMENT_ATTRIBUTES,
  PROTOTYPE_ELEMENT_TAG,
  PrototypeElementController,
} from "../../../src/features/prototype/web/embed/prototypeWebElement";

export {
  PROTOTYPE_ELEMENT_ATTRIBUTES,
  PROTOTYPE_ELEMENT_TAG,
  type PrototypeElementAttribute,
  type PrototypeElementEvent,
} from "../../../src/features/prototype/web/embed/prototypeWebElement";

/** A page without custom elements (a worker, an old browser) gets a class it never registers. */
const Base: typeof HTMLElement =
  typeof HTMLElement === "undefined" ? (class {} as typeof HTMLElement) : HTMLElement;

export class AutomobilePrototypeElement extends Base {
  static get observedAttributes(): readonly string[] {
    return PROTOTYPE_ELEMENT_ATTRIBUTES;
  }

  readonly #controller = new PrototypeElementController(
    {
      getAttribute: (name) => this.getAttribute(name),
      childSpecText: () =>
        this.querySelector(':scope > script[type="application/json"]')?.textContent ?? null,
      watchChildren: (changed) => {
        // characterData catches a script whose text the parser is still streaming in.
        const observer = new MutationObserver(changed);
        observer.observe(this, { childList: true, subtree: true, characterData: true });
        // Once parsing ends, a script that never parsed is reported rather than awaited.
        const doc = this.ownerDocument;
        doc.addEventListener("DOMContentLoaded", changed, { once: true });
        return () => {
          observer.disconnect();
          doc.removeEventListener("DOMContentLoaded", changed);
        };
      },
      parsing: () => this.ownerDocument.readyState === "loading",
    },
    {
      mount: (options) => mount(this, options),
      dispatch: (type, detail) => this.dispatchEvent(new CustomEvent(type, { detail })),
    },
  );

  constructor() {
    super();
    // A page may set `spec` before this module defines the element; that left an own property
    // shadowing the accessor below, so it is replayed through the setter on upgrade.
    const early = Object.getOwnPropertyDescriptor(this, "spec");
    if (early) {
      Reflect.deleteProperty(this, "spec");
      this.spec = early.value;
    }
  }

  /** A prototype spec or embed envelope; set it here or in a child JSON script, never an attribute. */
  get spec(): unknown {
    return this.#controller.spec;
  }

  set spec(value: unknown) {
    this.#controller.spec = value;
  }

  /** The view drawn, as `mount`'s handle reports it; `undefined` before the first draw. */
  get state() {
    return this.#controller.state;
  }

  connectedCallback(): void {
    this.#controller.connect();
  }

  disconnectedCallback(): void {
    this.#controller.disconnect();
  }

  attributeChangedCallback(): void {
    this.#controller.attributeChanged();
  }
}

if (typeof customElements !== "undefined" && !customElements.get(PROTOTYPE_ELEMENT_TAG)) {
  customElements.define(PROTOTYPE_ELEMENT_TAG, AutomobilePrototypeElement);
}
