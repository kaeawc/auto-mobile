import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const INITIAL_BASELINE_SHA256 = "b329c96f1dd1263982a92b952fd9d099d6e7ba9a8498765270043836cc32345c";
const INITIAL_SIGNATURE_SHA256 = "87531c89409eceb7d4d815126c3461acd6d759e46786fc6b89eb1532333b4b9f";
// The reviewed focus-input fixture extension adds nine recorded legacy gaps.
// The exact digest permits this one contract expansion while keeping future growth gated.
const FOCUS_BASELINE_SHA256 = "de44394bfd0b94fcc979a112ca0bc45dd37e1336b7b987caa3533642e74c6ed7";
const FOCUS_SIGNATURE_SHA256 = "262630c6315a6cfe945008abb58d52274dd5188903df949d0c239c95a785dd5b";
const INITIAL_CASE_KEYS_SHA256 = "8c9983421c0379cb2bf76f4ca3745c7e1b280507c3cc12f46241890cec157191";
const digest = (entries: string[]) =>
  createHash("sha256").update(entries.sort().join("\n")).digest("hex");

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
    if (![INITIAL_SIGNATURE_SHA256, FOCUS_SIGNATURE_SHA256].includes(digest(currentEntries))) {
      throw new Error("Only the reviewed initial contract signatures may bootstrap the ratchet");
    }
    return;
  }
  const baselineSignatures = signatures(baseline);
  const drift = Object.entries(currentSignatures).filter(
    ([key, value]) => !(key in baselineSignatures) || baselineSignatures[key] !== value,
  );
  const focusExpansion =
    digest(Object.entries(baselineSignatures).map((entry) => JSON.stringify(entry))) ===
      INITIAL_SIGNATURE_SHA256 && digest(currentEntries) === FOCUS_SIGNATURE_SHA256;
  if (drift.length && !focusExpansion) {
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
    if (![INITIAL_BASELINE_SHA256, FOCUS_BASELINE_SHA256].includes(digest(currentEntries))) {
      throw new Error("Only the reviewed initial contract baseline may bootstrap the ratchet");
    }
    return;
  }
  const baselineEntries = entries(baseline);
  const allowed = new Set(baselineEntries);
  const additions = currentEntries.filter((entry) => !allowed.has(entry));
  const focusExpansion =
    digest(baselineEntries) === INITIAL_BASELINE_SHA256 &&
    digest(currentEntries) === FOCUS_BASELINE_SHA256;
  if (additions.length && !focusExpansion) {
    throw new Error(`Element-resolution exceptions may only shrink:\n${additions.join("\n")}`);
  }
}

export function assertCaseInventoryDoesNotShrink(
  current: string,
  baseline: string | undefined,
): void {
  const parseKeys = (raw: string): string[] => {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.some((key) => typeof key !== "string")) {
      throw new Error("Expected contract case-key array");
    }
    if (new Set(parsed).size !== parsed.length) {
      throw new Error("Duplicate contract case keys");
    }
    return parsed as string[];
  };
  const currentKeys = parseKeys(current);
  if (baseline === undefined) {
    if (digest(currentKeys) !== INITIAL_CASE_KEYS_SHA256) {
      throw new Error("Only the reviewed initial contract case keys may bootstrap the ratchet");
    }
    return;
  }
  const missing = parseKeys(baseline).filter((key) => !currentKeys.includes(key));
  if (missing.length > 0) {
    throw new Error(`Element-resolution case keys may only grow:\n${missing.join("\n")}`);
  }
}

if (import.meta.main) {
  const [
    currentPath,
    baselinePath,
    signaturePath,
    signatureBaselinePath,
    casePath,
    caseBaselinePath,
  ] = process.argv.slice(2);
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
  if (casePath) {
    assertCaseInventoryDoesNotShrink(
      readFileSync(casePath, "utf8"),
      caseBaselinePath ? readFileSync(caseBaselinePath, "utf8") : undefined,
    );
  }
}
