import type { FeatureFlagKey } from "./FeatureFlagDefinitions";
import {
  OUTPUT_REDUCTION_FLAG_SPECS,
  type OutputReductionFlags,
} from "../../utils/outputReductionFlags";

/** One output-reduction CLI/env override that startup persists as a feature flag. */
export interface PersistedOutputReductionOverride {
  key: FeatureFlagKey;
  label: string;
}

/**
 * Output-reduction overrides that startup writes to the shared feature-flag store.
 *
 * Only enabled opt-in flags persist. `actionsCompactMetadata` never does: its
 * on/off choice is a per-connection presentation preference relayed through the
 * connection profile, so persisting a CLI or env override would leak one
 * client's opt-out to every connection of the shared daemon (#10377).
 */
export function persistedOutputReductionOverrides(
  outputReduction: Partial<OutputReductionFlags>,
): PersistedOutputReductionOverride[] {
  return OUTPUT_REDUCTION_FLAG_SPECS.filter(
    (spec) => spec.field !== "actionsCompactMetadata" && outputReduction[spec.field] === true,
  ).map((spec) => ({ key: spec.featureFlagKey, label: spec.label }));
}
