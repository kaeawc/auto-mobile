import type { BootedDevice } from "../models";
import type { MutationValue } from "../daemon/sessionBroker/mutations/types";
import { isStoreKitMutation } from "../daemon/sessionBroker/mutations/storeKitSession";
import type { ToolMutation } from "./deviceMutationAdapters";
import type { MutationPriorReader } from "./deviceMutationPriorReader";

/**
 * The prior of a `storekit` row (#18399) on iOS is `absent`: every keep-booted reset clears the
 * session of each journaled bundle id and every erase restarts the runner, so a session starts
 * with no StoreKit test session. Every other intent stays unobservable.
 */
export class StoreKitMutationPriorReader implements MutationPriorReader {
  async read(
    device: BootedDevice,
    mutations: readonly ToolMutation[],
  ): Promise<readonly MutationValue[]> {
    return mutations.map((entry): MutationValue =>
      device.platform === "ios" && isStoreKitMutation(entry)
        ? { state: "absent" }
        : { state: "unobservable" },
    );
  }
}
