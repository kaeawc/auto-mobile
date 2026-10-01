import { readFileSync, writeFileSync } from "node:fs";

interface SourceCoverage {
  functions: Map<string, string>;
  functionHits: Map<string, number>;
  functionFound: number;
  functionHit: number;
  lines: Map<string, number>;
  branches: Map<string, number | null>;
}

/** Merge LCOV counters by source and location, avoiding duplicate LF/LH totals. */
export function mergeLcov(reports: string[]): string {
  const sources = new Map<string, SourceCoverage>();
  for (const report of reports) {
    let source: SourceCoverage | undefined;
    let records = 0;
    for (const line of report.split(/\r?\n/)) {
      if (line.startsWith("SF:")) {
        const path = line.slice(3);
        if (!path) {
          throw new Error("LCOV source path is empty");
        }
        source = sources.get(path);
        if (!source) {
          source = {
            functions: new Map(),
            functionHits: new Map(),
            functionFound: 0,
            functionHit: 0,
            lines: new Map(),
            branches: new Map(),
          };
          sources.set(path, source);
        }
        records += 1;
      } else if (line === "end_of_record") {
        source = undefined;
      } else if (source && line.startsWith("FN:")) {
        const definition = line.slice(3);
        const separator = definition.indexOf(",");
        if (separator < 0) {
          throw new Error(`Invalid LCOV function: ${line}`);
        }
        const name = definition.slice(separator + 1);
        source.functions.set(name, definition);
      } else if (source && line.startsWith("FNDA:")) {
        const value = line.slice(5);
        const separator = value.indexOf(",");
        if (separator < 0) {
          throw new Error(`Invalid LCOV function count: ${line}`);
        }
        const name = value.slice(separator + 1);
        const count = Number(value.slice(0, separator));
        if (!Number.isFinite(count)) {
          throw new Error(`Invalid LCOV count: ${line}`);
        }
        source.functionHits.set(name, (source.functionHits.get(name) ?? 0) + count);
      } else if (source && line.startsWith("FNF:")) {
        const count = Number(line.slice(4));
        if (!Number.isFinite(count)) {
          throw new Error(`Invalid LCOV count: ${line}`);
        }
        source.functionFound = Math.max(source.functionFound, count);
      } else if (source && line.startsWith("FNH:")) {
        // Bun emits only function totals, without FN/FNDA identities. The
        // maximum is a conservative union when files appear in both shards.
        const count = Number(line.slice(4));
        if (!Number.isFinite(count)) {
          throw new Error(`Invalid LCOV count: ${line}`);
        }
        source.functionHit = Math.max(source.functionHit, count);
      } else if (source && line.startsWith("DA:")) {
        const [location, rawCount] = line.slice(3).split(",");
        const count = Number(rawCount);
        if (!location || !Number.isFinite(count)) {
          throw new Error(`Invalid LCOV count: ${line}`);
        }
        source.lines.set(location, (source.lines.get(location) ?? 0) + count);
      } else if (source && line.startsWith("BRDA:")) {
        const fields = line.slice(5).split(",");
        if (fields.length !== 4) {
          throw new Error(`Invalid LCOV branch: ${line}`);
        }
        const key = fields.slice(0, 3).join(",");
        const count = fields[3] === "-" ? null : Number(fields[3]);
        if (count !== null && !Number.isFinite(count)) {
          throw new Error(`Invalid LCOV count: ${line}`);
        }
        const previous = source.branches.get(key);
        source.branches.set(key, count === null ? (previous ?? null) : (previous ?? 0) + count);
      }
    }
    if (records === 0) {
      throw new Error("LCOV report has no source records");
    }
  }

  const output: string[] = [];
  for (const [path, source] of sources) {
    output.push("TN:", `SF:${path}`);
    for (const definition of source.functions.values()) {
      output.push(`FN:${definition}`);
    }
    for (const [name, count] of source.functionHits) {
      output.push(`FNDA:${count},${name}`);
    }
    output.push(`FNF:${Math.max(source.functions.size, source.functionFound)}`);
    output.push(
      `FNH:${Math.max(source.functionHit, [...source.functionHits.values()].filter((count) => count > 0).length)}`,
    );
    for (const [key, count] of source.branches) {
      output.push(`BRDA:${key},${count ?? "-"}`);
    }
    output.push(`BRF:${source.branches.size}`);
    output.push(
      `BRH:${[...source.branches.values()].filter((count) => count !== null && count > 0).length}`,
    );
    for (const [location, count] of source.lines) {
      output.push(`DA:${location},${count}`);
    }
    output.push(`LF:${source.lines.size}`);
    output.push(`LH:${[...source.lines.values()].filter((count) => count > 0).length}`);
    output.push("end_of_record");
  }
  return `${output.join("\n")}\n`;
}

if (import.meta.main) {
  const [output, ...inputs] = process.argv.slice(2);
  if (!output || inputs.length < 2) {
    throw new Error(
      "Usage: bun scripts/lib/merge-lcov.ts <output> <shard-lcov> <shard-lcov> [...]",
    );
  }
  writeFileSync(output, mergeLcov(inputs.map((input) => readFileSync(input, "utf8"))));
}
