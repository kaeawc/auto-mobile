import type { BootedDevice } from "../models";
import type { MutationValue } from "../daemon/sessionBroker/mutations/types";
import type { ToolMutation } from "./deviceMutationAdapters";
import type { MutationPriorReader } from "./deviceMutationPriorReader";

/** Reads the trustworthy prior of the Interaction intents; every other intent stays unobservable. */
export class InteractionMutationPriorReader implements MutationPriorReader {
  async read(
    _device: BootedDevice,
    mutations: readonly ToolMutation[],
    _signal?: AbortSignal,
  ): Promise<readonly MutationValue[]> {
    return mutations.map((): MutationValue => ({ state: "unobservable" }));
  }
}
