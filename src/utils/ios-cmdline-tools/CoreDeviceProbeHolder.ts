import { DOCTOR_EXEC_TIMEOUT_MS } from "../diagnosticTimeouts";
import { DefaultHostCommandExecutor, type HostCommandExecutor } from "../HostCommandExecutor";
import { logger, type Logger } from "../logger";
import { defaultTimer, type Timer } from "../SystemTimer";
import {
  CoreDeviceCapabilityProbe,
  type CoreDeviceGuardVersionProvider,
} from "./CoreDeviceCapabilityProbe";
import { SimCtlClient, type SimCtl } from "./SimCtlClient";
import { SimCtlBootStateProvider } from "./SimCtlBootStateProvider";
import {
  ProductionDevicectlCommandInvoker,
  defaultDevicectlProbeFiles,
  type DevicectlProbeFiles,
} from "./ProductionDevicectlCommandInvoker";

export interface CoreDeviceProbeHolder {
  get(): CoreDeviceCapabilityProbe;
}

export function createProductionCoreDeviceProbe(
  options: {
    executor?: HostCommandExecutor;
    simctl?: Pick<SimCtl, "getDeviceInfo" | "listSimulatorImages">;
    files?: DevicectlProbeFiles;
    timer?: Timer;
    logger?: Pick<Logger, "warn" | "debug">;
    guardVersions?: CoreDeviceGuardVersionProvider;
  } = {},
): CoreDeviceCapabilityProbe {
  const timer = options.timer ?? defaultTimer;
  const log = options.logger ?? logger;
  const invoker = new ProductionDevicectlCommandInvoker({
    executor: options.executor ?? new DefaultHostCommandExecutor(),
    files: options.files ?? defaultDevicectlProbeFiles,
    timer,
    logger: log,
    timeoutMs: DOCTOR_EXEC_TIMEOUT_MS,
  });
  return new CoreDeviceCapabilityProbe({
    commandInvoker: invoker,
    versionSource: invoker,
    bootState: new SimCtlBootStateProvider(options.simctl ?? new SimCtlClient(), {
      timer,
      timeoutMs: DOCTOR_EXEC_TIMEOUT_MS,
    }),
    guardVersions: options.guardVersions,
    logger: log,
  });
}

function lazyHolder(factory: () => CoreDeviceCapabilityProbe): CoreDeviceProbeHolder {
  let probe: CoreDeviceCapabilityProbe | undefined;
  return { get: () => (probe ??= factory()) };
}

/** Each composition root owns its holder; defaults never share test-visible state. */
export function createCoreDeviceProbeHolder(
  options: { factory?: () => CoreDeviceCapabilityProbe } = {},
): CoreDeviceProbeHolder {
  return lazyHolder(options.factory ?? (() => createProductionCoreDeviceProbe()));
}
