import { describe, test } from "bun:test";
import {
  assertOwnershipInvariants,
  ownershipSeedOverride,
  type HarnessProfile,
  type ViolationKind,
} from "../helpers/poolOwnershipConcurrencyHarness";

// Seeded concurrency properties for device-session ownership over the real DevicePool,
// SessionManager, heartbeat monitor and daemon request handlers (see the harness for the step
// vocabulary and invariants). Each seed generates a step list; operations overlap at their await
// points in a seed-decided order. A failure prints the seed, a replay command, the shrunk step
// list and its trace.
//
// CI runs the fixed seeds below, a few per test so each stays inside the 100 ms budget. Widen
// locally with AUTOMOBILE_POOL_OWNERSHIP_SEEDS (how many) and AUTOMOBILE_POOL_OWNERSHIP_SEED_BASE
// (first seed), for example:
//   AUTOMOBILE_POOL_OWNERSHIP_SEEDS=2000 bun test test/daemon/poolOwnershipConcurrency.property.test.ts
//
// A violation kind listed here is tolerated: a known, open bug with a minimized `test.todo`
// regression in poolOwnershipConcurrency.regressions.test.ts. Its fix removes the kind so the
// property is enforced again. The closed-connection-owns and double-release kinds were fixed in
// #11146.
const KNOWN_VIOLATIONS: ReadonlySet<ViolationKind> = new Set<ViolationKind>();

const STEPS = 40;
const SEEDS_PER_TEST = 3;
const TESTS_PER_PROFILE = 4;

const PROFILES: Record<string, HarnessProfile> = {
  /** Every operation, evenly mixed. */
  mixed: {
    steps: STEPS,
    weights: {
      acquireMcp: 6,
      acquireCli: 3,
      release: 3,
      control: 6,
      read: 4,
      loseHeartbeat: 2,
      resumeHeartbeat: 2,
      advance: 6,
      monitorTick: 2,
      cleanupSweep: 1,
      kill: 1,
      disconnect: 1,
      reconnect: 2,
      closeConnection: 2,
      reopenConnection: 2,
      planLabels: 2,
      planEnd: 2,
      restart: 1,
      settle: 4,
    },
  },
  /** Autolock acquisitions racing explicit binds, connection closes, releases and device loss. */
  autolock: {
    steps: STEPS,
    weights: {
      acquireAutolock: 7,
      acquireMcp: 3,
      acquireCli: 1,
      release: 3,
      control: 3,
      advance: 4,
      monitorTick: 2,
      kill: 1,
      disconnect: 1,
      reconnect: 2,
      closeConnection: 5,
      reopenConnection: 3,
      settle: 3,
    },
  },
  /** Many clients fighting over three devices while devices die and come back. */
  contention: {
    steps: STEPS,
    weights: {
      acquireMcp: 8,
      acquireCli: 4,
      release: 5,
      control: 3,
      kill: 3,
      disconnect: 3,
      reconnect: 5,
      closeConnection: 3,
      reopenConnection: 3,
      advance: 3,
      monitorTick: 2,
      planLabels: 3,
      planEnd: 2,
      settle: 4,
    },
  },
  /** Explicit releases racing expiry sweeps, heartbeat loss and device loss. */
  releaseRace: {
    steps: STEPS,
    weights: {
      acquireMcp: 6,
      acquireCli: 3,
      release: 6,
      loseHeartbeat: 4,
      resumeHeartbeat: 2,
      advance: 6,
      monitorTick: 5,
      cleanupSweep: 4,
      control: 3,
      kill: 2,
      disconnect: 2,
      reconnect: 3,
      closeConnection: 3,
      reopenConnection: 2,
      planLabels: 2,
      planEnd: 2,
      settle: 2,
    },
  },
  /** Idle windows, heartbeat loss, reads vs control calls, owner reconnects, daemon restarts. */
  liveness: {
    steps: STEPS,
    weights: {
      acquireMcp: 5,
      acquireCli: 3,
      control: 6,
      read: 6,
      loseHeartbeat: 4,
      resumeHeartbeat: 4,
      advance: 8,
      monitorTick: 3,
      cleanupSweep: 2,
      closeConnection: 3,
      reopenConnection: 3,
      release: 2,
      restart: 2,
      settle: 3,
    },
  },
};

/** Fixed chunks of consecutive seeds, or one chunk holding the local sweep's seeds. */
function seedChunks(firstSeed: number): number[][] {
  const sweep = ownershipSeedOverride();
  if (sweep) {
    return [sweep];
  }
  return Array.from({ length: TESTS_PER_PROFILE }, (_, chunk) =>
    Array.from({ length: SEEDS_PER_TEST }, (_, i) => firstSeed + chunk * SEEDS_PER_TEST + i),
  );
}

describe("device-session ownership under seeded concurrent interleavings", () => {
  for (const [name, profile] of Object.entries(PROFILES)) {
    for (const seeds of seedChunks(1)) {
      test(`${name}: seeds ${seeds[0]}-${seeds.at(-1)} keep every ownership invariant`, async () => {
        await assertOwnershipInvariants(seeds, profile, { tolerate: KNOWN_VIOLATIONS });
      });
    }
  }
});
