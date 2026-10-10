import { describe, expect, test } from "bun:test";
import { runTwoDaemonSteps, type TwoDaemonStep } from "../helpers/twoDaemonOwnershipHarness";

// Minimized regressions for the cross-daemon violations the two-daemon mode of the seeded
// ownership harness (test/helpers/twoDaemonOwnershipHarness.ts) found. Each is a `test.todo`: it
// fails on current main and documents the bug; `bun test --todo` runs them. The fix PR turns its
// todo into a plain test and stops tolerating the matching violation kind in
// poolOwnershipConcurrency.twoDaemon.property.test.ts.

const step = (kind: TwoDaemonStep["kind"], fields: Partial<TwoDaemonStep> = {}): TwoDaemonStep => ({
  kind,
  daemon: 0,
  client: 0,
  device: 0,
  ms: 0,
  turns: 0,
  ...fields,
});

describe("cross-daemon ownership regressions", () => {
  // killDevice's lifecycle guard (assertLifecycleCallerHoldsDevice,
  // src/server/lifecycleDeviceOwnership.ts) asks only its own daemon's SessionManager who holds
  // the device. A device a live peer daemon holds (its session is assigned and its allocation
  // claim is published) reads as unheld, so a sessionless killDevice on the other daemon stops the
  // peer's emulator without `force`, and the peer's session dies as device-disconnected.
  // Seed 6 of the `contention` profile, shrunk. #11200
  test("a daemon refuses to kill a device its live peer holds", async () => {
    const result = await runTwoDaemonSteps([
      step("acquire", { client: 1, daemon: 0, device: 2, turns: 3 }),
      step("settle"),
      step("kill", { client: 2, daemon: 1, device: 2 }),
    ]);
    expect(result.violation).toBeUndefined();
  });

  // Two daemons starting together both list the same recoverable row (a session the first
  // daemon's previous incarnation released as daemon-shutdown): listRecoverableSessions
  // (src/db/deviceSessionRepository.ts) takes no row-level ownership, and assertRecoveryTarget-
  // NotForeignOwned (src/daemon/devicePool.ts) sees no claim yet. Both rehydrate the session; the
  // loser's SessionManager upserts the row under its own daemon id (persistSession) before
  // claimRecoveredDevice finds the winner's fresh claim, then rolls back and terminalizes the row as
  // identity-recovery-owned-by-other-daemon. The winner keeps the session live on a row that is
  // released and owned by the other daemon. Seed 306 of the `restarts` profile, shrunk. #11200
  test("concurrent startups never revive or terminalize the session the peer rehydrated", async () => {
    const result = await runTwoDaemonSteps([
      step("crash", { daemon: 1, turns: 13 }),
      step("acquireAny", { client: 0, daemon: 0 }),
      step("stop", { daemon: 0 }),
      step("settle", { turns: 1 }),
      step("start", { daemon: 0, turns: 1 }),
      step("start", { daemon: 1 }),
    ]);
    expect(result.violation).toBeUndefined();
  });

  // A recovery a client cancelled after it claimed the session's recoverable row (#11200 claim)
  // left the row owned by the live daemon, which never retried it: the peer and that daemon's own
  // startup refused the row as owned by another daemon until the daemon exited or the row
  // expired. The failed recovery now hands the claim back. #11243
  test("a cancelled recovery hands its claim on the row back", async () => {
    const result = await runTwoDaemonSteps([
      step("acquireAny", { daemon: 0 }),
      step("settle"),
      step("stop", { daemon: 0 }),
      step("settle"),
      step("cancelRecovery", { daemon: 1, turns: 3 }),
      step("settle"),
    ]);
    expect(result.violation).toBeUndefined();
  });

  // A terminal release whose row write is parked lives only in the releasing daemon's journal.
  // Startup adoption skips a live peer's journal, so a daemon that started while the releasing
  // daemon was live never read it. Once that daemon died the survivor saw only a row owned by a
  // dead daemon: a still-active one (this scenario) it refused forever as owned by another daemon,
  // and a recoverably released one it revived (terminalReleaseJournalPeerAdoption.test.ts, and
  // the released-session-revived invariant). The survivor now adopts a dead owner's journal
  // before it reads that owner's row, and writes the terminal row itself. #11355
  test("a survivor never revives a session its dead peer had journaled as released", async () => {
    const result = await runTwoDaemonSteps([
      step("acquireAny", { daemon: 0 }),
      step("settle"),
      step("wedge", { daemon: 0 }),
      step("release", { turns: 13 }),
      step("crash", { daemon: 0 }),
      step("cancelRecovery", { daemon: 1, turns: 40 }),
      step("settle"),
    ]);
    expect(result.violation).toBeUndefined();
    // B settled the dead daemon's journal: it wrote the terminal row, then removed A's file.
    expect(result.trace.join("\n")).toContain(
      "B1 journal removed /automobile-data/terminal-release-intents/daemon-A-1.jsonl",
    );
  });
});
