import { afterAll, afterEach } from "bun:test";
import { appendFileSync, readFileSync } from "node:fs";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  drainViolations,
  installRealDeviceToolSpawnGuard,
  isUnitTestPath,
  type Violation,
} from "./realDeviceToolSpawnGuard";

const root = fileURLToPath(new URL("../../", import.meta.url));
const testFile = relative(root, process.argv[1] ?? "").replaceAll("\\", "/");
// The Windows test runner drops --isolate, so argv cannot attribute violations.
if (process.platform !== "win32" && isUnitTestPath(testFile)) {
  const report: Violation[] = [];
  const censusFile = process.env.AUTOMOBILE_SPAWN_GUARD_CENSUS_FILE;
  installRealDeviceToolSpawnGuard({
    target: Bun,
    testFile,
    loadAllowList: () =>
      new Set(
        readFileSync(
          new URL("../../scripts/unit-test-device-spawn-allowlist.txt", import.meta.url),
          "utf8",
        )
          .split("\n")
          .filter((line) => line && !line.startsWith("#")),
      ),
    mode: censusFile ? "census" : "enforce",
    record: censusFile
      ? (tool, argv) =>
          appendFileSync(censusFile, `${testFile}\t${tool}\t${JSON.stringify(argv)}\n`)
      : undefined,
    report,
  });
  afterEach(() => drainViolations(report));
  // Bun runs preload-registered afterAll after the file's own teardown hooks.
  // Drain again so even a swallowed launch after the last test fails the file.
  afterAll(() => drainViolations(report));
}
