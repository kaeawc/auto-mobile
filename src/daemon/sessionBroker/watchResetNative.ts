import {
  bootAdmissionServices,
  type BootAdmissionServices,
} from "../../devices/bootAdmissionServices";
import type {
  BootReservationOptions,
  BootSlotReservation,
} from "../../devices/bootAdmission/BootSlotReservation";
import { ActionableError } from "../../models/ActionableError";
import { SimCtlClient } from "../../utils/ios-cmdline-tools/SimCtlClient";
import { WatchSimulatorInventory } from "../../utils/ios-cmdline-tools/WatchSimulatorInventory";
import { WatchSimulatorLifecycle } from "../../utils/ios-cmdline-tools/WatchSimulatorLifecycle";
import type { Timer } from "../../utils/SystemTimer";
import type { SessionBrokerHostConfig } from "./hostConfig";
import { iosReusePolicy } from "./hostConfig";
import type { ManagedDevicePortDependencies } from "./managedDevicePort";
import { defaultBindingToolInvoker } from "./provisioning/daemonDeviceAcquisition";
import { readToolPayload } from "./provisioning/reconcilerPorts";
import { WatchSimulatorReset, type WatchResetPolicy } from "./watchReset";

type WatchResetPort = NonNullable<ManagedDevicePortDependencies["resetBaseline"]>["watch"];

/**
 * The watch release reset for the host's iOS reuse mode (#15882): `off` has none (the watch is
 * destroyed on release, like an iPhone); every other mode gets its watch equivalent.
 */
export function watchResetPolicy(config: SessionBrokerHostConfig): WatchResetPolicy | undefined {
  const reuse = iosReusePolicy(config);
  switch (reuse.mode) {
    case "off":
      return undefined;
    case "erase":
      return { mode: "erase" };
    case "keep-booted":
      return { mode: "keep-booted", fallback: reuse.fallback };
    case "minimal":
      return { mode: "minimal" };
  }
}

export function reserveWatchResetBoot(
  options: BootReservationOptions,
  services: Pick<BootAdmissionServices, "iosBootInstrumentation"> = bootAdmissionServices,
): Promise<BootSlotReservation> {
  const instrumentation = services.iosBootInstrumentation();
  return instrumentation.reserveBoot
    ? instrumentation.reserveBoot(options)
    : Promise.resolve({
        run: (operation) => operation(),
        markReplacedDeviceGone: () => {},
        release: () => {},
      });
}

/** The production watch reset: simctl, the simulator boot gate and killDevice's watch path. */
export function nativeWatchReset(config: SessionBrokerHostConfig, timer: Timer): WatchResetPort {
  const policy = watchResetPolicy(config);
  if (!policy) {
    return undefined;
  }
  const simctl = new SimCtlClient(null);
  const reset = new WatchSimulatorReset({
    policy,
    timer,
    simctl,
    lifecycle: new WatchSimulatorLifecycle(simctl, new WatchSimulatorInventory(simctl), {
      run: (request, boot) => bootAdmissionServices.iosBootInstrumentation().run(request, boot),
    }),
    reserveBoot: reserveWatchResetBoot,
    stopDevice: async (device) => {
      // As for an iPhone: the lifecycle handler ends the watch's sessions before the erase.
      const result = readToolPayload(
        await defaultBindingToolInvoker("killDevice", { device }, undefined),
      );
      if (result.isError || result.payload.success === false) {
        throw new ActionableError("Provider watch shutdown did not confirm a clean teardown");
      }
    },
  });
  return (device, profile, assertOwned, options) =>
    reset.resetWithTiming(device, profile, assertOwned, options);
}
