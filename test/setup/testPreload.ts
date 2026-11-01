import { cleanupTestDirectories } from "./testDirectories";
import { afterAll } from "bun:test";
import { testOverrides } from "../../src/utils/testOverrides";
import { FakeEmulatorGrpcPortRegistry } from "../fakes/FakeEmulatorGrpcPortRegistry";
import { rmSync } from "node:fs";
import childProcess from "node:child_process";
import { ensureAuxSocketDir } from "./auxSocketDir";
import { isUnitTestPath, spawnArgv } from "./realDeviceToolSpawnGuard";

// Bun test exits without emitting process exit; a global preload hook runs once
// after all files, while the exit fallback also covers other process entrypoints.
afterAll(cleanupTestDirectories);

// Install before portAvailabilityPreload imports AndroidCtrlProxyClient ->
// deviceDataStreamSocketServer -> daemonFiles -> constants (DAEMON_VERSION).
// An env override would leak to child server/daemon processes in integration tests.
testOverrides.gitMetadataClient = { readVersion: () => null, readDirtyState: async () => null };

/**
 * Match GitMetadataClient's version probes (including legacy argv), ignoring other test
 * files' git commands. Keep this local so importing production code cannot bind
 * spawnSync before the recording hooks are installed.
 */
export function isGitVersionProbe(argv: readonly string[]): boolean {
  if (argv[0] !== "git") {
    return false;
  }
  return (
    (argv.length === 3 && argv[1] === "rev-parse" && argv[2] === "--show-toplevel") ||
    (argv.length === 3 && argv[1] === "rev-parse" && argv[2] === "HEAD") ||
    (argv.length === 3 && argv[1] === "diff" && argv[2] === "HEAD") ||
    (argv.length === 4 &&
      argv[1] === "rev-parse" &&
      argv[2] === "--short=12" &&
      argv[3] === "HEAD") ||
    (argv.length === 4 &&
      argv[1] === "status" &&
      argv[2] === "--porcelain" &&
      argv[3] === "--untracked-files=no")
  );
}

/** Record version probes, including ones swallowed by version fallback. */
export const gitVersionPreloadSpawns: string[][] = [];
childProcess.spawnSync = new Proxy(childProcess.spawnSync, {
  apply(target, thisArg, args: unknown[]) {
    const argv =
      args[0] === "git" && Array.isArray(args[1]) && args[1].every((arg) => typeof arg === "string")
        ? ["git", ...args[1]]
        : [];
    if (isGitVersionProbe(argv)) {
      gitVersionPreloadSpawns.push([...argv]);
    }
    return Reflect.apply(target, thisArg, args);
  },
});
Bun.spawnSync = new Proxy(Bun.spawnSync, {
  apply(target, thisArg, args: unknown[]) {
    const argv = spawnArgv(args);
    if (isGitVersionProbe(argv)) {
      gitVersionPreloadSpawns.push([...argv]);
    }
    return Reflect.apply(target, thisArg, args);
  },
});

/** Isolate auxiliary sockets from live daemons and parallel tests (issue #7616, PR #7612). */
const auxSocketDir = ensureAuxSocketDir();
testOverrides.auxSocketDir = auxSocketDir;

const cleanupFlagKey = `__automobile_aux_socket_cleanup_registered_${process.pid}`;
if (!(cleanupFlagKey in globalThis)) {
  Object.defineProperty(globalThis, cleanupFlagKey, {
    value: true,
    configurable: true,
    writable: true,
    enumerable: true,
  });
  process.once("exit", () => {
    try {
      rmSync(auxSocketDir, { recursive: true, force: true });
    } catch {
      // Cleanup is best effort; a lingering socket must not block process exit.
    }
  });
}

