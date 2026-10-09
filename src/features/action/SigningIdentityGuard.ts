import type { PackageSigningInspection } from "../../models/PackageSigningInspection";
import { SigningGuardError } from "../../models/SigningGuardError";
import { normalizeSignerSet, signerSetsEqual } from "../../utils/signingIdentity";

/** The slice of {@link InspectPackageSigning} the guard needs. */
export interface PackageSigningInspector {
  execute(
    appId: string,
    options?: { userId?: number; signal?: AbortSignal },
  ): Promise<PackageSigningInspection>;
}

/**
 * Reads the package fresh for one explicit user and requires its complete signer set to equal
 * `expectedSha256`. Returns the inspection when the package is absent so a caller that treats
 * absence as "nothing to replace" can continue; every other non-matching outcome throws a
 * {@link SigningGuardError} before the caller mutates anything.
 */
export async function checkSigningIdentity(
  inspector: PackageSigningInspector,
  appId: string,
  userId: number,
  expectedSha256: readonly string[],
  signal?: AbortSignal,
): Promise<PackageSigningInspection> {
  const expected = normalizeSignerSet(expectedSha256);
  const inspection = await inspector.execute(appId, { userId, signal });
  const details = { appId, userId, expectedSha256: expected };
  if (inspection.userId !== userId) {
    // Inspection must stay on the profile the mutation targets; never accept another one.
    throw new SigningGuardError(
      "presence-unknown",
      `Signing check for ${appId} inspected user ${inspection.userId} instead of user ${userId}`,
      details,
    );
  }
  if (inspection.presence === "unknown") {
    throw new SigningGuardError(
      "presence-unknown",
      `Cannot confirm the signing identity of ${appId} for user ${userId}: ` +
        `${inspection.unknownReason ?? "package presence is unknown"}`,
      details,
    );
  }
  if (inspection.presence === "absent") {
    return inspection;
  }
  if (inspection.signing.status !== "available") {
    throw new SigningGuardError(
      "signing-unavailable",
      `Cannot confirm the signing identity of ${appId} for user ${userId}: ${inspection.signing.reason}`,
      details,
    );
  }
  const actual = inspection.signing.signerSha256;
  if (!signerSetsEqual(actual, expected)) {
    throw new SigningGuardError(
      "mismatch",
      `${appId} for user ${userId} is signed by ${actual.join(", ")}, not the expected ` +
        `${expected.join(", ")}; left unchanged`,
      { ...details, actualSha256: actual },
    );
  }
  return inspection;
}
