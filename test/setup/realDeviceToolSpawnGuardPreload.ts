import { afterAll, afterEach, beforeEach, onTestFinished } from "bun:test";
import { appendFileSync, readFileSync } from "node:fs";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  drainViolations,
  installRealDeviceToolSpawnGuard,
  testFileFromStack,
  type Violation,
} from "./realDeviceToolSpawnGuard";

const root = fileURLToPath(new URL("../../", import.meta.url));
const relativeTestFile = (path: string): string => relative(root, path).replaceAll("\\", "/");

let hasCallerTestFrame = false;
function spawnTestFile(): string {
  const previousLimit = Error.stackTraceLimit;
  try {
    // Device executors have deeper synchronous stacks than the default ten frames.
    Error.stackTraceLimit = Math.max(previousLimit, 64);
    const caller = testFileFromStack(new Error().stack);
    hasCallerTestFrame = caller !== undefined;
    return relativeTestFile(caller ?? Bun.main);
  } finally {
    Error.stackTraceLimit = previousLimit;
  }
}
// Keep Windows interception disabled until its process boundary is verified.
if (process.platform !== "win32") {
  const report: Violation[] = [];
  const pendingFinalHooks = new Set<string>();
  const reportedOutsideFiles = new Set<string>();
  let activeTest: { file: string; scope: object } | undefined;
  beforeEach(() => {
    activeTest = { file: relativeTestFile(Bun.main), scope: {} };
    // afterEach runs before file afterAll. Clear after *all* per-test teardown.
    onTestFinished(() => {
      activeTest = undefined;
    });
  });
  const censusFile = process.env.AUTOMOBILE_SPAWN_GUARD_CENSUS_FILE;
  installRealDeviceToolSpawnGuard({
    target: Bun,
    testFile: "",
    // argv stays fixed to one selected file. Bun.main changes as files run.
    // Async MCP callbacks can lack a test frame; retained frames take precedence.
    getTestFile: spawnTestFile,
    // Without a retained caller frame, use the once-per-file backstop instead
    // of assigning uncertain background work to every subsequent active test.
    getTestScope: (file) =>
      hasCallerTestFrame && activeTest?.file === file ? activeTest.scope : undefined,
    onViolation: (violation) => {
      if (violation.testScope) {
        return;
      }
      const { testFile } = violation;
      if (reportedOutsideFiles.has(testFile)) {
        report.splice(report.indexOf(violation), 1);
        return;
      }
      if (!pendingFinalHooks.has(testFile)) {
        pendingFinalHooks.add(testFile);
        // One synthetic hook failure per file for import/setup/late/swallowed
        // launches. Register on first hit, even if the first run file is exempt.
        afterAll(() => {
          pendingFinalHooks.delete(testFile);
          if (report.some((pending) => pending.testFile === testFile)) {
            reportedOutsideFiles.add(testFile);
          }
          drainViolations(report, (pending) => pending.testFile === testFile);
        });
      }
    },
    loadAllowList: () =>
      new Set(
        readFileSync(
          process.env.AUTOMOBILE_SPAWN_GUARD_ALLOWLIST ??
            new URL("../../scripts/unit-test-device-spawn-allowlist.txt", import.meta.url),
          "utf8",
        )
          .split(/\r?\n/)
          .filter((line) => line && !line.startsWith("#")),
      ),
    mode: censusFile ? "census" : "enforce",
    record: censusFile
      ? (tool, argv, testFile) =>
          appendFileSync(censusFile, `${testFile}\t${tool}\t${JSON.stringify(argv)}\n`)
      : undefined,
    report,
  });
  afterEach(() => {
    const scope = activeTest?.scope;
    if (scope) {
      drainViolations(report, (violation) => violation.testScope === scope);
    }
  });
}
