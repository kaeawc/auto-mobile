import type { BootedDevice } from "../models";
import type { MutationValue } from "../daemon/sessionBroker/mutations/types";
import {
  AdbLocalizationPriorSource,
  type LocalizationPriorSource,
  type RawSettingRead,
} from "../features/utility/system-configuration/AndroidLocalizationPriorSource";
import { appLocaleJournalAppId } from "../daemon/sessionBroker/appLocaleJournalKey";
import { defaultAdbClientFactory } from "../utils/android-cmdline-tools/AdbClientFactory";
import { logger } from "../utils/logger";
import { awaitWhileRequestIsLive } from "../utils/toolUtils";
import type { ToolMutation } from "./deviceMutationAdapters";
import type { MutationPriorReader } from "./deviceMutationPriorReader";

const UNOBSERVABLE: MutationValue = { state: "unobservable" };

function rowValue(read: RawSettingRead): string | null | undefined {
  return read.readable ? read.value : undefined;
}

/**
 * Reads the Android priors of changeLocalization's `device-setting` rows, in the shapes the
 * keep-booted reset restores; every other intent, and every iOS intent, stays unobservable.
 * - `["app-locale", appId]`: `{ userId, locales }`, the app's locale list (`""` for no override)
 *   for the user the tool targets. Below Android 13 the tool changes the device-wide locale
 *   instead, so no prior is recorded.
 * - `textDirection`: the raw `global` rows `debug.force_rtl,force_rtl` joined by a comma, with
 *   `null` for an unset row.
 * `calendarSystem` keeps the device-setting read's prior, which device-setting defaults share.
 */
export class LocalizationMutationPriorReader implements MutationPriorReader {
  constructor(
    private readonly sourceFor: (device: BootedDevice) => LocalizationPriorSource = (device) =>
      new AdbLocalizationPriorSource(defaultAdbClientFactory.create(device)),
  ) {}

  async read(
    device: BootedDevice,
    mutations: readonly ToolMutation[],
    signal?: AbortSignal,
  ): Promise<readonly MutationValue[]> {
    if (device.platform !== "android") {
      return mutations.map(() => UNOBSERVABLE);
    }
    const priors: MutationValue[] = [];
    for (const entry of mutations) {
      priors.push(
        entry.kind === "device-setting"
          ? await this.readPrior(device, entry.key, signal)
          : UNOBSERVABLE,
      );
    }
    return priors;
  }

  private async readPrior(
    device: BootedDevice,
    key: string,
    signal?: AbortSignal,
  ): Promise<MutationValue> {
    const appId = appLocaleJournalAppId(key);
    if (appId === null && key !== "textDirection") {
      return UNOBSERVABLE;
    }
    try {
      return await awaitWhileRequestIsLive(
        this.readKnownPrior(this.sourceFor(device), key, appId, signal),
        signal,
      );
    } catch (error) {
      signal?.throwIfAborted();
      logger.warn(
        `Localization prior read failed for ${key}; recording an unobservable prior`,
        error,
      );
      return UNOBSERVABLE;
    }
  }

  private async readKnownPrior(
    source: LocalizationPriorSource,
    key: string,
    appId: string | null,
    signal?: AbortSignal,
  ): Promise<MutationValue> {
    if (appId !== null) {
      const locales = await source.readAppLocales(appId, signal);
      return locales
        ? { state: "present", value: { userId: locales.userId, locales: locales.locales } }
        : UNOBSERVABLE;
    }
    const debugForceRtl = rowValue(
      await source.readSettingRow("global", "debug.force_rtl", signal),
    );
    const forceRtl = rowValue(await source.readSettingRow("global", "force_rtl", signal));
    return debugForceRtl === undefined || forceRtl === undefined
      ? UNOBSERVABLE
      : { state: "present", value: `${debugForceRtl ?? "null"},${forceRtl ?? "null"}` };
  }
}
