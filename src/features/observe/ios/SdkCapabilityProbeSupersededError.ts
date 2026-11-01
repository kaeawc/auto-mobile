import { ActionableError } from "../../../models/ActionableError";

export type IosSdkCapability =
  | "hierarchy"
  | "network_mocking"
  | "network_fault_rules"
  | "network_error_simulation"
  | "database"
  | "highlight"
  | "magic_tap";

/**
 * A capability waiter was created under one probe generation, but a hierarchy
 * update (foreground app change, reconnect, SDK failure) invalidated that
 * generation before its probe answered. The replacement generation's result
 * belongs to a different foreground app and must never authorize this waiter
 * (#6896): callers either retry against the new generation or fail actionably.
 */
export class SdkCapabilityProbeSupersededError extends ActionableError {
  constructor(
    readonly capability: IosSdkCapability | "observation_bridge",
    readonly probeGeneration: number,
    readonly currentGeneration: number,
  ) {
    super(
      `The AutoMobile SDK capability probe for ${capability} (generation ${probeGeneration}) was superseded by a newer foreground state (generation ${currentGeneration}); re-observe and retry against the current foreground app.`,
    );
    this.name = "SdkCapabilityProbeSupersededError";
  }
}
