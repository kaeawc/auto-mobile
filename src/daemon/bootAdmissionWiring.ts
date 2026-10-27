import { defaultDaemonContext } from "./daemonContext";
import { createIosSimulatorOwnershipReader } from "./iosSimulatorOwnership";
import { createDefaultBindingExclusion } from "./sessionBroker/provisioning/exclusion";
import { installIosSimulatorOwnershipReader } from "../features/bootAdmission/sharedBootAdmissionGates";
import { installBootAdmissionServices } from "../devices/bootAdmissionServices";
import { assertBootCapacityAvailable } from "../features/bootAdmission/sharedBootAdmissionGates";
import { getSharedBootAdmissionGates } from "../features/bootAdmission/sharedBootAdmissionGates";
import { createDefaultIosBootInstrumentation } from "../features/iosSimFleet/defaultIosBootInstrumentation";
import { defaultTimer } from "../utils/SystemTimer";

/**
 * Composition root for boot admission: installs the process-wide shared gates behind the
 * interface the devices tier owns. `src/index.ts` (the only process entry: daemon, CLI and stdio
 * server modes) imports this module before anything that can boot a device;
 * test/lint/bootAdmissionWiringEntry.test.ts guards that.
 */
installIosSimulatorOwnershipReader(
  createIosSimulatorOwnershipReader(createDefaultBindingExclusion(defaultTimer), () =>
    defaultDaemonContext.sessionManager(),
  ),
);

installBootAdmissionServices({
  androidColdBootAdmitter: () => getSharedBootAdmissionGates().android,
  iosBootInstrumentation: () => {
    const gates = getSharedBootAdmissionGates();
    return createDefaultIosBootInstrumentation({
      timer: defaultTimer,
      history: gates.iosBootHistory,
      gate: gates.ios,
    });
  },
  assertBootCapacityAvailable: (platform, options) =>
    assertBootCapacityAvailable(platform, options),
});
