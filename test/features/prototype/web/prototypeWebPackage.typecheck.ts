// The prototype-web package's hand-written declarations (#16453) must match its implementation:
// each export is assigned in both directions, so a drift in either fails `bun run typecheck`.
import type * as Declared from "../../../../packages/prototype-web/index";
import * as Implemented from "../../../../packages/prototype-web/src/index";

type Assert<Condition extends true> = Condition;
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

export const declaredMount: typeof Declared.mount = Implemented.mount;
export const declaredRender: typeof Declared.renderPrototype = Implemented.renderPrototype;
export const declaredVersion: typeof Declared.PROTOTYPE_WEB_LIBRARY_VERSION =
  Implemented.PROTOTYPE_WEB_LIBRARY_VERSION;
export const declaredCapabilities: typeof Declared.PROTOTYPE_WEB_CAPABILITIES =
  Implemented.PROTOTYPE_WEB_CAPABILITIES;
export const declaredRefusal: typeof Declared.PrototypeWebRefusal = Implemented.PrototypeWebRefusal;

export type MountOptionsMatch = Assert<
  Same<Declared.PrototypeMountOptions, Implemented.PrototypeMountOptions>
>;
export type ViewStateMatch = Assert<
  Same<Declared.PrototypeViewState, Implemented.PrototypeViewState>
>;
export type RenderOptionsMatch = Assert<
  Same<Declared.PrototypeRenderOptions, Implemented.PrototypeRenderOptions>
>;
export type RenderedMatch = Assert<Same<Declared.PrototypeRendered, Implemented.PrototypeRendered>>;
export type ErrorMatch = Assert<Same<Declared.PrototypeWebError, Implemented.PrototypeWebError>>;
export type HandleMatch = Assert<
  Same<Declared.PrototypeMountHandle, Implemented.PrototypeMountHandle>
>;
export type FrameMatch = Assert<Same<Declared.PrototypeWebFrame, Implemented.PrototypeWebFrame>>;

// The element entry (#16454).
import type * as DeclaredElement from "../../../../packages/prototype-web/element";
import * as ImplementedElement from "../../../../packages/prototype-web/src/element";

export const declaredElement: typeof DeclaredElement.AutomobilePrototypeElement =
  ImplementedElement.AutomobilePrototypeElement;
export const declaredTag: typeof DeclaredElement.PROTOTYPE_ELEMENT_TAG =
  ImplementedElement.PROTOTYPE_ELEMENT_TAG;
export const declaredAttributes: typeof DeclaredElement.PROTOTYPE_ELEMENT_ATTRIBUTES =
  ImplementedElement.PROTOTYPE_ELEMENT_ATTRIBUTES;
export type ElementEventMatch = Assert<
  Same<DeclaredElement.PrototypeElementEvent, ImplementedElement.PrototypeElementEvent>
>;
export type ElementEventMapMatch = Assert<
  Same<keyof DeclaredElement.PrototypeElementEventMap, ImplementedElement.PrototypeElementEvent>
>;
