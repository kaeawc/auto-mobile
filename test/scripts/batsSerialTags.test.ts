import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// scripts/ci/run-bats.sh runs the BATS suite cross-file-parallel, except files
// tagged `serial`, which it runs one at a time. A file that writes into the REAL
// working tree — a fixture under src/|android/|ios/, or a root-level committed
// file such as package.json — and then runs a scanner over that tree races every
// other file under parallelism (an unrelated file reads/scans the tree while the
// mutation is live). This guard fails if such a file lands without the tag, so a
// new boundary/convention check cannot silently reintroduce the race.

const BATS_DIR = join(import.meta.dir, "..", "..", "test", "bats");

// Real-tree path prefixes for variable-target detection (var assigned a path
// under one of these, then used as a redirection target).
const REAL_TREE = /^(src|android|ios)\//;

// Committed paths that, when they are the TARGET of a write op (redirect, cp,
// mv, tee), mean the test rewrites the real working tree in place. Covers
// root-level files (package.json and friends) and committed directories.
const COMMITTED_TARGET =
  "(?:package\\.json|package-lock\\.json|bun\\.lock|tsconfig[\\w.-]*\\.json|src/|android/|ios/|docs/|schemas/|scripts/|benchmark/)";
const COMMITTED_WRITE = new RegExp(
  // `> committed`, `>> committed`, `tee committed`, `cp SRC committed`, `mv SRC committed`.
  String.raw`(?:>>?\s*|tee\s+|(?:cp|mv)\s+\S+\s+)"?` + COMMITTED_TARGET,
  "m",
);

interface BatsFile {
  name: string;
  text: string;
}

function loadBatsFiles(): BatsFile[] {
  return readdirSync(BATS_DIR)
    .filter((f) => f.endsWith(".bats"))
    .map((name) => ({ name, text: readFileSync(join(BATS_DIR, name), "utf8") }));
}

// A file that `cd`s into a variable directory (`cd "$REPO"`, invariably a
// mktemp-derived working dir in this suite) does its relative-path writes inside
// that temp cwd, not the real checkout, so it is hermetic and exempt.
function operatesInTempCwd(text: string): boolean {
  return /^\s*cd\s+"?\$/m.test(text);
}

// A file mutates the real tree when it either (a) assigns a variable to a
// real-tree path and uses that variable as a redirection target
// (`printf ... > "$FIXTURE"`), or (b) writes directly to a committed path
// (`> package.json`, `mv x package.json`, `cp x src/...`). Copies FROM a real
// path INTO a temp dir assign/read the real path but write a temp target, so
// they are not flagged.
function mutatesRealTree(text: string): boolean {
  if (operatesInTempCwd(text)) {
    return false;
  }
  const realVars = new Set<string>();
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=["']?([^"'\s]+)/);
    if (m && REAL_TREE.test(m[2])) {
      realVars.add(m[1]);
    }
  }
  for (const varName of realVars) {
    // A redirection whose target is this variable: `> "$VAR"` / `>"${VAR}"`.
    const redirect = new RegExp(`>\\s*"?\\$\\{?${varName}\\}?"?`);
    if (redirect.test(text)) {
      return true;
    }
  }
  return COMMITTED_WRITE.test(text);
}

function hasFileTag(text: string, tag: string): boolean {
  return text.split("\n").some(
    (line) =>
      /^#\s*bats\s+file_tags=/.test(line) &&
      line
        .replace(/^#\s*bats\s+file_tags=/, "")
        .split(",")
        .map((value) => value.trim())
        .includes(tag),
  );
}

describe("bats serial-pass tagging (scripts/ci/run-bats.sh)", () => {
  const files = loadBatsFiles();

  test("the suite has bats files to scan", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  test("every real-tree-mutating bats file carries the `serial` tag", () => {
    const offenders = files
      .filter((f) => mutatesRealTree(f.text))
      .filter((f) => !hasFileTag(f.text, "serial"))
      .map((f) => f.name);

    expect(offenders).toEqual([]);
  });

  test("the tag detector recognizes a src/-fixture mutator (guards against a no-op regex)", () => {
    const known = files.find((f) => f.name === "check-android-emulator-boundary.bats");
    expect(known).toBeDefined();
    expect(mutatesRealTree(known!.text)).toBe(true);
    expect(hasFileTag(known!.text, "serial")).toBe(true);
  });

  test("the tag detector recognizes a root-level package.json mutator", () => {
    const known = files.find((f) => f.name === "check-stdlib-first.bats");
    expect(known).toBeDefined();
    expect(mutatesRealTree(known!.text)).toBe(true);
    expect(hasFileTag(known!.text, "serial")).toBe(true);
  });

  test("a file that cds into a temp dir before writing is treated as hermetic", () => {
    // docs-changed-since-last-deploy writes docs/*.md, but inside `cd "$REPO"`
    // (a mktemp dir), so it must NOT be flagged as a real-tree mutator.
    const hermetic = files.find((f) => f.name === "docs-changed-since-last-deploy.bats");
    expect(hermetic).toBeDefined();
    expect(mutatesRealTree(hermetic!.text)).toBe(false);
  });

  test("real process, package, and host-tool files carry the orthogonal integration tag", () => {
    const integrationFiles = [
      "install-background-work.bats",
      "install-fast-validation-deps.bats",
      "npm-package-contents.bats",
      "validate-markdown-bash.bats",
      "validate-shell-portability.bats",
    ];

    for (const name of integrationFiles) {
      const file = files.find((candidate) => candidate.name === name);
      expect(file, name).toBeDefined();
      expect(hasFileTag(file!.text, "integration"), name).toBe(true);
    }

    const serialIntegration = files.find((file) => file.name === "install-background-work.bats");
    expect(hasFileTag(serialIntegration!.text, "serial")).toBe(true);
  });
});
