import { SimCtlClient, SimCtl } from "../../utils/ios-cmdline-tools/SimCtlClient";
import type { SimCtlClientFactory } from "./PerformanceMonitor";

/**
 * Default factory that creates real SimCtlClient instances.
 */
export class DefaultSimCtlClientFactory implements SimCtlClientFactory {
  create(deviceId: string): SimCtl {
    return new SimCtlClient({ deviceId, name: deviceId, platform: "ios" });
  }
}
