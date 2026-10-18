import type { BootedDevice } from "../../models";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";

/** The slice of an ADB client the H.264 capture sources use: one-shot commands and streaming spawns. */
export type VideoSourceAdb = Pick<AdbExecutor, "executeCommand" | "spawn">;

/** Creates the {@link VideoSourceAdb} for a device; `AdbClientFactory` satisfies it structurally. */
export interface VideoSourceAdbFactory {
  create(device?: BootedDevice | null): VideoSourceAdb;
}
