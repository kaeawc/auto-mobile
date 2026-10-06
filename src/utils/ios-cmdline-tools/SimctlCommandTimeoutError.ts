/**
 * A bounded `simctl` command exceeded its own deadline and its child was killed. Typed so a
 * caller that must treat "dispatched, never acknowledged" differently from a plain non-zero exit
 * (an uninstall) does not have to match on the message text.
 */
export class SimctlCommandTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SimctlCommandTimeoutError";
  }
}
