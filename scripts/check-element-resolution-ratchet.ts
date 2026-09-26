import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const INITIAL_BASELINE_SHA256 = "646696850185ad7df46ffc9794cff4e6d58ffdff0b90479646d00ab2e9e9f5e3";

function entries(raw: string): string[] {
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("Expected finding-to-cases object");
  return Object.entries(parsed).flatMap(([finding, cases]) => {
    if (!Array.isArray(cases) || cases.some((entry) => typeof entry !== "string"))
      throw new Error(`Invalid cases for ${finding}`);
    return cases.map((entry: string) => JSON.stringify([finding, entry]));
  });
}

export function assertRatchetDoesNotGrow(current: string, baseline: string | undefined): void {
  const currentEntries = entries(current);
  if (new Set(currentEntries).size !== currentEntries.length)
    throw new Error("Duplicate contract exceptions");
  if (baseline === undefined) {
    if (createHash("sha256").update(current).digest("hex") !== INITIAL_BASELINE_SHA256)
      throw new Error("Only the reviewed initial contract baseline may bootstrap the ratchet");
    return;
  }
  const allowed = new Set(entries(baseline));
  const additions = currentEntries.filter((entry) => !allowed.has(entry));
  if (additions.length)
    throw new Error(`Element-resolution exceptions may only shrink:\n${additions.join("\n")}`);
}

if (import.meta.main) {
  const [currentPath, baselinePath] = process.argv.slice(2);
  assertRatchetDoesNotGrow(
    readFileSync(currentPath, "utf8"),
    baselinePath ? readFileSync(baselinePath, "utf8") : undefined,
  );
}
