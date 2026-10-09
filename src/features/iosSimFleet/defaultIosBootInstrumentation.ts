import {
  DefaultHostCommandExecutor,
  type HostCommandExecutor,
} from "../../utils/HostCommandExecutor";
import type { SimCtl } from "../../utils/ios-cmdline-tools/SimCtlClient";
import type { Timer } from "../../utils/SystemTimer";
import { InMemoryBootDurationHistory, type BootDurationHistory } from "./BootDurationHistory";
import { IosSimCapacityGate } from "./CapacityGate";
import { IosSimFleetCostCollector } from "./FleetCostCollector";
import { CommandFleetHostSource } from "./FleetHostSource";
import {
  FleetBootInstrumentation,
  IOS_SIM_CAPACITY_GATE_ENV,
  type IosBootInstrumentation,
} from "./IosBootInstrumentation";

export interface DefaultIosBootInstrumentationOptions {
  simctl: Pick<SimCtl, "executeCommandArgs">;
  timer: Timer;
  env?: NodeJS.ProcessEnv;
  history?: BootDurationHistory;
  /** Runs `ps`/`sysctl` for the gate's host snapshot. */
  executor?: HostCommandExecutor;
}

/**
 * Per-manager instrumentation: boot durations are always recorded; the capacity
 * gate (which shells out to `ps`/`sysctl`) is armed only by
 * {@link IOS_SIM_CAPACITY_GATE_ENV}=1 so existing boot behaviour is unchanged by default.
 */
export function createDefaultIosBootInstrumentation(
  options: DefaultIosBootInstrumentationOptions,
): IosBootInstrumentation {
  const history = options.history ?? new InMemoryBootDurationHistory();
  const gateEnabled = (options.env ?? process.env)[IOS_SIM_CAPACITY_GATE_ENV] === "1";
  const { timer } = options;
  const gate = gateEnabled
    ? new IosSimCapacityGate(
        new IosSimFleetCostCollector(
          new CommandFleetHostSource(
            options.executor ?? new DefaultHostCommandExecutor(),
            timer,
            undefined,
            options.simctl,
          ),
          history,
          timer,
        ),
        timer,
        { env: options.env },
      )
    : undefined;
  return new FleetBootInstrumentation({ history, timer, gate });
}
