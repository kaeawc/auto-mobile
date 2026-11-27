import type { BootedDevice } from "../../models";
import { defaultAdbClientFactory } from "../../utils/android-cmdline-tools/AdbClientFactory";
import { DisplayConfig } from "./DisplayConfig";
import type { DisplayProfilePorts } from "./DisplayProfile";
import { SetPostureControl } from "./SetPostureControl";

export type DisplayProfilePortsFactory = (device: BootedDevice) => DisplayProfilePorts;

export const defaultDisplayProfilePortsFactory: DisplayProfilePortsFactory = (device) => ({
  shell: defaultAdbClientFactory.create(device),
  displayConfig: new DisplayConfig(device),
  posture: new SetPostureControl(device),
});
