import { beforeAll, describe, test } from "bun:test";
import {
  assertOwnershipInvariants,
  ownershipSeedOverride,
  type HarnessProfile,
} from "../helpers/poolOwnershipConcurrencyHarness";

// Seeded properties for the managed-slot life and the tool path (#11444, #10655), on the same
// pool-level harness as poolOwnershipConcurrency.property.test.ts. The slot steps assign a device
// to a slot, start and end its execution and release it; the tool steps are a read with and
// without a session, a control call, an `ide/*` mutation and SQL in read and write forms. After
// every step the harness checks the three tool-path invariants on top of the ownership ones:
//
//   - no non-owner control ever runs a handler;
//   - no slot device is allocated generically;
//   - reads never stamp activity.
//
// Widen locally the same way: AUTOMOBILE_POOL_OWNERSHIP_SEEDS / AUTOMOBILE_POOL_OWNERSHIP_SEED_BASE.

const STEPS = 40;
const SEEDS_PER_TEST = 3;
const TESTS_PER_PROFILE = 3;

const PROFILES: Record<string, HarnessProfile> = {
  /** Generic acquisitions racing slot assignment and the slot's execution lifecycle. */
  slots: {
    steps: STEPS,
    weights: {
      acquireMcp: 7,
      acquireCli: 2,
      release: 3,
      slotAssign: 5,
      slotExecStart: 4,
      slotExecEnd: 3,
      slotRelease: 2,
      control: 2,
      advance: 3,
      kill: 1,
      reconnect: 1,
      restart: 1,
      settle: 3,
    },
  },
  /** Reads and control calls from holders, other sessions and sessionless callers. */
  tools: {
    steps: STEPS,
    weights: {
      acquireMcp: 7,
      acquireCli: 2,
      release: 3,
      toolRead: 5,
      sqlRead: 4,
      toolControl: 5,
      ideMutation: 4,
      sqlWrite: 4,
      control: 3,
      advance: 5,
      monitorTick: 2,
      closeConnection: 1,
      reopenConnection: 1,
      settle: 3,
    },
  },
  /** Everything at once: a slot's device is both contended and driven. */
  slotsAndTools: {
    steps: STEPS,
    weights: {
      acquireMcp: 6,
      acquireAutolock: 2,
      release: 3,
      slotAssign: 4,
      slotExecStart: 4,
      slotExecEnd: 3,
      slotRelease: 2,
      toolRead: 3,
      sqlRead: 2,
      toolControl: 5,
      ideMutation: 3,
      sqlWrite: 3,
      advance: 4,
      settle: 3,
    },
  },
};

function seedChunks(firstSeed: number): number[][] {
  const sweep = ownershipSeedOverride();
  if (sweep) {
    return [sweep];
  }
  return Array.from({ length: TESTS_PER_PROFILE }, (_, chunk) =>
    Array.from({ length: SEEDS_PER_TEST }, (_, i) => firstSeed + chunk * SEEDS_PER_TEST + i),
  );
}

describe("managed slots and the tool path under seeded concurrent interleavings", () => {
  beforeAll(async () => {
    if (ownershipSeedOverride()) {
      return;
    }
    // Warm the harness's cold path here: CI's per-test timing excludes beforeAll.
    await assertOwnershipInvariants([1], PROFILES.slots, { managedSlots: true });
  });

  for (const [name, profile] of Object.entries(PROFILES)) {
    for (const seeds of seedChunks(1)) {
      test(`${name}: seeds ${seeds[0]}-${seeds.at(-1)} keep every slot and tool-path invariant`, async () => {
        await assertOwnershipInvariants(seeds, profile, { managedSlots: true });
      });
    }
  }
});
