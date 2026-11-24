import type { BootedDevice, ExecResult } from "../models";
import {
  SIMULATOR_HARDWARE_KEYBOARD_KEY,
  SIMULATOR_KEYBOARD_LANGUAGE_KEY,
  simulatorHardwareKeyboardPrior,
  simulatorKeyboardLanguagePrior,
} from "../daemon/sessionBroker/mutations/simulatorKeyboardMutation";
import type { MutationValue } from "../daemon/sessionBroker/mutations/types";
import { isIosSimulatorDevice } from "../features/action/IosSimulatorPermissions";
import { looksLikeMissingIosDefault } from "../features/preferences/preferenceValues";
import { errorMessage } from "../utils/describeUnknownError";
import { SimCtlClient } from "../utils/ios-cmdline-tools/SimCtlClient";
import { parsePlist } from "../utils/ios-cmdline-tools/XctestrunPlist";
import { logger } from "../utils/logger";
import type { ToolMutation } from "./deviceMutationAdapters";
import type { MutationPriorReader } from "./deviceMutationPriorReader";

const UNOBSERVABLE: MutationValue = { state: "unobservable" };
const READ_TIMEOUT_MS = 10_000;

export interface KeyboardPriorSimctl {
  executeCommandArgs(args: string[], timeoutMs?: number, signal?: AbortSignal): Promise<ExecResult>;
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string")
    ? value
    : undefined;
}

/**
 * Priors of `setDeviceState.keyboard` rows on an iOS Simulator (#19017). The hardware keyboard has
 * no read-back and every boot connects it, so its prior is the boot state. The language prior is
 * read with the `defaults` the change rewrites: `AppleKeyboards` and `AppleLanguages` in
 * `.GlobalPreferences`, and `KeyboardLastUsed` in `com.apple.keyboard.preferences`, plus
 * `AppleLocale`; an unset key is null. A list that is present but not all strings is recorded as
 * null too, and restored by deleting it. Every other
 * intent, and every other device, stays unobservable.
 */
export class KeyboardMutationPriorReader implements MutationPriorReader {
  constructor(
    private readonly simctlFor: (device: BootedDevice) => KeyboardPriorSimctl = (device) =>
      new SimCtlClient(device),
  ) {}

  async read(
    device: BootedDevice,
    mutations: readonly ToolMutation[],
    signal?: AbortSignal,
  ): Promise<readonly MutationValue[]> {
    const simulator = device.platform === "ios" && isIosSimulatorDevice(device);
    const priors: MutationValue[] = [];
    for (const entry of mutations) {
      if (!simulator || entry.kind !== "keyboard") {
        priors.push(UNOBSERVABLE);
      } else if (entry.key === SIMULATOR_HARDWARE_KEYBOARD_KEY) {
        priors.push(simulatorHardwareKeyboardPrior());
      } else if (entry.key === SIMULATOR_KEYBOARD_LANGUAGE_KEY) {
        priors.push(await this.readLanguagePrior(device, signal));
      } else {
        priors.push(UNOBSERVABLE);
      }
    }
    return priors;
  }

  private async readLanguagePrior(
    device: BootedDevice,
    signal?: AbortSignal,
  ): Promise<MutationValue> {
    const simctl = this.simctlFor(device);
    const udid = device.deviceId;
    try {
      const globals = await parsePlist(
        (
          await simctl.executeCommandArgs(
            ["spawn", udid, "defaults", "export", "-g", "-"],
            READ_TIMEOUT_MS,
            signal,
          )
        ).stdout,
      );
      const entries = globals instanceof Map ? globals : new Map<string, unknown>();
      const locale = entries.get("AppleLocale");
      return simulatorKeyboardLanguagePrior({
        keyboards: stringArray(entries.get("AppleKeyboards")) ?? null,
        languages: stringArray(entries.get("AppleLanguages")) ?? null,
        current: await this.readCurrent(simctl, udid, signal),
        locale: typeof locale === "string" && locale ? locale : null,
      });
    } catch (error) {
      signal?.throwIfAborted();
      logger.warn(`keyboard language prior read failed: ${errorMessage(error)}`, error);
      return UNOBSERVABLE;
    }
  }

  private async readCurrent(
    simctl: KeyboardPriorSimctl,
    udid: string,
    signal?: AbortSignal,
  ): Promise<string | null> {
    try {
      const result = await simctl.executeCommandArgs(
        ["spawn", udid, "defaults", "read", "com.apple.keyboard.preferences", "KeyboardLastUsed"],
        READ_TIMEOUT_MS,
        signal,
      );
      return result.stdout.trim() || null;
    } catch (error) {
      if (!looksLikeMissingIosDefault(error)) {
        throw error;
      }
      // A simulator whose keyboard was never switched has no KeyboardLastUsed.
      logger.debug(`KeyboardLastUsed is unset on ${udid}: ${errorMessage(error)}`);
      return null;
    }
  }
}
