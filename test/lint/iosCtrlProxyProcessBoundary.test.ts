import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  findViolationsInSource,
  repositoryPath,
} from "../../scripts/check-ios-ctrl-proxy-process-boundary";

const ROOT = join(import.meta.dir, "..", "..");
const OWNER = join(ROOT, "src/utils/ios/IOSCtrlProxyProcessClient.ts");
const CHECK = join(ROOT, "scripts/check-ios-ctrl-proxy-process-boundary.ts");

describe("iOS CtrlProxy process execution boundary (issue #4063)", () => {
  test("keeps ps, pgrep, and kill ownership in the lifecycle client", () => {
    const manager = readFileSync(join(ROOT, "src/utils/IOSCtrlProxyManager.ts"), "utf8");
    expect(manager).not.toMatch(/processExecutor\.exec\(\s*["'`](?:ps|pgrep|kill)/);
    expect(readFileSync(OWNER, "utf8")).toMatch(/executeCommand\(\s*"pgrep"/);
  });

  test("rejects direct and wrapped process APIs for lifecycle tools", () => {
    expect(findViolationsInSource("fixture.ts", 'execFile("kill", ["-9", "42"]);')).toHaveLength(1);
    expect(
      findViolationsInSource("fixture.ts", 'host.executeCommand("ps", ["-p", "42"]);'),
    ).toHaveLength(1);
    expect(
      findViolationsInSource("fixture.ts", 'Bun.spawn(["pgrep", "-x", "xcodebuild"]);'),
    ).toHaveLength(1);
    expect(
      findViolationsInSource("fixture.ts", 'host.executeCommand("xcrun", ["simctl", "list"]);'),
    ).toEqual([]);
  });

  test("has a production check with documented exceptions", () => {
    const source = readFileSync(CHECK, "utf8");
    expect(source).toContain("const EXCEPTIONS = new Map<string, string>([");
    expect(source).toContain("IOSCtrlProxyProcessClient.ts");
    expect(readFileSync(join(ROOT, "package.json"), "utf8")).toContain(
      "check:ios-ctrl-proxy-process-boundary",
    );
    expect(readFileSync(join(ROOT, "scripts/all_fast_validate_checks.sh"), "utf8")).toContain(
      "ios-ctrl-proxy-process-boundary",
    );
    expect(readFileSync(join(ROOT, "turbo.json"), "utf8")).toContain(
      '"check:ios-ctrl-proxy-process-boundary"',
    );
    expect(readFileSync(join(ROOT, ".github/workflows/pull_request.yml"), "utf8")).toContain(
      "Check iOS CtrlProxy process execution boundary",
    );
  });

  test("normalizes Windows separators before applying ownership exceptions", () => {
    expect(repositoryPath("src\\utils\\ios\\IOSCtrlProxyProcessClient.ts")).toBe(
      "src/utils/ios/IOSCtrlProxyProcessClient.ts",
    );
  });
});
