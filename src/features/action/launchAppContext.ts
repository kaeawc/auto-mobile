import type { BootedDevice } from "../../models";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import type { Timer } from "../../utils/SystemTimer";
import type { DeviceWindowCacheInvalidator } from "./TerminateApp";
import type { ObserveScreen } from "../observe/interfaces/ObserveScreen";

/**
 * Live view of the LaunchApp state its collaborators read. Resolved on every
 * access because the base class replaces `adb`/`observeScreen` after construction.
 */
export interface LaunchAppContext {
  device: BootedDevice;
  adb: AdbExecutor;
  timer: Timer;
  observeScreen: ObserveScreen;
  cacheInvalidator: DeviceWindowCacheInvalidator;
}

export type LaunchAppContextProvider = () => LaunchAppContext;
