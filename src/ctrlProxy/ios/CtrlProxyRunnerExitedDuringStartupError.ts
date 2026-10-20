import { CtrlProxyStartupRecoveryInterruptedError } from "./CtrlProxyStartupRecoveryInterruptedError";
export class CtrlProxyRunnerExitedDuringStartupError extends CtrlProxyStartupRecoveryInterruptedError {
  constructor() {
    super("iOS CtrlProxy runner exited during startup");
  }
}
