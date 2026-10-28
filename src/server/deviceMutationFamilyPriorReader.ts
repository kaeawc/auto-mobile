import type { BootedDevice } from "../models";
import type { MutationValue } from "../daemon/sessionBroker/mutations/types";
import type { ToolMutation } from "./deviceMutationAdapters";
import type { MutationPriorReader } from "./deviceMutationPriorReader";
import { DataMutationPriorReader } from "./deviceMutationDataPriorReader";
import { AppearanceMutationPriorReader } from "./deviceMutationAppearancePriorReader";
import { InteractionMutationPriorReader } from "./deviceMutationInteractionPriorReader";
import { LifecycleMutationPriorReader } from "./deviceMutationLifecyclePriorReader";
import { OrchestrationMutationPriorReader } from "./deviceMutationOrchestrationPriorReader";
import { PermissionMutationPriorReader } from "./deviceMutationPermissionPriorReader";

/**
 * Asks each tool family's reader in turn; the first that observes a prior wins. A reader reports
 * `unobservable` for intents it does not own, so the families stay independent of one another.
 */
export class FamilyMutationPriorReader implements MutationPriorReader {
  constructor(
    private readonly readers: readonly MutationPriorReader[] = [
      new DataMutationPriorReader(),
      new AppearanceMutationPriorReader(),
      new LifecycleMutationPriorReader(),
      new InteractionMutationPriorReader(),
      new OrchestrationMutationPriorReader(),
      new PermissionMutationPriorReader(),
    ],
  ) {}

  async read(
    device: BootedDevice,
    mutations: readonly ToolMutation[],
    signal?: AbortSignal,
  ): Promise<readonly MutationValue[]> {
    const results = await Promise.all(
      this.readers.map((reader) => reader.read(device, mutations, signal)),
    );
    return mutations.map(
      (_mutation, index): MutationValue =>
        results
          .map((priors) => priors[index])
          .find((prior) => prior !== undefined && prior.state !== "unobservable") ?? {
          state: "unobservable",
        },
    );
  }
}
