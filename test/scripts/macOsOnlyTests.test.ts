import { describe, expect, test } from "bun:test";
import {
  buildSkipReport,
  classifyTestPath,
  hasIosPathToken,
  parseManifest,
  partitionTestPaths,
  pathTokens,
  renderReportLine,
  renderReportMarkdown,
  renderSkipBunfig,
} from "../../scripts/lib/macOsOnlyTests";

const MANIFEST = `
# comment
portable test/lint/**                       # source scans
portable test/daemon/devicePool.iosRecovery.test.ts # shared pool logic
macos    test/utils/runtimeCompatibility.test.ts    # imports only iOS source
`;

describe("pathTokens", () => {
  test("splits separators, camelCase and acronym boundaries", () => {
    expect(pathTokens("test/ctrlProxy/IOSCtrlProxyManager.forceRestart.test.ts")).toEqual([
      "test",
      "ctrl",
      "proxy",
      "ios",
      "ctrl",
      "proxy",
      "manager",
      "force",
      "restart",
      "test",
      "ts",
    ]);
  });
});

describe("hasIosPathToken", () => {
  test.each([
    "test/utils/ios-cmdline-tools/simctl.test.ts",
    "test/features/iosSimFleet/capacity.test.ts",
    "test/features/action/TapOnElementIosScreenSize.test.ts",
    "test/features/action/DragAndDropIos.test.ts",
    "test/daemon/readiness/CreatedIosSimulatorRollback.test.ts",
    "test/utils/ios-cmdline-tools/DevicectlDeviceLister.test.ts",
    "test/scripts/xcodegenDriftCheck.integration.test.ts",
    "test/features/observe/TakeScreenshot.iOS.test.ts",
    "test/features/observe/TakeScreenshot.iOSHidePrototype.test.ts",
  ])("%s is iOS-specific", (testPath) => {
    expect(hasIosPathToken(testPath)).toBe(true);
  });

  test.each([
    "test/server/scenarios.test.ts",
    "test/features/action/TapOnElement.test.ts",
    "test/utils/audios.test.ts",
    "test/daemon/getApplePreparationTimeout.property.test.ts",
    "test/features/video/AndroidScreenRecord.test.ts",
  ])("%s keeps running everywhere", (testPath) => {
    expect(hasIosPathToken(testPath)).toBe(false);
  });
});

