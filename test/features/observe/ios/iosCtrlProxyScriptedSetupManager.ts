import type { CtrlProxyIosSetupResult } from "../../../../src/ctrlProxy/IOSCtrlProxyManager";
import { FakeIOSCtrlProxyManager } from "../../../fakes/FakeIOSCtrlProxyManager";

/**
 * A not-running CtrlProxy iOS manager whose setup() returns a scripted result,
 * for tests that pin how the client reports a failed auto-setup.
 */
export class ScriptedSetupManager extends FakeIOSCtrlProxyManager {
  constructor(
    private readonly setupResult: CtrlProxyIosSetupResult,
    private readonly recoveryInFlight: boolean = false,
  ) {
    super();
  }

  override async isRunning(): Promise<boolean> {
    return false;
  }

  override async setup(): Promise<CtrlProxyIosSetupResult> {
    return this.setupResult;
  }

  isRecoveryInFlight(): boolean {
    return this.recoveryInFlight;
  }
}
