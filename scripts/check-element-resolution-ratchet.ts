import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const INITIAL_BASELINE_SHA256 = "b329c96f1dd1263982a92b952fd9d099d6e7ba9a8498765270043836cc32345c";
const INITIAL_SIGNATURE_SHA256 = "87531c89409eceb7d4d815126c3461acd6d759e46786fc6b89eb1532333b4b9f";

function signatures(raw: string): Record<string, string | null> {
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Expected contract signature mapping");
  }
  if (Object.values(parsed).some((value) => value !== null && typeof value !== "string")) {
    throw new Error("Invalid contract signature");
  }
  return parsed as Record<string, string | null>;
}

export function assertSignatureRatchetDoesNotDrift(
  current: string,
  baseline: string | undefined,
): void {
  const currentSignatures = signatures(current);
  const currentEntries = Object.entries(currentSignatures).map((entry) => JSON.stringify(entry));
  if (baseline === undefined) {
    if (
      createHash("sha256").update(currentEntries.sort().join("\n")).digest("hex") !==
      INITIAL_SIGNATURE_SHA256
    ) {
      throw new Error("Only the reviewed initial contract signatures may bootstrap the ratchet");
    }
    return;
  }
  const baselineSignatures = signatures(baseline);
  const drift = Object.entries(currentSignatures).filter(
    ([key, value]) => !(key in baselineSignatures) || baselineSignatures[key] !== value,
  );
  if (drift.length) {
    throw new Error(`Element-resolution signatures may only shrink:\n${JSON.stringify(drift)}`);
  }
}

function entries(raw: string): string[] {
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Expected finding-to-cases object");
  }
  return Object.entries(parsed).flatMap(([finding, cases]) => {
    if (!Array.isArray(cases) || cases.some((entry) => typeof entry !== "string")) {
      throw new Error(`Invalid cases for ${finding}`);
    }
    return cases.map((entry: string) => JSON.stringify([finding, entry]));
  });
}

export function assertRatchetDoesNotGrow(current: string, baseline: string | undefined): void {
  const currentEntries = entries(current);
  if (new Set(currentEntries).size !== currentEntries.length) {
    throw new Error("Duplicate contract exceptions");
  }
  if (baseline === undefined) {
    if (
      createHash("sha256").update(currentEntries.sort().join("\n")).digest("hex") !==
      INITIAL_BASELINE_SHA256
    ) {
      throw new Error("Only the reviewed initial contract baseline may bootstrap the ratchet");
    }
    return;
  }
  const allowed = new Set(entries(baseline));
  const additions = currentEntries.filter((entry) => !allowed.has(entry));
  if (additions.length) {
    throw new Error(`Element-resolution exceptions may only shrink:\n${additions.join("\n")}`);
  }
}

if (import.meta.main) {
  const [currentPath, baselinePath, signaturePath, signatureBaselinePath] = process.argv.slice(2);
  assertRatchetDoesNotGrow(
    readFileSync(currentPath, "utf8"),
    baselinePath ? readFileSync(baselinePath, "utf8") : undefined,
  );
  if (signaturePath) {
    assertSignatureRatchetDoesNotDrift(
      readFileSync(signaturePath, "utf8"),
      signatureBaselinePath ? readFileSync(signatureBaselinePath, "utf8") : undefined,
    );
  }
}
