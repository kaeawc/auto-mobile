import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// scripts/ci/run-bats.sh runs the BATS suite cross-file-parallel, except files
// tagged `serial`, which it runs one at a time. A file that writes a fixture
// into the REAL source tree (src/ | android/ | ios/) and then runs a scanner
// over that tree races every other file under parallelism (that is exactly the
// class of flake that motivated this: an unrelated file scans the tree while a
// fixture is present). This guard fails if such a file lands without the tag,
// so a new boundary/convention check cannot silently reintroduce the race.

const BATS_DIR = join(import.meta.dir, "..", "..", "test", "bats");
const REAL_TREE = /^(src|android|ios)\//;

interface BatsFile {
  name: string;
  text: string;
}

function loadBatsFiles(): BatsFile[] {
  return readdirSync(BATS_DIR)
    .filter((f) => f.endsWith(".bats"))
    .map((name) => ({ name, text: readFileSync(join(BATS_DIR, name), "utf8") }));
}

// A file mutates the real tree when it assigns a variable to a real-tree path
// and then uses that variable as a redirection target (printf/cat/echo > "$VAR").
// Copies FROM a real path INTO a temp dir assign the real path but redirect to a
// different (temp) target, so they are not flagged.
function mutatesRealTree(text: string): boolean {
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
  return false;
}

function hasSerialTag(text: string): boolean {
  // `# bats file_tags=serial` or a comma list that includes `serial`.
  return text
    .split("\n")
    .some(
      (line) =>
        /^#\s*bats\s+file_tags=/.test(line) &&
        /(^|=|,)\s*serial\s*(,|$)/.test(line.replace(/^#\s*bats\s+file_tags=/, "=")),
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
      .filter((f) => !hasSerialTag(f.text))
      .map((f) => f.name);

    expect(offenders).toEqual([]);
  });

  test("the tag detector actually recognizes a known mutator (guards against a no-op regex)", () => {
    const known = files.find((f) => f.name === "check-android-emulator-boundary.bats");
    expect(known).toBeDefined();
    expect(mutatesRealTree(known!.text)).toBe(true);
    expect(hasSerialTag(known!.text)).toBe(true);
  });
});
