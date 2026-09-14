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
const FIXTURE_DIR = join(import.meta.dir, "fixtures", "batsSerialTags");

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

// Variable-target detection (#7003): a simple assignment whose value is a
// repo-relative committed path, optionally prefixed by the checkout root
// (`"$ROOT/scripts/..."`). `local`/`export`/`declare`/`readonly` prefixes are
// allowed; `local a b` declarations without `=` are not assignments.
const TRACKED_ASSIGNMENT = new RegExp(
  String.raw`^\s*(?:(?:local|export|declare|readonly)\s+(?:-\w+\s+)*)?([A-Za-z_][A-Za-z0-9_]*)=["']?(?:\$\{?(?:ROOT|REPO_ROOT)\}?/)?` +
    COMMITTED_TARGET,
);

// Real-tree mutation ops whose argument is `$VAR` / `"${VAR}"`: a redirection
// (`> "$VAR"`), or `rm` / `mv` / `git [-C dir] rm` / `git [-C dir] mv` with the
// variable anywhere in the argument list. `mv` is flagged for either position
// (moving a tracked file away is as disruptive as overwriting it); `cp` FROM the
// variable only reads it, so it is not an op here.
function mutationOpsFor(varName: string): RegExp[] {
  const ref = String.raw`"?\$\{?${varName}\}?"?`;
  return [
    new RegExp(String.raw`>>?\s*${ref}(?=[\s;&|)]|$)`),
    new RegExp(
      String.raw`(?:^|[\s;&|(])(?:git[ \t]+(?:-C[ \t]+\S+[ \t]+)?)?(?:rm|mv)[ \t]+(?:\S+[ \t]+)*${ref}(?=[\s;&|)]|$)`,
    ),
  ];
}

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
// committed path and passes that variable to a mutating op (a redirection
// `printf ... > "$FIXTURE"`, `rm "$runtime_input"`, `git mv "$from" "$to"`), or
// (b) writes directly to a committed path (`> package.json`,
// `mv x package.json`, `cp x src/...`). Copies FROM a real path INTO a temp dir
// assign/read the real path but write a temp target, so they are not flagged.
function mutatesRealTree(text: string): boolean {
  if (operatesInTempCwd(text)) {
    return false;
  }
  const lines = text.split("\n");
  const trackedVars = new Set(
    lines
      .map((line) => line.match(TRACKED_ASSIGNMENT)?.[1])
      .filter((name): name is string => name !== undefined),
  );
  const mutatesViaVariable = [...trackedVars]
    .flatMap(mutationOpsFor)
    .some((op) => lines.some((line) => op.test(line)));
  return mutatesViaVariable || COMMITTED_WRITE.test(text);
}

function loadFixture(name: string): string {
  return readFileSync(join(FIXTURE_DIR, name), "utf8");
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

  test("the tag detector recognizes a `local tmp=src/...` fixture redirect (#7003)", () => {
    // `local` prefixed assignments defeated the pre-#7003 assignment regex, so
    // this file wrote under src/ untagged until the detector was widened.
    const known = files.find((f) => f.name === "validate-no-debug-log-tags.bats");
    expect(known).toBeDefined();
    expect(mutatesRealTree(known!.text)).toBe(true);
    expect(hasFileTag(known!.text, "serial")).toBe(true);
  });

  test("the tag detector recognizes a variable-target rm of a tracked file (#7003)", () => {
    expect(mutatesRealTree(loadFixture("variable-rm-tracked.bats"))).toBe(true);
  });

  test("the tag detector recognizes a variable-target `git mv` of a tracked file (#7003)", () => {
    expect(mutatesRealTree(loadFixture("variable-git-mv-tracked.bats"))).toBe(true);
  });

  test("the tag detector recognizes a `$ROOT/<tracked>` variable passed to `git rm` from setup (#7003)", () => {
    expect(mutatesRealTree(loadFixture("variable-root-prefixed-git-rm.bats"))).toBe(true);
  });

  test("a variable pointing under $BATS_TEST_TMPDIR is not a real-tree mutation (#7003)", () => {
    expect(mutatesRealTree(loadFixture("variable-tmpdir-rm.bats"))).toBe(false);
  });

  test("the detector recognizes the hand-tagged prepush-integration mutator (#6988)", () => {
    const known = files.find((f) => f.name === "prepush-integration.bats");
    expect(known).toBeDefined();
    expect(mutatesRealTree(known!.text)).toBe(true);
    expect(hasFileTag(known!.text, "serial")).toBe(true);
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
