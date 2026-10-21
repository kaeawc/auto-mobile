/** The runner launch exhausted its health-poll window; a fresh setup may succeed. */
export class CtrlProxyLaunchTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CtrlProxyLaunchTimeoutError";
  }
}
