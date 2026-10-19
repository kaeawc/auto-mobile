import type { CtrlProxyForwardLease } from "./CtrlProxyForwardLease";

export class NoOpCtrlProxyForwardLease implements CtrlProxyForwardLease {
  public tryAcquire(): boolean {
    return true;
  }

  public release(): void {}

  public getLastOwnerPid(): undefined {
    return undefined;
  }
}
