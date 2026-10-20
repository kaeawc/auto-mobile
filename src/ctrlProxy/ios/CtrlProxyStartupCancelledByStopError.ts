import { CtrlProxyStartupRecoveryInterruptedError } from "./CtrlProxyStartupRecoveryInterruptedError";
export class CtrlProxyStartupCancelledByStopError extends CtrlProxyStartupRecoveryInterruptedError {
  constructor() {
    super("iOS CtrlProxy startup was cancelled by stop()");
  }
}
