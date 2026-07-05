import { afterEach, describe, expect, test } from "bun:test";
import { Daemon } from "../../src/daemon/daemon";
import { DaemonState } from "../../src/daemon/daemonState";
import { FakeTimer } from "../fakes/FakeTimer";
import { DeviceSessionRepository } from "../../src/db/deviceSessionRepository";
import { CountingIdGenerator } from "../../src/utils/IdGenerator";

/**
 * Pins the issue #3110 invariant: iOS CtrlProxy warm-up
 * (initializeIosServices) is started DETACHED and must NOT block the code path
 * that reaches daemon readiness (socket listening + PID file written). If a slow
 * or maxed-out iOS warm-up could delay readiness, a cold macOS CI runner would
 * intermittently blow DAEMON_STARTUP_TIMEOUT_MS.
 *
 * We exercise the exact seam start() uses — startIosServicesWarmup() — rather
 * than the heavyweight start(), keeping the test <100ms and free of real
 * sockets/DB.
 */
describe("Daemon iOS warm-up is detached from readiness (#3110)", function() {
  function makeDaemon(): Daemon {
    return new Daemon(
      {},
      undefined,
      new FakeTimer(),
      new DeviceSessionRepository(),
      new CountingIdGenerator("daemon-session")
    );
  }

  afterEach(() => {
    // Constructing a Daemon initializes the global DaemonState singleton; reset
    // it so this file does not leak initialized state into other test files.
    if (DaemonState.getInstance().isInitialized()) {
      DaemonState.getInstance().reset();
    }
  });

  test("startIosServicesWarmup returns without awaiting the warm-up", async () => {
    const daemon = makeDaemon();

    // Replace the real per-device warm-up with a promise we control, so we can
    // prove the caller does not block on it.
    let resolveWarmup: (() => void) | undefined;
    let warmupStarted = false;
    (daemon as unknown as { initializeIosServices: () => Promise<void> }).initializeIosServices =
      () => {
        warmupStarted = true;
        return new Promise<void>(resolve => {
          resolveWarmup = resolve;
        });
      };

    // start() calls this synchronously; it must return immediately even
    // though the warm-up is still pending.
    (daemon as unknown as { startIosServicesWarmup: () => void }).startIosServicesWarmup();

    expect(warmupStarted).toBe(true);

    const warmup = (daemon as unknown as { iosServicesWarmup: Promise<void> }).iosServicesWarmup;

    // The warm-up must still be pending: races the detached promise against an
    // already-resolved sentinel. If the caller had awaited the warm-up, control
    // would not have returned here at all, but this also guards a mistaken
    // synchronous resolution.
    const pendingSentinel = Symbol("pending");
    const settledFirst = await Promise.race([
      warmup.then(() => "settled"),
      Promise.resolve(pendingSentinel),
    ]);
    expect(settledFirst).toBe(pendingSentinel);

    // Draining the warm-up must resolve cleanly (readiness never depended on it).
    resolveWarmup!();
    await expect(warmup).resolves.toBeUndefined();
  });

  test("a detached warm-up rejection is swallowed, never an unhandled rejection", async () => {
    const daemon = makeDaemon();

    (daemon as unknown as { initializeIosServices: () => Promise<void> }).initializeIosServices =
      () => Promise.reject(new Error("boom"));

    (daemon as unknown as { startIosServicesWarmup: () => void }).startIosServicesWarmup();

    const warmup = (daemon as unknown as { iosServicesWarmup: Promise<void> }).iosServicesWarmup;

    // The defensive .catch() in startIosServicesWarmup must turn the rejection
    // into a logged, resolved promise so the daemon's unhandled-rejection fatal
    // handler never fires.
    await expect(warmup).resolves.toBeUndefined();
  });
});
