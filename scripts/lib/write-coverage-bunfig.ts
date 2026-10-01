import { readFileSync, writeFileSync } from "node:fs";

/** Bun 1.3.14 uses bunfig's coverageDir even when --coverage-dir is supplied. */
export function writeCoverageBunfig(output: string, coverageDir: string): void {
  const config: unknown = Bun.TOML.parse(readFileSync("bunfig.toml", "utf8"));
  if (typeof config !== "object" || config === null || !("test" in config)) {
    throw new Error("Expected a [test] section in bunfig.toml");
  }
  const test: unknown = config.test;
  if (typeof test !== "object" || test === null) {
    throw new Error("Expected a [test] table in bunfig.toml");
  }
  const expected = ["coverageDir", "coverageReporter", "preload"];
  if (
    Object.keys(config).some((key) => key !== "test") ||
    Object.keys(test).some((key) => !expected.includes(key)) ||
    !("preload" in test) ||
    !Array.isArray(test.preload) ||
    !test.preload.every((value) => typeof value === "string") ||
    !("coverageReporter" in test) ||
    !Array.isArray(test.coverageReporter) ||
    !test.coverageReporter.every((value) => typeof value === "string")
  ) {
    throw new Error(
      "Unsupported bunfig.toml test settings; update the coverage shard config writer",
    );
  }
  writeFileSync(
    output,
    `[test]\npreload = ${JSON.stringify(test.preload)}\ncoverageReporter = ${JSON.stringify(test.coverageReporter)}\ncoverageDir = ${JSON.stringify(coverageDir)}\n`,
  );
}

if (import.meta.main) {
  const [output, coverageDir] = process.argv.slice(2);
  if (!output || !coverageDir) {
    throw new Error("Usage: bun scripts/lib/write-coverage-bunfig.ts <output> <coverage-dir>");
  }
  writeCoverageBunfig(output, coverageDir);
}