/**
 * Globally neutralize TelemetryRecorder for the whole suite so a
 * fire-and-forget telemetry write can never resolve the real file-backed DB
 * (issue #3084). The nav manager's post-commit
 * `TelemetryRecorder.getInstance().recordNavigationEvent(...)` is a floating,
 * un-awaited promise; the recorder's own `try/catch` SWALLOWS the DB guard throw
 * (a silent `logger.error`, not a test failure), and on the floating path it can
 * also surface as a misattributed unhandled rejection. Neither fails the
 * offending test deterministically.
 *
 * Selecting the no-op repository as a process-wide default means every recorder
 * built from here on — including one lazily rebuilt after a test's
 * `resetInstance()` in teardown — never touches the DB. Tests that must assert on
 * telemetry still install `installInMemoryNavManager()` (spies the instance) or
 * inject their own recorder; this default only removes the ACCIDENTAL real-DB
 * write path, it does not block explicit assertions.
 */
testOverrides.telemetryNoOpDefault = true;

// Device-manager boot tests run against fake emulators and simulators; the
// shared boot admission gates (#11181) would otherwise sample the real host's
// adb listing and process table, and could queue a fake boot behind real
// emulators. Gate tests construct gates over fake sources directly.
testOverrides.bootAdmissionGatesDisabled = true;

// A Daemon reads its own process generation token when it is constructed, which launches `ps` on
// macOS. A unit test's daemon runs in the test runner's process, so there is no daemon process to
// identify; tests of the capture itself build their own provider over fake readers. Integration
// files keep the real capture. Bun.main is read at each call: it follows the running file.
testOverrides.processGenerationCaptureDisabled = () => isUnitTestPath(Bun.main);

// Unit tests may yield only microtasks: queued log lines retain heap until real I/O runs,
// making a collection land on an innocent test (#12159). Sink assertions opt in with
// useRealLogSinks(); integration and stress files keep real sinks. Read Bun.main lazily.
testOverrides.logSinksDisabled = () => isUnitTestPath(Bun.main);

// Emulator launch tests must never create real TCP probes. Individual tests
// inject unavailable ports when exercising allocation behavior.
testOverrides.hostPortAvailabilityChecker = {
  isPortAvailable: () => true,
};

// Emulator gRPC leases default to an in-memory registry: unit tests must never create real lock files.
testOverrides.emulatorGrpcPortRegistry = () => new FakeEmulatorGrpcPortRegistry();

/**
 * Globally neutralize the per-session Android accessibility-service readiness
 * setup for the whole `bun test` process (issue #6227).
 *
 * `createToolExecutionContext`'s device-readiness upgrade runs real
 * `AndroidCtrlProxyManager.getInstance(device).setup()` /
 * `AndroidCtrlProxyClient.getInstance(device).waitForConnection()` for any
 * existing session with no recorded readiness — including sessions created
 * directly via `SessionManager.createSession` / `DevicePool` in integration
 * tests that bypass the `deviceTools.ts` acquisition recorder. Against a fake
 * device that setup blocks on unbounded real host I/O past bun's 5000ms
 * timeout; a timed-out test skips its `finally` cleanup and leaks process-wide
 * singletons into every later test. Installing a fast no-op driver here means
 * NO test can hang on this path, regardless of which file creates the session.
 *
 * This is scoped to the readiness driver only, so the dedicated CtrlProxy
 * manager/client suites keep exercising the real `getInstance`/`setup` code.
 * Tests that must assert this path ran (e.g. readiness call counts) install
 * their own counting provider via `test/helpers/stubCtrlProxySetup.ts`.
 */
testOverrides.deviceReadinessProxyDriverProvider = () => ({
  resetSetupState: () => {},
  setup: async () => ({ success: true, message: "ok" }),
  waitForConnection: async () => true,
  resetConnectionBudget: () => {},
  isInstalled: async () => true,
  isVersionCompatible: async () => true,
});

// Unit tests must not scale budgets by the real host load.
testOverrides.hostLoad = { loadAverage1m: () => 0, cpuCount: () => 1 };
