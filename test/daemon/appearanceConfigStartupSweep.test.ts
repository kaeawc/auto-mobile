import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Kysely } from "kysely";
import { sweepStaleAppearanceConfigs } from "../../src/daemon/appearanceConfigStartupSweep";
import type { RehydrationSummary } from "../../src/daemon/sessionManager";
import {
  createAppearanceConfigRepository,
  type KeyedConfigRepository,
} from "../../src/db/keyedJsonConfigRepository";
import type { Database } from "../../src/db/types";
import type { AppearanceConfig } from "../../src/models";
import { pruneSessionAppearanceConfigs } from "../../src/server/appearanceManager";
import { createTestDatabase } from "../db/testDbHelper";

// #11076: per-session appearance rows outlived crashes, journal-terminalized UUIDs and pruned
// session rows; the startup sweep after rehydration drops rows naming no live device session.

const config = {
  syncWithHost: false,
  defaultMode: "dark",
  applyOnConnect: true,
} as AppearanceConfig;

function summary(overrides: Partial<RehydrationSummary> = {}): RehydrationSummary {
  return { rehydrated: [], terminalized: [], skipped: [], timedOut: false, ...overrides };
}

describe("startup appearance-row sweep (#11076)", () => {
  let db: Kysely<Database>;
  let repository: KeyedConfigRepository<AppearanceConfig>;
  const prune: typeof pruneSessionAppearanceConfigs = (isLive) =>
    pruneSessionAppearanceConfigs(isLive, repository);

  beforeEach(async () => {
    db = await createTestDatabase();
    repository = createAppearanceConfigRepository(db);
    await repository.setConfig(config);
    for (const id of ["live", "crashed-observer", "terminalized", "pending", "not-recoverable"]) {
      await repository.setConfig(config, `session:${id}`);
    }
  });
  afterEach(async () => {
    await db.destroy();
  });

  test("drops rows of sessions that are neither live nor awaiting recovery", async () => {
    const dropped = await sweepStaleAppearanceConfigs(
      summary({
        rehydrated: ["live"],
        terminalized: [{ sessionUuid: "terminalized", reason: "identity-recovery-target-busy" }],
        skipped: [
          { sessionUuid: "pending", reason: "transient adb failure" },
          { sessionUuid: "not-recoverable", reason: "not-recoverable" },
        ],
      }),
      { getSession: (id) => (id === "live" ? {} : null) },
      prune,
    );

    expect(dropped.sort()).toEqual(["crashed-observer", "not-recoverable", "terminalized"]);
    expect((await repository.listKeys("session:")).sort()).toEqual([
      "session:live",
      "session:pending",
    ]);
    expect(await repository.getConfig()).toEqual(config);
  });

  test("a timed-out rehydration keeps every row", async () => {
    const dropped = await sweepStaleAppearanceConfigs(
      summary({ timedOut: true }),
      { getSession: () => null },
      prune,
    );

    expect(dropped).toEqual([]);
    expect(await repository.listKeys("session:")).toHaveLength(5);
  });
});
