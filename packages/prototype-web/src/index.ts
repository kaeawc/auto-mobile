// The @kaeawc/auto-mobile-prototype-web entry (#16453). The renderer stays in
// src/features/prototype/web/; this package only bundles it for the browser.
export {
  renderPrototype,
  type PrototypeRenderOptions,
  type PrototypeRendered,
  type PrototypeRenderedStack,
} from "../../../src/features/prototype/web/embed/prototypeWebRender";
export {
  mount,
  type PrototypeMountHandle,
} from "../../../src/features/prototype/web/embed/prototypeWebMount";
export type {
  PrototypeMountEvents,
  PrototypeMountOptions,
  PrototypeViewState,
  PrototypeWebControl,
  PrototypeWebZoom,
} from "../../../src/features/prototype/web/embed/prototypeWebMountState";
export {
  PROTOTYPE_WEB_LIBRARY_VERSION,
  PrototypeWebRefusal,
  type PrototypeWebError,
  type PrototypeWebErrorCode,
} from "../../../src/features/prototype/web/embed/prototypeWebInput";
export { PROTOTYPE_WEB_CAPABILITIES } from "../../../src/features/prototype/web/embed/prototypeWebCapabilities.generated";
