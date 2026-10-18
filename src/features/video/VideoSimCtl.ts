import type { BootedDevice } from "../../models";
import { SimCtlClient, type SimCtl } from "../../utils/ios-cmdline-tools/SimCtlClient";

/** The simctl surface iOS video recording consumes; narrow so tests can fake just these. */
export type VideoSimCtl = Pick<
  SimCtl,
  "isAvailable" | "enumerateDisplays" | "startCommandArgs" | "executeCommandArgs"
>;

export const createVideoSimCtl = (device: BootedDevice): VideoSimCtl => new SimCtlClient(device);
