import type { SimulatorBootState } from "./SimCtlSupport";

/**
 * Process-wide simulator boot/presentation bookkeeping shared by every
 * `SimCtlClient` instance. Held in one module so tests have a single typed reset
 * seam instead of reaching into private statics.
 */
export const simCtlSharedState = {
  bootPresentationGenerations: new Map<string, string>(),
  simulatorAppPresentations: new Map<
    string,
    { bootGeneration: string; presentation: Promise<void> }
  >(),
  simulatorBoots: new Map<string, SimulatorBootState>(),
};

/** Clears all shared simulator boot state (tests only). */
export function resetSimCtlSharedStateForTesting(): void {
  simCtlSharedState.bootPresentationGenerations.clear();
  simCtlSharedState.simulatorAppPresentations.clear();
  simCtlSharedState.simulatorBoots.clear();
}
