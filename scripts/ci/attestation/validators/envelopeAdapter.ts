import type { AttestationEnvelope } from "../attestationSchema";
import type { VerificationResult } from "./trustPolicy";

/** This is validation evidence, never a second wire-envelope schema. */
export interface ValidationEvidence {
  envelope: AttestationEnvelope;
  verification: VerificationResult;
}

/** Canonical producer environment projected into the policy's flat version vocabulary. */
export function policyEnvironment(
  environment: AttestationEnvelope["payload"]["environment"],
): Readonly<Record<string, string>> {
  const projected: Record<string, string> = {
    ...environment.toolVersions,
    os: environment.os,
    arch: environment.arch,
    ...(environment.bunVersion === null ? {} : { bun: environment.bunVersion }),
  };
  if (environment.bunVersion === null) {
    delete projected.bun;
  }
  return projected;
}

/** Base/task/key/identity are verifier-bound claims, never unauthenticated payload additions. */
export function adaptEnvelope(
  envelope: AttestationEnvelope,
  verification: VerificationResult,
): ValidationEvidence {
  return { envelope, verification };
}
