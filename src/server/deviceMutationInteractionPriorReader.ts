import type { BootedDevice } from "../models";
import {
  SCREEN_STATE_MUTATION_KEY,
  screenStatePriorValue,
} from "../daemon/sessionBroker/mutations/screenStateMutation";
import type { MutationValue } from "../daemon/sessionBroker/mutations/types";
import {
  parseVolumeReadOutput,
  volumeMutationStreams,
  volumePriorValue,
  volumeReadScript,
} from "../daemon/sessionBroker/mutations/volumeMutation";
import { defaultAdbClientFactory } from "../utils/android-cmdline-tools/AdbClientFactory";
import type { AdbExecutor } from "../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { logger } from "../utils/logger";
import { shellQuote } from "../utils/shellQuote";
import { awaitWhileRequestIsLive } from "../utils/toolUtils";
import type { ToolMutation } from "./deviceMutationAdapters";
import type { MutationPriorReader } from "./deviceMutationPriorReader";

type InteractionAdb = Pick<AdbExecutor, "getWakefulness" | "getDeviceLock" | "executeCommand">;

/** One `cmd media_session volume --get` per covered stream, run in a single device shell. */
const VOLUME_READ_TIMEOUT_MS = 10_000;

function isScreenState(entry: ToolMutation): boolean {
  return entry.kind === "device-setting" && entry.key === SCREEN_STATE_MUTATION_KEY;
}

function isVolume(entry: ToolMutation): boolean {
  return entry.kind === "device-setting" && volumeMutationStreams(entry.key) !== null;
}

/** Reads the trustworthy prior of the Interaction intents; every other intent stays unobservable. */
export class InteractionMutationPriorReader implements MutationPriorReader {
  constructor(
    private readonly adbFor: (device: BootedDevice) => InteractionAdb = (device) =>
      defaultAdbClientFactory.create(device),
  ) {}

  async read(
    device: BootedDevice,
    mutations: readonly ToolMutation[],
    signal?: AbortSignal,
  ): Promise<readonly MutationValue[]> {
    const android = device.platform === "android";
    const screen =
      android && mutations.some(isScreenState)
        ? await this.readScreenState(device, signal)
        : ({ state: "unobservable" } satisfies MutationValue);
    const values: MutationValue[] = [];
    for (const entry of mutations) {
      if (isScreenState(entry)) {
        values.push(screen);
      } else if (android && isVolume(entry)) {
        values.push(await this.readVolume(device, entry.key, signal));
      } else {
        values.push({ state: "unobservable" });
      }
    }
    return values;
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

  /** The live level of every stream the row covers; any unreadable stream makes it unobservable. */
  private async readVolume(
    device: BootedDevice,
    key: string,
    signal?: AbortSignal,
  ): Promise<MutationValue> {
    const streams = volumeMutationStreams(key) ?? [];
    try {
      const result = await awaitWhileRequestIsLive(
        this.adbFor(device).executeCommand(`shell sh -c ${shellQuote(volumeReadScript(streams))}`, {
          timeoutMs: VOLUME_READ_TIMEOUT_MS,
          signal,
        }),
        signal,
      );
      const levels = parseVolumeReadOutput(result.stdout, streams);
      if (!levels) {
        logger.warn(`Volume prior for ${key} is unreadable; recording an unobservable prior`);
        return { state: "unobservable" };
      }
      return volumePriorValue(key, levels);
    } catch (error) {
      signal?.throwIfAborted();
      logger.warn("Volume prior read failed; recording an unobservable prior", error);
      return { state: "unobservable" };
    }
  }
}
