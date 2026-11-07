import type { DeviceToolsDependencies } from "../features/deviceLifecycle/deviceLifecycleCore";
import { defaultSimulatorPairService } from "../utils/ios-cmdline-tools/SimulatorPairs";

/** The watch–iPhone pair service every watch tool uses: the injected override, else simctl. */
export function configuredSimulatorPairService(
  deps: Pick<DeviceToolsDependencies, "simulatorPairServiceFactory">,
) {
  return (deps.simulatorPairServiceFactory ?? defaultSimulatorPairService)();
}
