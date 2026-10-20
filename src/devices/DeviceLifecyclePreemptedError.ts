import { ActionableError } from "../models";
import type { VirtualDeviceLifecycleIdentity } from "./virtualDeviceLifecycleCoordinator";

export class DeviceLifecyclePreemptedError extends ActionableError {
  constructor(identity: VirtualDeviceLifecycleIdentity) {
    super(
      `Device lifecycle work for ${identity.platform}:${
        identity.kind === "stable" ? identity.stableId : identity.selector
      } was preempted by teardown`,
    );
    this.name = "DeviceLifecyclePreemptedError";
  }
}
