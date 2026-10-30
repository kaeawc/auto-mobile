/**
 * Where a startup stage sits relative to the incumbent-restoration window (issue #6232).
 *
 * - `process entry`: before the early-owner overwrite; a failure leaves no shared file to repair.
 * - `incumbent window`: from the early-owner overwrite through the committed socket bind. The
 *   overwrite (issue #2871) clobbers any live incumbent's PID record before this process owns
 *   anything, and cannot be deferred (the direct-mode DB-ownership guard needs the owned path
 *   published first). Any failure in the window (DB init, HTTP bind, device discovery, iOS
 *   services, or the socket bind itself) leaves the shared PID file naming this about-to-exit
 *   contender, and because `socketBindCommitted` stays false exit cleanup is (correctly)
 *   suppressed and will not repair it. A failure here restores the captured live incumbent, so
 *   status()/`--daemon stop` keep pointing at the real winner; once the bind is committed the
 *   file is this process's and is never rewritten.
 * - `after bind`: the control socket is bound and committed; a failure restores nothing. A failure
 *   in `startAfterSocketBind()`'s rows instead stops the daemon (bounded) before it exits, since
 *   this process now owns rehydrated sessions, forward leases and children (#11156).
 */
export type DaemonStartupWindow = "process entry" | "incumbent window" | "after bind";

/**
 * The order `Daemon.start()` runs in. Rows run top to bottom: `startThroughSocketBind()` runs
 * them up to and including "background registry upgrade", and `startAfterSocketBind()` the rest.
 * Each comment is the rule that fixes a row's place, so a reorder must keep it.
 */
export const DAEMON_STARTUP_STAGES = {
  "enter process": "process entry",
  "entered daemon process": "process entry",
  // Subscribe here, not in the constructor: only a started daemon is ever stopped, so a
  // constructed-but-never-started daemon must not leave a listener on the global tracker (#10712).
  "tool-call-end activity subscription": "process entry",
  "forward lease owner": "process entry",
  // Publish the owned DB path in the PID file BEFORE opening the DB so the direct-mode
  // DB-ownership guard can tell a same-file collision from an isolated-path launch during our own
  // multi-second startup window, instead of failing closed on an unknown path. The ordering lives
  // behind runStartupPrologue() so it can be asserted with fakes (issue #2871).
  "database prologue": "incumbent window",
  // Adopt terminal releases a crashed predecessor never persisted (#10959) before any listener
  // can admit a session; startup rehydration writes their rows.
  "terminal release journal": "incumbent window",
  // Broker recovery needs the upgraded schema before admitting any sessions.
  "binding registry": "incumbent window",
  "daemon collaborators": "incumbent window",
  "http token prepare": "incumbent window",
  "http ingress": "incumbent window",
  // Initialize the device pool BEFORE the socket server so connecting clients see it.
  "device discovery": "incumbent window",
  "session rehydration": "incumbent window",
  // A session-only provider resolves prior ownership before exposing its socket or warming
  // runners for sessions that recovery will abandon.
  "session broker": "incumbent window",
  // Rehydrated sessions are now owned here and can safely warm their runners.
  "iOS services": "incumbent window",
  "recorder teardown redrive": "incumbent window",
  // Start the Unix socket server AFTER the device pool is ready.
  "control socket bind": "incumbent window",
  // Only past this point may this process's exit / shutdown cleanup delete the shared socket/PID
  // files: before it, the early owner record (issue #2871) makes the `expectedPid` self-check pass
  // even though we do not own the socket, so a lock-less contender refused over a live sibling
  // (issue #6232) must NOT clean up on exit and brick the winner (the #6140 failure mode via a
  // bypassed launch). This authorizes cleanup of the control socket and PID file; each aux bind
  // is tracked separately.
  "socket bind commit": "incumbent window",
  // Discovery publishes credentials only after authoritative control-socket ownership.
  "http token publish": "incumbent window",
  "background registry upgrade": "after bind",
  // Native broker cleanup must never hold up the control socket becoming reachable.
  "session broker recovery": "after bind",
  "services after socket bind": "after bind",
  "heartbeat monitor": "after bind",
  "maintenance monitors": "after bind",
  "startup report": "after bind",
  // Startup fully succeeded: the DB is up AND every startup DB-backed step completed. Only now
  // clear the crash-loop circuit breaker, so a permanent failure in any later startup step
  // (recorded before its fatal exit) isn't erased by a preflight that merely got past migrations
  // (issue #2784).
  "startup failure tracker reset": "after bind",
} as const satisfies Record<string, DaemonStartupWindow>;

export type DaemonStartupStageName = keyof typeof DAEMON_STARTUP_STAGES;

/** One startup step. A synchronous step runs without yielding, as the inline sequence did. */
export interface DaemonStartupStage<Name extends string = string> {
  readonly name: Name;
  readonly run: () => unknown;
}

/** Runs `stages` in order; the first failure stops the sequence and is rethrown unchanged. */
export async function runStartupStages<Name extends string>(
  stages: readonly DaemonStartupStage<Name>[],
  onStageFailure: (name: Name) => void = () => {},
): Promise<void> {
  for (const stage of stages) {
    try {
      const pending = stage.run();
      if (pending instanceof Promise) {
        await pending;
      }
    } catch (error) {
      // The caller's sequence owns the error; this only lets it react to which stage failed.
      onStageFailure(stage.name);
      throw error;
    }
  }
}
