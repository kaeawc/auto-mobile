import {
  TelemetryRecorder,
  getNoOpTelemetryRepository,
} from "../../src/features/telemetry/TelemetryRecorder";
import { AndroidEmulatorClient } from "../../src/utils/android-cmdline-tools/AndroidEmulatorClient";
import { setDeviceReadinessProxyDriverProviderForTesting } from "../../src/server/deviceReadinessProxyProvider";

/**
 * Globally neutralize the {@link TelemetryRecorder} for the whole suite so a
 * fire-and-forget telemetry write can never resolve the real file-backed DB
 * (issue #3084). The nav manager's post-commit
 * `TelemetryRecorder.getInstance().recordNavigationEvent(...)` is a floating,
 * un-awaited promise; the recorder's own `try/catch` SWALLOWS the DB guard throw
 * (a silent `logger.error`, not a test failure), and on the floating path it can
 * also surface as a misattributed unhandled rejection. Neither fails the
 * offending test deterministically.
 *
 * Installing the no-op repository as a process-wide default means every recorder
 * built from here on — including one lazily rebuilt after a test's
 * `resetInstance()` in teardown — never touches the DB. Tests that must assert on
 * telemetry still install `installInMemoryNavManager()` (spies the instance) or
 * inject their own recorder; this default only removes the ACCIDENTAL real-DB
 * write path, it does not block explicit assertions.
 */
TelemetryRecorder.setDefaultRepositoryOverride(getNoOpTelemetryRepository());

// Emulator launch tests must never create real TCP probes. Individual tests
// inject unavailable ports when exercising allocation behavior.
AndroidEmulatorClient.setHostPortAvailabilityCheckerForTesting({
  isAvailable: async () => true,
});

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
setDeviceReadinessProxyDriverProviderForTesting(() => ({
  resetSetupState: () => {},
  setup: async () => ({ success: true, message: "ok" }),
  waitForConnection: async () => true,
  isInstalled: async () => true,
  isVersionCompatible: async () => true,
}));
