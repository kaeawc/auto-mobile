// Shrink-only guard for the web-vs-Android parity budgets (#16610).
// scripts/prototype/check-android-parity-budgets.sh resolves the merge-base
// inputs; this module only compares them, so tests need no repository.
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

export const BUDGETS_PATH = "test/fixtures/prototype-web/android-parity-budgets.json";
export const GOLDENS_DIR = "android/control-proxy/src/test/resources/screenshots/prototype";
export const GROW_TRAILER = "Parity-Budget-Grow";

export type ParityBudgets = Readonly<Record<string, number>>;

export interface ParityBudgetInputs {
  /** Budgets at the merge-base, or undefined when the file did not exist there. */
  readonly base: ParityBudgets | undefined;
  readonly current: ParityBudgets;
  /** Golden names (file stems) present at the merge-base. */
  readonly baseGoldens: ReadonlySet<string>;
  /** Golden names a commit on the branch marked with a Parity-Budget-Grow trailer. */
  readonly allowedGrows: ReadonlySet<string>;
}

export interface ParityBudgetReport {
  readonly failures: readonly string[];
  readonly allowed: readonly string[];
}

export function parseBudgets(text: string, label: string): ParityBudgets {
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${label}: expected a JSON object of golden name to pixel budget`);
  }
  const entries = Object.entries(parsed);
  const budgets: Record<string, number> = {};
  for (const [name, value] of entries) {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
      throw new Error(`${label}: budget for ${name} is not a non-negative integer`);
    }
    budgets[name] = value;
  }
  return budgets;
}

/** Golden stems from `ls-tree`-style paths, keeping only PNGs directly in GOLDENS_DIR. */
export function goldenNames(paths: readonly string[]): Set<string> {
  const prefix = `${GOLDENS_DIR}/`;
  return new Set(
    paths
      .filter((path) => path.startsWith(prefix) && path.endsWith(".png"))
      .map((path) => path.slice(prefix.length, -".png".length))
      .filter((name) => !name.includes("/")),
  );
}

/** Trailer values, one per line as printed by `git interpret-trailers --parse` or `%(trailers)`. */
export function allowedGrowNames(trailerLines: readonly string[]): Set<string> {
  const key = `${GROW_TRAILER.toLowerCase()}:`;
  return new Set(
    trailerLines
      .map((line) => line.trim())
      .filter((line) => line.toLowerCase().startsWith(key))
      .flatMap((line) => line.slice(key.length).split(","))
      .map((name) => name.trim())
      .filter((name) => name.length > 0),
  );
}

function growth(name: string, inputs: ParityBudgetInputs): string | undefined {
  const value = inputs.current[name];
  const previous = inputs.base?.[name];
  if (previous !== undefined) {
    return value > previous ? `${name}: budget raised ${previous} -> ${value}` : undefined;
  }
  // A budget for a golden that already existed was previously unbudgeted
  // (skipped), so adding one is a grow from "not compared" to a ceiling.
  return inputs.baseGoldens.has(name)
    ? `${name}: new budget ${value} for a golden that already existed`
    : undefined;
}

export function compareParityBudgets(inputs: ParityBudgetInputs): ParityBudgetReport {
  if (inputs.base === undefined) {
    return { failures: [], allowed: [] };
  }
  const grown = Object.keys(inputs.current)
    .sort()
    .flatMap((name) => {
      const message = growth(name, inputs);
      return message === undefined ? [] : [{ name, message }];
    });
  return {
    failures: grown.filter(({ name }) => !inputs.allowedGrows.has(name)).map((g) => g.message),
    allowed: grown.filter(({ name }) => inputs.allowedGrows.has(name)).map((g) => g.message),
  };
}

function readLines(path: string): string[] {
  return readFileSync(path, "utf8").split("\n").filter(Boolean);
}

function main(): number {
  const { values } = parseArgs({
    options: {
      base: { type: "string" },
      current: { type: "string" },
      "base-files": { type: "string" },
      trailers: { type: "string" },
    },
    strict: true,
  });
  if (!values.current || !values["base-files"] || !values.trailers) {
    console.error(
      "usage: check-android-parity-budgets.ts --current <json> --base-files <list> --trailers <list> [--base <json>]",
    );
    return 2;
  }
  const current = parseBudgets(readFileSync(values.current, "utf8"), BUDGETS_PATH);
  if (!values.base) {
    console.log(`${BUDGETS_PATH} is new on this branch; initial budgets accepted.`);
    return 0;
  }
  const report = compareParityBudgets({
    base: parseBudgets(readFileSync(values.base, "utf8"), `${BUDGETS_PATH} at merge-base`),
    current,
    baseGoldens: goldenNames(readLines(values["base-files"])),
    allowedGrows: allowedGrowNames(readLines(values.trailers)),
  });
  report.allowed.forEach((line) => console.log(`Parity budget growth allowed by trailer: ${line}`));
  report.failures.forEach((line) => console.log(`Parity budget growth: ${line}`));
  if (report.failures.length > 0) {
    console.error(
      `Android parity budgets may only shrink. Close the gap instead, or mark an intentional grow ` +
        `with a '${GROW_TRAILER}: <golden>' commit trailer.`,
    );
    return 1;
  }
  console.log(`Android parity budgets are shrink-only (${Object.keys(current).length} checked).`);
  return 0;
}

if (import.meta.main) {
  try {
    process.exit(main());
  } catch (error) {
    console.error(
      `error: cannot check Android parity budgets: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(2);
  }
}
