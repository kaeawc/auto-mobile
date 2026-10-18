/** Pending requests lose their transport when the service endpoint changes. */
/** Pending requests lose their transport when the service endpoint changes. */
export class CtrlProxyServicePortChangedError extends Error {
  constructor() {
    super("CtrlProxy service port changed");
    this.name = "CtrlProxyServicePortChangedError";
  }
}
