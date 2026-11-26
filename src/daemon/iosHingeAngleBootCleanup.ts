import {
  defaultIosRequestedHingeAngleStore,
  type IosRequestedHingeAngleStore,
} from "../features/device/DuoHingeLayout";
import {
  simulatorBootHooks,
  type SimulatorBootHooks,
} from "../utils/ios-cmdline-tools/simulatorBootHooks";

/**
 * An iPhone Duo simulator comes back from a boot folded on its cover panel, whatever angle
 * setPosture requested before (#19406). Forget that angle on every AutoMobile boot so observe and
 * getDeviceState stop reporting it. A release keeps it: the hinge of a booted simulator does not
 * move when its session ends, and neither does a `bootstatus -b` that found the simulator already
 * running.
 */
export function registerIosHingeAngleBootCleanup(
  hooks: Pick<SimulatorBootHooks, "onBooted"> = simulatorBootHooks,
  store: Pick<IosRequestedHingeAngleStore, "forget"> = defaultIosRequestedHingeAngleStore,
): () => void {
  return hooks.onBooted((udid, info) => {
    if (!info.wasAlreadyBooted) {
      store.forget(udid);
    }
  });
}
