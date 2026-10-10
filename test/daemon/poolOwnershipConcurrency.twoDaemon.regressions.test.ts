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
  test.todo("concurrent startups never revive or terminalize the session the peer rehydrated", async () => {
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
});
