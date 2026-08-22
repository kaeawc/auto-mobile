import {
  TelemetryRecorder,
  getNoOpTelemetryRepository,
} from "../../src/features/telemetry/TelemetryRecorder";
import { AndroidEmulatorClient } from "../../src/utils/android-cmdline-tools/AndroidEmulatorClient";

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
