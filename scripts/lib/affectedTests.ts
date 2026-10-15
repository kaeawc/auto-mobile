#!/usr/bin/env bun
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import ts from "typescript";
import { relativeModuleSpecifiers, resolveRelativeSpecifier } from "./tsImportDeps";

/** All paths use repository-relative POSIX spelling. */
export interface SourceReader {
  list(): string[];
  read(file: string): string;
}

export interface AffectedTestsInput {
  reader: SourceReader;
  changedFiles: string[];
  tierList: string;
  maxUnit?: number;
  maxIntegration?: number;
}

export function parseIntegrationTiers(text: string): Map<string, "safe" | "unsafe"> {
  const tiers = new Map<string, "safe" | "unsafe">();
  for (const line of text.split("\n")) {
    if (line.trim().startsWith("#")) {
      continue;
    }
    const [file, tier] = line.split("|").map((part) => part.trim());
    if (file && (tier === "safe" || tier === "unsafe")) {
      tiers.set(file, tier);
    }
  }
  return tiers;
}

const isSource = (file: string): boolean => /\.(?:ts|tsx|mts)$/.test(file);

/** Pure graph selection; no filesystem, process, or version-control access. */
export function selectAffectedTests(input: AffectedTestsInput) {
  const { reader, changedFiles } = input;
  const files = new Set(reader.list());
  const known = new Set([...files, ...changedFiles]);
  const virtualRoot = path.resolve("/");
  const relative = (absolute: string): string =>
    path.relative(virtualRoot, absolute).split(path.sep).join("/");
  const reverse = new Map<string, Set<string>>();
  const reasons: Record<string, string> = {};
  const importSeeds: string[] = [];
  const referenceSeeds: string[] = [];
  const tierValidator = "test/scripts/integrationSafeTier.test.ts";
  const validateTiers = changedFiles.some(
    (file) => file.endsWith(".integration.test.ts") || file === "test/integration-safe-tier.txt",
  );
  const seed = (file: string, reason: string): void => {
    if (Object.hasOwn(reasons, file)) {
      return;
    }
    reasons[file] = reason;
  };
  for (const file of changedFiles) {
    seed(file, `changed: ${file}`);
    importSeeds.push(file);
  }
  if (changedFiles.length > 0) {
    const nonSources = changedFiles.filter((file) => !isSource(file));
    for (const file of files) {
      if (!isSource(file)) {
        continue;
      }
      const ast = ts.createSourceFile(file, reader.read(file), ts.ScriptTarget.Latest, false);
      for (const specifier of relativeModuleSpecifiers(ast, { includeTypeOnly: false })) {
        for (const absolute of resolveRelativeSpecifier(
          path.join(virtualRoot, file),
          specifier,
          virtualRoot,
          { has: (candidate) => known.has(candidate) },
          (candidate) => files.has(relative(candidate)),
        )) {
          const dependency = relative(absolute);
          const importers = reverse.get(dependency) ?? new Set<string>();
          importers.add(file);
          reverse.set(dependency, importers);
        }
      }
      if (!file.startsWith("test/") && !file.startsWith("scripts/")) {
        continue;
      }
      const literals: string[] = [];
      let walksDirectories = false;
      const visit = (node: ts.Node): void => {
        if (
          ts.isIdentifier(node) &&
          ["readdir", "readdirSync", "Glob", "glob"].includes(node.text)
        ) {
          walksDirectories = true;
        }
        if (
          ts.isStringLiteralLike(node) ||
          ts.isTemplateHead(node) ||
          ts.isTemplateMiddle(node) ||
          ts.isTemplateTail(node)
        ) {
          literals.push(node.text);
        }
        ts.forEachChild(node, visit);
      };
      visit(ast);
      for (const literal of literals) {
        const directory = literal.endsWith("/") ? literal.slice(0, -1) : literal;
        for (const changed of changedFiles) {
          const basename = path.posix.basename(changed);
          const directoryReference =
            directory.length > 0 &&
            changed.startsWith(`${directory}/`) &&
            (directory.includes("/") || walksDirectories);
          if (
            directoryReference ||
            (nonSources.includes(changed) &&
              (literal.includes(changed) ||
                literal === basename ||
                literal.endsWith(`/${basename}`)))
          ) {
            seed(file, `references: ${changed}`);
            referenceSeeds.push(file);
          }
        }
      }
    }
  }
  const closure = (seeds: string[]): Set<string> => {
    const reached = new Set(seeds);
    const queue = [...reached];
    for (let index = 0; index < queue.length; index++) {
      const dependency = queue[index];
      for (const importer of reverse.get(dependency) ?? []) {
        if (!reached.has(importer)) {
          reached.add(importer);
          queue.push(importer);
          seed(importer, `imports: ${dependency} (${reasons[dependency]})`);
        }
      }
    }
    return reached;
  };
  // Bun's changed run already covers changed tests and their reverse import closure,
  // including JSON imports. Run reference extras plus any forced tier validator.
  const importClosure = closure(importSeeds);
  const referenceClosure = closure(referenceSeeds);
  const tiers = parseIntegrationTiers(input.tierList);
  const unit: string[] = [];
  const integrationSafe: string[] = [];
  const integrationUnsafeSkipped: string[] = [];
  const integrationUnlisted: string[] = [];
  for (const file of [...new Set([...importClosure, ...referenceClosure])].sort()) {
    if (
      !files.has(file) ||
      !file.startsWith("test/") ||
      file.startsWith("test/stress/") ||
      !file.endsWith(".test.ts")
    ) {
      continue;
    }
    if (!file.endsWith(".integration.test.ts")) {
      unit.push(file);
    } else if (tiers.get(file) === "safe") {
      integrationSafe.push(file);
    } else if (tiers.get(file) === "unsafe") {
      integrationUnsafeSkipped.push(file);
      reasons[file] += "; skipped unsafe integration";
    } else {
      integrationUnlisted.push(file);
      reasons[file] += "; unlisted integration";
    }
  }
  const unitReferenceOnly = unit.filter(
    (file) => referenceClosure.has(file) && !importClosure.has(file),
  );
  if (validateTiers && files.has(tierValidator)) {
    if (!unit.includes(tierValidator)) {
      unit.push(tierValidator);
      unit.sort();
    }
    if (!unitReferenceOnly.includes(tierValidator)) {
      unitReferenceOnly.push(tierValidator);
      unitReferenceOnly.sort();
    }
    seed(tierValidator, "validates: test/integration-safe-tier.txt classification");
  }
  return {
    unit,
    unitReferenceOnly,
    integrationSafe,
    integrationUnsafeSkipped,
    integrationUnlisted,
    reasons,
    fallback: {
      unitFallback: unitReferenceOnly.length > (input.maxUnit ?? 80),
      integrationFallback: integrationSafe.length > (input.maxIntegration ?? 40),
    },
  };
}

