import type { ShadowObservation, ShadowOutcome } from "./types";

export function classifyShadowOutcome(obs: ShadowObservation): ShadowOutcome {
  if (obs.ciResult === "cancelled") {
    return "excluded";
  }
  if (obs.verdict === "skip") {
    return obs.ciResult === "fail" ? "false-hit" : "agree";
  }
  if (obs.hadAttestation && obs.ciResult === "pass") {
    return "false-miss";
  }
  return "agree";
}
