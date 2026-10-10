import {
  DefaultHostCommandExecutor,
  type HostCommandExecutor,
} from "../../utils/HostCommandExecutor";
import type { SimCtl } from "../../utils/ios-cmdline-tools/SimCtlClient";
import type { Timer } from "../../utils/SystemTimer";
import { isBootCapacityGateEnabled } from "../bootAdmission/BootAdmissionGate";
import { InMemoryBootDurationHistory, type BootDurationHistory } from "./BootDurationHistory";
import { IosSimCapacityGate, type SimulatorCapacityGate } from "./CapacityGate";
import { IosSimFleetCostCollector } from "./FleetCostCollector";
import { CommandFleetHostSource } from "./FleetHostSource";
import { FleetBootInstrumentation, type IosBootInstrumentation } from "./IosBootInstrumentation";

export interface IosSimCapacityGateOptions {
  simctl: Pick<SimCtl, "executeCommandArgs">;
  timer: Timer;
  history: BootDurationHistory;
  env?: NodeJS.ProcessEnv;
  /** Runs `ps`/`sysctl` for the gate's host snapshot. */
  executor?: HostCommandExecutor;
}

/**
 * The simulator capacity gate when the environment leaves it enabled (the
 * default since #11181), else undefined. See `isBootCapacityGateEnabled` for
 * `AUTOMOBILE_BOOT_CAPACITY_GATE` and the `AUTOMOBILE_IOS_SIM_CAPACITY_GATE` override.
 */
export function createIosSimCapacityGate(
  options: IosSimCapacityGateOptions,
): IosSimCapacityGate | undefined {
  const env = options.env ?? process.env;
  if (!isBootCapacityGateEnabled("ios", env)) {
    return undefined;
  }
  const { timer } = options;
  return new IosSimCapacityGate(
    new IosSimFleetCostCollector(
      new CommandFleetHostSource(
        options.executor ?? new DefaultHostCommandExecutor(),
        timer,
        undefined,
        options.simctl,
      ),
      options.history,
      timer,
    ),
    timer,
    { env },
  );
}

export interface DefaultIosBootInstrumentationOptions {
  timer: Timer;
  /** Shared with the gate so warm-device matching sees recorded boots. */
  history?: BootDurationHistory;
  /** Absent means boots are not gated; durations are still recorded. */
  gate?: SimulatorCapacityGate;
}

/** Per-manager instrumentation: boot durations are always recorded; boots wait on `gate` when given. */
export function createDefaultIosBootInstrumentation(
  options: DefaultIosBootInstrumentationOptions,
): IosBootInstrumentation {
  return new FleetBootInstrumentation({
    history: options.history ?? new InMemoryBootDurationHistory(),
    timer: options.timer,
    gate: options.gate,
  });
}
