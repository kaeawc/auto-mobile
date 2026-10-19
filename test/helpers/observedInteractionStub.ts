import { FakeTapStrategy } from "../fakes/FakeTapStrategy";
import type { BaseVisualChange } from "../../src/features/action/BaseVisualChange";
import { asObservedResult } from "../../src/features/action/observedInteractionStages";
import type { ObservedEnvelope } from "../../src/features/action/observedInteractionTypes";
import type { ObserveResult } from "../../src/models";

/** The `observedInteraction` signature, so stubs are checked against the real generic contract. */
export type ObservedInteractionImpl = BaseVisualChange["observedInteraction"];

type ObservationSource = ObserveResult | (() => ObserveResult | Promise<ObserveResult>);

async function resolveObservation(source: ObservationSource): Promise<ObserveResult> {
  return typeof source === "function" ? source() : source;
}

/**
 * Stands in for the pre/post observation loop: runs the action block once against `observation`
 * (or the thunk's result, resolved per call) and returns the block's own result untouched.
 */
export function runBlockWith(observation: ObservationSource): ObservedInteractionImpl {
  return async (block) => asObservedResult(await block(await resolveObservation(observation)));
}

/** As {@link runBlockWith}, merging `envelope` (e.g. the post-action `observation`) into the result. */
export function runBlockWithEnvelope(
  observation: ObservationSource,
  envelope: ObservedEnvelope,
  afterBlock?: () => void,
): ObservedInteractionImpl {
  return async (block) => {
    const result = asObservedResult(await block(await resolveObservation(observation)));
    afterBlock?.();
    return { ...result, ...envelope };
  };
}

/** No observation-loop side effects: these tests drive the phases explicitly. */
export function isolatedTapStrategy(): FakeTapStrategy {
  const strategy = new FakeTapStrategy();
  strategy.warnsOnDisabledElement = false;
  strategy.settlesPostTapChange = false;
  strategy.verifiesRefreshedDisplay = false;
  strategy.promotesClickableAncestor = false;
  return strategy;
}