/** An empty selection succeeds; missing integration classifications block the gate. */
export function affectedTestsExitCode(result: { integrationUnlisted: readonly string[] }): 0 | 3 {
  return result.integrationUnlisted.length > 0 ? 3 : 0;
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      "changed-files": { type: "string" },
      "tier-file": { type: "string", default: "test/integration-safe-tier.txt" },
      "max-unit": { type: "string", default: "80" },
      "max-integration": { type: "string", default: "40" },
      "out-dir": { type: "string", default: "scratch/affected-tests" },
    },
  });
  if (!values["changed-files"]) {
    throw new Error("--changed-files <file|-> is required");
  }
  const cap = (value: string): number => {
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < 0) {
      throw new Error(`Invalid cap: ${value}`);
    }
    return number;
  };
  const root = path.resolve(import.meta.dir, "../..");
  const list = (directory: string): string[] =>
    readdirSync(path.join(root, directory), { withFileTypes: true }).flatMap((entry) => {
      const file = `${directory}/${entry.name}`;
      return entry.isDirectory() ? list(file) : isSource(file) ? [file] : [];
    });
  const result = selectAffectedTests({
    reader: {
      list: () => [...["src", "test", "scripts"].flatMap(list), "package.json"],
      read: (file) => readFileSync(path.join(root, file), "utf8"),
    },
    changedFiles: readFileSync(
      values["changed-files"] === "-" ? 0 : values["changed-files"],
      "utf8",
    )
      .split("\n")
      .map((file) => file.trim())
      .filter(Boolean),
    tierList: readFileSync(values["tier-file"], "utf8"),
    maxUnit: cap(values["max-unit"]),
    maxIntegration: cap(values["max-integration"]),
  });
  mkdirSync(values["out-dir"], { recursive: true });
  const write = (name: string, lines: string[]): void =>
    writeFileSync(path.join(values["out-dir"], name), lines.length ? `${lines.join("\n")}\n` : "");
  write("unit.txt", result.unitReferenceOnly);
  write("integration-safe.txt", result.integrationSafe);
  const fallbacks: string[] = [];
  if (result.fallback.unitFallback) {
    fallbacks.push("unit");
    console.error("Affected reference-only unit cap exceeded; running the full unit lane.");
  }
  if (result.fallback.integrationFallback) {
    fallbacks.push("integration");
    console.error("Affected integration cap exceeded; running the entire safe tier.");
  }
  write("fallback.txt", fallbacks);
  for (const file of result.integrationUnsafeSkipped) {
    console.error(`Skipping ${file}: ${result.reasons[file]}`);
  }
  for (const file of result.integrationUnlisted) {
    console.error(
      `Unlisted integration test ${file}: classify it in test/integration-safe-tier.txt.`,
    );
  }
  console.log(
    `Affected tests: ${result.unit.length} unit total, ${result.unitReferenceOnly.length} reference-only unit extras (unit.txt), ${result.integrationSafe.length} safe integration, ${result.integrationUnsafeSkipped.length} unsafe skipped, ${result.integrationUnlisted.length} unlisted.`,
  );
  process.exitCode = affectedTestsExitCode(result);
}
