import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Kysely } from "kysely";
import {
  type AppearanceSweepPeers,
  sweepStaleAppearanceConfigs,
} from "../../src/daemon/appearanceConfigStartupSweep";
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

const NO_PEERS: AppearanceSweepPeers = {
  liveDaemonSessionIds: new Set(),
  ownDaemonSessionId: "self",
  getPersistedSession: async () => undefined,
};

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
      NO_PEERS,
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
      NO_PEERS,
      prune,
    );

    expect(dropped).toEqual([]);
    expect(await repository.listKeys("session:")).toHaveLength(5);
  });

  test("keeps a live peer daemon's rows and drops only terminal or unknown-without-peer rows (#11158)", async () => {
    const persisted = new Map<
      string,
      { status: "active" | "released" | "expired"; daemon_session_id: string | null }
    >([
      ["crashed-observer", { status: "active", daemon_session_id: "live-peer" }],
      ["terminalized", { status: "released", daemon_session_id: "live-peer" }],
    ]);
    const peers: AppearanceSweepPeers = {
      liveDaemonSessionIds: new Set(["self", "live-peer"]),
      ownDaemonSessionId: "self",
      getPersistedSession: async (id) => persisted.get(id),
    };

    const dropped = await sweepStaleAppearanceConfigs(
      summary(),
      { getSession: () => null },
      peers,
      prune,
    );

    // "terminalized" is terminal; the rest are a live peer's active session or unknown (possibly
    // a live peer's observer) while a peer is live.
    expect(dropped).toEqual(["terminalized"]);
    expect(await repository.listKeys("session:")).toHaveLength(4);
  });

  test("without a live peer, an unknown or terminal session row is dropped", async () => {
    const dropped = await sweepStaleAppearanceConfigs(
      summary(),
      { getSession: () => null },
      {
        liveDaemonSessionIds: new Set(["self"]),
        ownDaemonSessionId: "self",
        getPersistedSession: async (id) =>
          id === "live" ? { status: "active", daemon_session_id: "self" } : undefined,
      },
      prune,
    );

    expect(dropped.sort()).toEqual([
      "crashed-observer",
      "not-recoverable",
      "pending",
      "terminalized",
    ]);
  });

  test("a failed session lookup keeps the row", async () => {
    const dropped = await sweepStaleAppearanceConfigs(
      summary(),
      { getSession: () => null },
      {
        liveDaemonSessionIds: new Set(),
        ownDaemonSessionId: "self",
        getPersistedSession: async () => {
          throw new Error("SQLITE_BUSY");
        },
      },
      prune,
    );

    expect(dropped).toEqual([]);
  });
});
