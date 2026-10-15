import { beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  markdownRepoFiles,
  scanMarkdownRepoPaths,
  staleMarkdownAllowlist,
  trackedPathExists,
} from "./markdownRepoPaths";

const root = path.resolve(import.meta.dir, "../..");
const allowlist: Readonly<Record<string, string>> = {
  "android/local.properties":
    "Gitignored local Gradle SDK config that each worktree copies from a working checkout.",
  "android/control-proxy/build/outputs/apk/debug/control-proxy-debug.apk":
    "Manual-test instructions refer to the APK produced by the Android build.",
  "android/playground/app/build/outputs/apk/debug/app-debug.apk":
    "Manual-test instructions refer to the APK produced by the Playground build.",
};

let failures: string[];
let stale: string[];
beforeAll(() => {
  const tracked = execFileSync("git", ["ls-files", "-z"], {
    cwd: root,
    encoding: "utf8",
  }).split("\0");
  const files = markdownRepoFiles(() => tracked);
  const exists = trackedPathExists(tracked);
  const referenced = new Set<string>();
  failures = [];
  for (const file of files) {
    for (const reference of scanMarkdownRepoPaths(
      readFileSync(path.join(root, file), "utf8"),
      file,
      exists,
      allowlist,
    )) {
      referenced.add(reference.target);
      if (reference.missing) {
        failures.push(`${file} -> ${reference.target}`);
      }
    }
  }
  stale = staleMarkdownAllowlist(allowlist, referenced, exists);
});

describe("Markdown repository paths", () => {
  test("resolves tracked files and ancestor directories with exact case", () => {
    const exists = trackedPathExists(["docs/Guide.md", "docs/nested/page.md", ""]);
    expect(exists("docs/Guide.md")).toBe(true);
    expect(exists("docs/guide.md")).toBe(false);
    expect(exists("docs")).toBe(true);
    expect(exists("docs/")).toBe(true);
    expect(exists("docs/nested")).toBe(true);
    expect(exists("docs/untracked.md")).toBe(false);
    expect(exists("")).toBe(false);
  });

  test("enumerates scoped tracked Markdown through an injected file list", () => {
    expect(
      markdownRepoFiles(() => [
        "README.md",
        "docs/guide.md",
        "skills/example/SKILL.md",
        ".claude/commands/example.md",
        "scripts/README.md",
        "android/README.md",
        "ios/XCTestRunner/README.md",
        "android/sdk/README.md",
        "package/README.md",
        "CHANGELOG.md",
        "scratch/example.md",
        "src/index.ts",
        "vendor/library/README.md",
      ]),
    ).toEqual([
      "README.md",
      "docs/guide.md",
      "skills/example/SKILL.md",
      ".claude/commands/example.md",
      "scripts/README.md",
      "android/README.md",
      "ios/XCTestRunner/README.md",
      "android/sdk/README.md",
      "package/README.md",
    ]);
  });

  test("detects dead relative links and root paths, resolving directories and source locations", () => {
    const result = scanMarkdownRepoPaths(
      "[dead](../missing.md) [directory](../using/) `src/index.ts:538` ![image](img/missing.png)\n[ref]: ../missing-reference.md",
      "docs/guide.md",
      (target) => target === "using/" || target === "src/index.ts",
    );
    expect(result.filter((ref) => ref.missing).map((ref) => ref.target)).toEqual([
      "missing.md",
      "docs/img/missing.png",
      "missing-reference.md",
    ]);
  });

  test("ignores URLs, anchors, placeholders, globs and fenced examples", () => {
    expect(
      scanMarkdownRepoPaths(
        "[url](https://example.com) [anchor](#intro) [mail](mailto:a@b.com)\n`src/*.ts` `src/<name>.ts` `docs/{page}.md` `scripts/$name.sh` `src/.../file.ts`\n```bash\n[example](missing.md)\n`src/missing.ts`\n```\n~~~md\n[example](missing.md)\n~~~",
        "README.md",
        () => false,
      ),
    ).toEqual([]);
  });

  test("honors intentional paths and detects stale allowlist entries", () => {
    const exceptions = { "docs/example.md": "Example supplied by the user" };
    expect(
      scanMarkdownRepoPaths("`docs/example.md`", "README.md", () => false, exceptions),
    ).toEqual([{ target: "docs/example.md", missing: false }]);
    expect(staleMarkdownAllowlist(exceptions, new Set(["docs/example.md"]), () => false)).toEqual(
      [],
    );
    expect(staleMarkdownAllowlist(exceptions, new Set(), () => false)).toEqual(["docs/example.md"]);
    expect(staleMarkdownAllowlist(exceptions, new Set(["docs/example.md"]), () => true)).toEqual([
      "docs/example.md",
    ]);
  });

  test("tracked repository Markdown has no dead paths", () => {
    expect(failures).toEqual([]);
  });

  test("repository allowlist entries are still referenced and absent", () => {
    expect(stale).toEqual([]);
  });
});
