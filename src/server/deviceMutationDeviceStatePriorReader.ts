import type { BootedDevice } from "../models";
import {
  observableMutationValue,
  type MutationValue,
} from "../daemon/sessionBroker/mutations/types";
import {
  parsePowerIntentKey,
  type PowerIntent,
} from "../daemon/sessionBroker/mutations/deviceStateKeys";
import {
  defaultPowerClientFactory,
  type PowerClientFactory,
  type PowerDeviceClient,
} from "../features/utility/power/AndroidPowerClient";
import {
  defaultAdbClientFactory,
  type AdbClientFactory,
} from "../utils/android-cmdline-tools/AdbClientFactory";
import { errorMessage } from "../utils/describeUnknownError";
import { logger } from "../utils/logger";
import type { ToolMutation } from "./deviceMutationAdapters";
import type { MutationPriorReader } from "./deviceMutationPriorReader";

const UNOBSERVABLE: MutationValue = { state: "unobservable" };

async function readIntent(client: PowerDeviceClient, intent: PowerIntent): Promise<MutationValue> {
  switch (intent.field) {
    case "battery":
      return observableMutationValue(await client.readBattery());
    case "doze":
      return observableMutationValue((await client.readDoze()).mode);
    case "thermal":
      return observableMutationValue(await client.readThermal());
    case "dataSaver":
      return observableMutationValue(await client.readDataSaver());
    case "batterySaver": {
      // An unset low_power setting is a real prior: the restore deletes it again.
      const enabled = await client.readBatterySaver();
      return enabled === undefined ? { state: "absent" } : observableMutationValue(enabled);
    }
    case "standby": {
      const bucket = await client.readStandbyBucket(intent.appId);
      return bucket === "unknown" ? UNOBSERVABLE : observableMutationValue(bucket);
    }
    case "inactive":
      return observableMutationValue(await client.readInactive(intent.appId));
  }
}

function isTimeZone(entry: ToolMutation, device: BootedDevice): boolean {
  return entry.kind === "clock" && entry.key === "timezone" && device.platform === "android";
}

/**
 * Priors for the `power:*` intents of `setDeviceState.power` and the `deviceCondition` power
 * faults (#14359). Each is read with the primitive the control writes (`dumpsys battery`,
 * `deviceidle`, `thermalservice`, `settings`, `cmd netpolicy`, `am get-standby-bucket`), so it is
 * the value the Android reset port writes back. A failed or unparseable read, and any intent this
 * reader does not own, is `unobservable`.
 */
export class DeviceStateMutationPriorReader implements MutationPriorReader {
  constructor(
    private readonly clientFor: PowerClientFactory = defaultPowerClientFactory(),
    private readonly adbFactory: AdbClientFactory = defaultAdbClientFactory,
  ) {}

  async read(
    device: BootedDevice,
    mutations: readonly ToolMutation[],
    signal?: AbortSignal,
  ): Promise<readonly MutationValue[]> {
    const intents = mutations.map((entry) =>
      entry.kind === "device-setting" && device.platform === "android"
        ? parsePowerIntentKey(entry.key)
        : null,
    );
    const client = intents.some((intent) => intent !== null) ? this.clientFor(device) : undefined;
    const priors: MutationValue[] = [];
    for (const [index, intent] of intents.entries()) {
      signal?.throwIfAborted();
      if (intent !== null && client) {
        priors.push(await this.observe(client, intent));
      } else if (isTimeZone(mutations[index]!, device)) {
        priors.push(await this.readTimeZone(device, signal));
      } else {
        priors.push(UNOBSERVABLE);
      }
      // A read that failed because the request was cancelled is not an unobservable prior.
      signal?.throwIfAborted();
    }
    return priors;
  }

  /** `persist.sys.timezone`, the property the time zone change writes and `cmd alarm` restores. */
  private async readTimeZone(device: BootedDevice, signal?: AbortSignal): Promise<MutationValue> {
    try {
      const result = await this.adbFactory
        .create(device)
        .executeCommand("shell getprop persist.sys.timezone", { noRetry: true, signal });
      const zone = result.stdout.trim();
      return result.stderr?.trim() || !zone ? UNOBSERVABLE : observableMutationValue(zone);
    } catch (error) {
      logger.warn(`time zone prior read failed: ${errorMessage(error)}`, error);
      return UNOBSERVABLE;
    }
  }

  private async observe(client: PowerDeviceClient, intent: PowerIntent): Promise<MutationValue> {
    try {
      return await readIntent(client, intent);
    } catch (error) {
      logger.warn(`power ${intent.field} prior read failed: ${errorMessage(error)}`, error);
      return UNOBSERVABLE;
    }
  }
}
