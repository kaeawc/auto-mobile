import { sourceFiles, relativeImportTargets, toPosixPath } from "./check-utils-import-direction";

/**
 * Import-direction guard for the tiers below `features`/`server` (#11789), generalizing
 * check-utils-import-direction.ts. Each tier lists the `src/` tiers it may import;
 * every violating edge fails outright. The
 * `models` tier is owned by test/lint/modelsLeaf.test.ts (#11853), so it is not listed here. The
 * `features` tier is gated on one forbidden target (`server`) instead of an allow-list.
 */
interface TierRule {
  readonly tier: string;
  readonly allowed?: readonly string[];
  readonly forbidden?: readonly string[];
}

const LEAF = ["constants", "config"];
export const TIER_RULES: readonly TierRule[] = [
  { tier: "db", allowed: ["db", "models", "utils", ...LEAF] },
  { tier: "devices", allowed: ["devices", "ctrlProxy", "db", "models", "utils", ...LEAF] },
  {
    tier: "ctrlProxy",
    allowed: ["ctrlProxy", "devices", "db", "models", "utils", ...LEAF],
  },
  { tier: "features", forbidden: ["server"] },
  // daemon must not reach up into the MCP server tier (#11790); sub-package rules follow the moves.
  { tier: "daemon", forbidden: ["server"] },
];

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

/** The CLI and unit tests share this hard-fail policy; there are no exempt edges. */
export function checkTierImports(
  rule: TierRule,
  edges: readonly string[],
  output: Pick<Console, "error" | "log"> = console,
): boolean {
  if (edges.length > 0) {
    output.error(`error: ${rule.tier} import direction violations:`);
    edges.forEach((edge) => output.error(edge));
    return false;
  }
  output.log(`tier-import-direction: ${rule.tier} has no upward imports.`);
  return true;
}

if (import.meta.main) {
  let failed = false;
  for (const rule of TIER_RULES) {
    if (!checkTierImports(rule, tierEdges(rule))) {
      failed = true;
    }
  }
  process.exit(failed ? 1 : 0);
}