describe("parseManifest", () => {
  test("reads verdict, pattern and reason, skipping comments and blank lines", () => {
    expect(
      parseManifest(MANIFEST).map(({ verdict, pattern, reason, line }) => [
        verdict,
        pattern,
        reason,
        line,
      ]),
    ).toEqual([
      ["portable", "test/lint/**", "source scans", 3],
      ["portable", "test/daemon/devicePool.iosRecovery.test.ts", "shared pool logic", 4],
      ["macos", "test/utils/runtimeCompatibility.test.ts", "imports only iOS source", 5],
    ]);
  });

  test("tolerates CRLF line endings", () => {
    expect(parseManifest("macos test/a.test.ts # why\r\n")).toHaveLength(1);
  });

  test.each([
    ["unknown verdict", "skip test/a.test.ts # why", /verdict must be/],
    ["missing reason", "macos test/a.test.ts", /needs a "# <reason>"/],
    ["missing pattern", "macos # why", /expected "macos <path-or-glob>/],
    ["extra column", "macos test/a.test.ts test/b.test.ts # why", /expected "macos <path-or-glob>/],
  ])("rejects %s", (_name, text, message) => {
    expect(() => parseManifest(text)).toThrow(message);
  });
});

describe("classifyTestPath", () => {
  const rules = parseManifest(MANIFEST);

  test("a path token marks a test macOS-only", () => {
    expect(classifyTestPath("test/utils/ios-cmdline-tools/simctl.test.ts", rules)).toEqual({
      macosOnly: true,
      source: "path-token",
    });
  });

  test("a portable rule overrides the path token", () => {
    const result = classifyTestPath("test/daemon/devicePool.iosRecovery.test.ts", rules);
    expect(result.macosOnly).toBe(false);
    expect(result.source).toBe("manifest-portable");
  });

  test("a glob rule covers a directory", () => {
    expect(classifyTestPath("test/lint/iosDeviceKindRouting.test.ts", rules).macosOnly).toBe(false);
  });

  test("a macos rule covers a test with no iOS token", () => {
    const result = classifyTestPath("test/utils/runtimeCompatibility.test.ts", rules);
    expect(result.macosOnly).toBe(true);
    expect(result.source).toBe("manifest-macos");
  });

  test("leading ./ and backslashes do not change the verdict", () => {
    expect(classifyTestPath("./test/lint/iosDeviceKindRouting.test.ts", rules).macosOnly).toBe(
      false,
    );
    expect(
      classifyTestPath("test\\utils\\ios-cmdline-tools\\simctl.test.ts", rules).macosOnly,
    ).toBe(true);
  });

  test("the first matching rule wins", () => {
    const ordered = parseManifest("macos test/x/**  # a\nportable test/x/b.test.ts # b\n");
    expect(classifyTestPath("test/x/b.test.ts", ordered).macosOnly).toBe(true);
  });

  test("unmatched paths without a token run everywhere", () => {
    expect(classifyTestPath("test/server/toolRegistry.test.ts", rules)).toEqual({
      macosOnly: false,
      source: "none",
    });
  });
});

describe("partitionTestPaths", () => {
  test("keeps input order in both halves", () => {
    const rules = parseManifest(MANIFEST);
    const { run, skipped } = partitionTestPaths(
      [
        "test/a.test.ts",
        "test/utils/ios-cmdline-tools/simctl.test.ts",
        "test/lint/iosX.test.ts",
        "test/utils/runtimeCompatibility.test.ts",
      ],
      rules,
    );
    expect(run).toEqual(["test/a.test.ts", "test/lint/iosX.test.ts"]);
    expect(skipped).toEqual([
      "test/utils/ios-cmdline-tools/simctl.test.ts",
      "test/utils/runtimeCompatibility.test.ts",
    ]);
  });
});

describe("renderSkipBunfig", () => {
  const bunfig = `[test]
preload = ["./test/setup/a.ts"]
pathIgnorePatterns = ["scratch/**"]
coverageDir = "./coverage"
`;

  test("appends the skipped files to pathIgnorePatterns and keeps the rest", () => {
    const parsed = Bun.TOML.parse(renderSkipBunfig(bunfig, ["test/x/ios.test.ts"]));
    expect(parsed).toEqual({
      test: {
        preload: ["./test/setup/a.ts"],
        pathIgnorePatterns: ["scratch/**", "test/x/ios.test.ts"],
        coverageDir: "./coverage",
      },
    });
  });

  test("adds pathIgnorePatterns when the repo bunfig has none", () => {
    const parsed = Bun.TOML.parse(
      renderSkipBunfig('[test]\npreload = ["./p.ts"]\n', ["test/a.test.ts"]),
    );
    expect(parsed).toEqual({
      test: { preload: ["./p.ts"], pathIgnorePatterns: ["test/a.test.ts"] },
    });
  });

  test("refuses bunfig settings it would silently drop", () => {
    expect(() => renderSkipBunfig("[test]\nbail = 1\n", [])).toThrow(/Unsupported bunfig/);
  });
});

describe("skip report", () => {
  const rules = parseManifest(MANIFEST);
  const report = buildSkipReport(
    [
      "test/utils/ios-cmdline-tools/simctl.test.ts",
      "test/a/ios.integration.test.ts",
      "test/utils/runtimeCompatibility.test.ts",
    ],
    rules,
  );

  test("counts files by how they were classified", () => {
    expect(report.total).toBe(3);
    expect(report.integration).toBe(1);
    expect(report.pathToken).toBe(2);
    expect(report.byRule.get("test/utils/runtimeCompatibility.test.ts")).toBe(1);
  });

  test("renders a stderr line and a step-summary table", () => {
    expect(renderReportLine(report)).toContain("skipping 3 macOS-only (iOS) test files");
    expect(renderReportMarkdown(report, "linux")).toContain("| iOS path token | 2 |");
    expect(renderReportMarkdown(report, "linux")).toContain("skipped on linux");
  });
});
