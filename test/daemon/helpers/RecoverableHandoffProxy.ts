import { DaemonMcpProxy } from "../../../src/daemon/daemonMcpProxy";

/** A real `DaemonMcpProxy` that reports the session it holds for an owner's reconnect. */
export class RecoverableHandoffProxy extends DaemonMcpProxy {
  get recoverableHandoff(): string | undefined {
    return this.recoverableBoundSessionHandoff;
  }
}
