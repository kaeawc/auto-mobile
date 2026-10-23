import type { BootedDevice } from "../models";
import {
  SCREEN_STATE_MUTATION_KEY,
  screenStatePriorValue,
} from "../daemon/sessionBroker/mutations/screenStateMutation";
import type { MutationValue } from "../daemon/sessionBroker/mutations/types";
import { defaultAdbClientFactory } from "../utils/android-cmdline-tools/AdbClientFactory";
import type { AdbExecutor } from "../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { logger } from "../utils/logger";
import { awaitWhileRequestIsLive } from "../utils/toolUtils";
import type { ToolMutation } from "./deviceMutationAdapters";
import type { MutationPriorReader } from "./deviceMutationPriorReader";

type ScreenStateAdb = Pick<AdbExecutor, "getWakefulness" | "getDeviceLock">;

function isScreenState(entry: ToolMutation): boolean {
  return entry.kind === "device-setting" && entry.key === SCREEN_STATE_MUTATION_KEY;
}

/** Reads the trustworthy prior of the Interaction intents; every other intent stays unobservable. */
export class InteractionMutationPriorReader implements MutationPriorReader {
  constructor(
    private readonly adbFor: (device: BootedDevice) => ScreenStateAdb = (device) =>
      defaultAdbClientFactory.create(device),
  ) {}

  async read(
    device: BootedDevice,
    mutations: readonly ToolMutation[],
    signal?: AbortSignal,
  ): Promise<readonly MutationValue[]> {
    const screen =
      device.platform === "android" && mutations.some(isScreenState)
        ? await this.readScreenState(device, signal)
        : ({ state: "unobservable" } satisfies MutationValue);
    return mutations.map((entry): MutationValue =>
      isScreenState(entry) ? screen : { state: "unobservable" },
    );
  }

  /** Wakefulness and keyguard through the adb client's own parsers; an unreadable half is unobservable. */
  private async readScreenState(
    device: BootedDevice,
    signal?: AbortSignal,
  ): Promise<MutationValue> {
    try {
      const adb = this.adbFor(device);
      const wakefulness = await awaitWhileRequestIsLive(adb.getWakefulness(signal), signal);
      const lock = await awaitWhileRequestIsLive(adb.getDeviceLock(signal), signal);
      if (wakefulness === null || lock === null) {
        return { state: "unobservable" };
      }
      return screenStatePriorValue({
        awake: wakefulness === "Awake",
        keyguardShowing: lock.keyguardShowing,
        secure: lock.secure ?? null,
      });
    } catch (error) {
      signal?.throwIfAborted();
      logger.warn("Screen-state prior read failed; recording an unobservable prior", error);
      return { state: "unobservable" };
    }
  }
}
