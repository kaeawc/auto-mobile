import { z } from "zod/v4";
import type { BootedDevice } from "../models";
import {
  observableMutationValue as present,
  type MutationValue,
} from "../daemon/sessionBroker/mutations/types";
import {
  AppPreferences,
  isIosSdkEntryRedacted,
  type PreferenceResult,
} from "../features/preferences/AppPreferences";
import type { KeyValueEntry } from "../features/storage/storageTypes";
import { AndroidCtrlProxyClient } from "../features/observe/android/AndroidCtrlProxyClient";
import { IOSCtrlProxyClient } from "../features/observe/ios/IOSCtrlProxyClient";
import { awaitWhileRequestIsLive } from "../utils/toolUtils";
import { logger } from "../utils/logger";
import type { ToolMutation } from "./deviceMutationAdapters";
import type { MutationPriorReader } from "./deviceMutationPriorReader";
import { stripInternalToolParams } from "./internalToolParams";

const identitySchema = z.discriminatedUnion("store", [
  z.object({
    store: z.literal("key-value"),
    appId: z.string(),
    name: z.string(),
    userId: z.number().int().nonnegative().nullable(),
    key: z.string().nullable(),
  }),
  z.object({
    store: z.literal("preference"),
    scope: z.enum(["systemProperty", "sharedPreferences", "userDefaults"]),
    appId: z.string().nullable(),
    suite: z.string().nullable(),
    userId: z.number().int().nonnegative().nullable(),
    key: z.string(),
  }),
]);

type DataIdentity = z.infer<typeof identitySchema>;

function preferencePrior(result: PreferenceResult): MutationValue {
  if (
    !result.success ||
    result.redacted ||
    result.type === "unknown" ||
    result.valueFormat === "sdk-description" ||
    result.storeRoute === "container-plist"
  ) {
    return { state: "unobservable" };
  }
  if (!result.found) {
    return { state: "absent" };
  }
  return result.value === null || result.type === undefined
    ? { state: "unobservable" }
    : present({
        value: result.value,
        type: result.type,
        ...(result.userId === undefined ? {} : { userId: result.userId }),
        ...(result.resolvedStore === undefined ? {} : { resolvedStore: result.resolvedStore }),
      });
}

export interface MutationDataReaders {
  preferencesFor(device: BootedDevice): Pick<AppPreferences, "getPreference">;
  keyValuesFor(
    device: BootedDevice,
  ): { getPreferenceEntries(appId: string, name: string): Promise<KeyValueEntry[]> } | undefined;
}

export class DataMutationPriorReader implements MutationPriorReader {
  private readonly readers: MutationDataReaders;

  constructor(readers: Partial<MutationDataReaders> = {}) {
    this.readers = {
      preferencesFor: readers.preferencesFor ?? ((device) => new AppPreferences(device)),
      keyValuesFor:
        readers.keyValuesFor ??
        ((device) => {
          const client =
            device.platform === "android"
              ? AndroidCtrlProxyClient.getExistingInstance(device.deviceId)
              : IOSCtrlProxyClient.getExistingInstance(device.deviceId);
          return client?.isConnected() ? client : undefined;
        }),
    };
  }

  async read(
    device: BootedDevice,
    mutations: readonly ToolMutation[],
    signal?: AbortSignal,
  ): Promise<readonly MutationValue[]> {
    const priors: MutationValue[] = [];
    for (const mutation of mutations) {
      signal?.throwIfAborted();
      try {
        priors.push(await this.readPrior(device, mutation, signal));
      } catch (error) {
        signal?.throwIfAborted();
        logger.warn("Device data prior-value read failed; recording an unobservable prior", error);
        priors.push({ state: "unobservable" });
      }
    }
    signal?.throwIfAborted();
    return priors;
  }

  private async readPrior(
    device: BootedDevice,
    mutation: ToolMutation,
    signal?: AbortSignal,
  ): Promise<MutationValue> {
    if (mutation.kind !== "preference" || !mutation.key.startsWith("{")) {
      return { state: "unobservable" };
    }
    let identity: unknown;
    try {
      identity = JSON.parse(mutation.key);
    } catch (error) {
      logger.warn("Invalid device data mutation identity; recording an unobservable prior", error);
      return { state: "unobservable" };
    }
    // The internal-metadata guard requires stripping every schema-parse input; identity uses fixed fields.
    const cleanIdentity = stripInternalToolParams(identity);
    const parsed = identitySchema.safeParse(cleanIdentity);
    if (!parsed.success) {
      return { state: "unobservable" };
    }
    const dataIdentity = parsed.data;
    return dataIdentity.store === "key-value"
      ? this.readKeyValues(device, dataIdentity, signal)
      : this.readPreference(device, dataIdentity, signal);
  }

  private async readKeyValues(
    device: BootedDevice,
    identity: Extract<DataIdentity, { store: "key-value" }>,
    signal?: AbortSignal,
  ): Promise<MutationValue> {
    if (device.platform === "android" && identity.userId !== null) {
      return { state: "unobservable" };
    }
    const client = this.readers.keyValuesFor(device);
    if (!client) {
      return { state: "unobservable" };
    }
    const entries = await awaitWhileRequestIsLive(
      client.getPreferenceEntries(identity.appId, identity.name),
      signal,
    );
    const selected =
      identity.key === null ? entries : entries.filter((entry) => entry.key === identity.key);
    if (selected.some((entry) => isIosSdkEntryRedacted(entry) || entry.type === "UNKNOWN")) {
      return { state: "unobservable" };
    }
    const values = selected.filter((entry) => entry.value !== null);
    return identity.key === null
      ? present(values)
      : values.length === 0
        ? { state: "absent" }
        : present(values[0]);
  }

  private async readPreference(
    device: BootedDevice,
    identity: Extract<DataIdentity, { store: "preference" }>,
    signal?: AbortSignal,
  ): Promise<MutationValue> {
    const result = await awaitWhileRequestIsLive(
      this.readers.preferencesFor(device).getPreference({
        scope: identity.scope,
        appId: identity.appId ?? undefined,
        suite: identity.suite ?? undefined,
        userId: identity.userId ?? undefined,
        key: identity.key,
      }),
      signal,
    );
    return preferencePrior(result);
  }
}
