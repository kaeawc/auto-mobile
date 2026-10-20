import { readFileSync, writeFileSync } from "node:fs";
import { sourceFiles, relativeImportTargets, toPosixPath } from "./check-utils-import-direction";

/**
 * Import-direction ratchet for the tiers below `features`/`server` (#11789), generalizing
 * check-utils-import-direction.ts. Each tier lists the `src/` tiers it may import. A tier with
 * `baselined: true` still carries pre-existing edges in its committed baseline, which can only
 * shrink; every other tier has no baseline and any violating edge fails outright. When a
 * baselined tier reaches zero, drop the flag and delete its file. The
 * `models` tier is owned by test/lint/modelsLeaf.test.ts (#11853), so it is not listed here. The
 * `features` tier is gated on one forbidden target (`server`) instead of an allow-list.
 */
interface TierRule {
  readonly tier: string;
  readonly allowed?: readonly string[];
  readonly forbidden?: readonly string[];
  /** Pre-existing edges live in `baselinePath(tier)`; absent means hard-fail. */
  readonly baselined?: boolean;
}

const LEAF = ["constants", "config"];
export const TIER_RULES: readonly TierRule[] = [
  { tier: "db", allowed: ["db", "models", "utils", ...LEAF] },
  { tier: "devices", allowed: ["devices", "ctrlProxy", "db", "models", "utils", ...LEAF] },
  {
    tier: "ctrlProxy",
    allowed: ["ctrlProxy", "devices", "db", "models", "utils", ...LEAF],
    baselined: true,
  },
  { tier: "features", forbidden: ["server"] },
  // daemon must not reach up into the MCP server tier (#11790); sub-package rules follow the moves.
  { tier: "daemon", forbidden: ["server"], baselined: true },
];

export function baselinePath(tier: string): string {
  return `scripts/import-direction-baselines/${tier}.txt`;
}

export function isViolation(rule: TierRule, target: string): boolean {
  const [root, targetTier] = toPosixPath(target).split("/");
  if (rule.forbidden) {
    return root === "src" && rule.forbidden.includes(targetTier);
  }
  return root !== "src" || !(rule.allowed ?? []).includes(targetTier);
}

export function tierEdges(rule: TierRule): string[] {
  const edges = new Set(
    sourceFiles(`src/${rule.tier}`).flatMap((file) =>
      relativeImportTargets(file)
        .filter((target) => isViolation(rule, target))
        .map((target) => `${toPosixPath(file)} -> ${toPosixPath(target)}`),
    ),
  );
  return [...edges].sort();
}

function readBaseline(rule: TierRule): Set<string> {
  return new Set(
    rule.baselined
      ? readFileSync(baselinePath(rule.tier), "utf8").split(/\r?\n/).filter(Boolean)
      : [],
  );
}

if (import.meta.main) {
  const update = process.argv.includes("--update");
  const allowGrow = process.argv.includes("--allow-grow");
  let failed = false;
  for (const rule of TIER_RULES) {
    const edges = tierEdges(rule);
    const baseline = readBaseline(rule);
    const newEdges = edges.filter((edge) => !baseline.has(edge));
    if (newEdges.length > 0 && !(update && allowGrow && rule.baselined)) {
      console.error(`error: new ${rule.tier} import direction violations:`);
      newEdges.forEach((edge) => console.error(edge));
      failed = true;
      continue;
    }
    if (!rule.baselined) {
      console.log(`tier-import-direction: ${rule.tier} has no upward imports.`);
    } else if (update) {
      writeFileSync(baselinePath(rule.tier), edges.map((edge) => `${edge}\n`).join(""));
      console.log(`tier-import-direction: ${rule.tier} baseline updated (${edges.length} edges).`);
    } else {
      console.log(
        `tier-import-direction: ${rule.tier} has no new upward imports (${edges.length} existing edges).`,
      );
    }
  }
  process.exit(failed ? 1 : 0);
}
