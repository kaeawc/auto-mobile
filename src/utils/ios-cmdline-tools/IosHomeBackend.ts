import { resolveIosDeviceKind } from "./IosDeviceKind";
import type { SimCtl } from "./SimCtlClient";

/** SpringBoard transport only; runner Home presses and verification stay in the actions. */
export interface IosHomeBackend {
  readonly kind: "simulator" | "physical";
  launchSpringboard(options: { timeoutMs: number }): Promise<void>;
}

export interface IosHomeBackendDeps {
  simctl: Pick<SimCtl, "executeCommandArgs">;
}

export class SimulatorIosHomeBackend implements IosHomeBackend {
  readonly kind = "simulator";

  constructor(
    private readonly deviceId: string,
    private readonly simctl: IosHomeBackendDeps["simctl"],
  ) {}

  async launchSpringboard(options: { timeoutMs: number }): Promise<void> {
    await this.simctl.executeCommandArgs(
      ["launch", this.deviceId, "com.apple.springboard"],
      options.timeoutMs,
    );
  }
}

export class PhysicalIosHomeBackend implements IosHomeBackend {
  readonly kind = "physical";

  async launchSpringboard(_options: { timeoutMs: number }): Promise<void> {
    // Physical Home navigation belongs to the CtrlProxy runner in the action.
  }
}

export function resolveIosHomeBackend(deviceId: string, deps: IosHomeBackendDeps): IosHomeBackend {
  return resolveIosDeviceKind({ deviceId }) === "simulator"
    ? new SimulatorIosHomeBackend(deviceId, deps.simctl)
    : new PhysicalIosHomeBackend();
}
