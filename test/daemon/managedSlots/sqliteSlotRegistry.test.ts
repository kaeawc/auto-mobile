import { describe, expect, test } from "bun:test";
import path from "node:path";
import {
  MANAGED_SLOT_REGISTRY_BUSY_TIMEOUT_MS,
  openSqliteSlotRegistry,
  defaultSlotRegistryPath,
} from "../../../src/daemon/managedSlots/sqliteSlotRegistry";
import { SQLITE_BUSY_TIMEOUT_MS } from "../../../src/db/database";
import { describeSlotRegistryContract } from "./slotRegistryContract";

// `:memory:` keeps the shared contract fast; the file-backed and cross-process behaviour lives in
// sqliteSlotRegistry.integration.test.ts.
describeSlotRegistryContract("SqliteSlotRegistry (:memory:)", (timer, isExecOwnerLive) =>
  openSqliteSlotRegistry({ dbPath: ":memory:", timer, isExecOwnerLive }),
);

describe("defaultSlotRegistryPath", () => {
  test("lives under the host-wide ADB-server coordination root, not the per-daemon DB dir", () => {
    const resolved = defaultSlotRegistryPath(
      { AUTOMOBILE_DB_DIR: "/tmp/per-daemon-db", AUTOMOBILE_COORDINATION_DIR: "/tmp/coord" },
      "/home/agent",
    );
    expect(resolved).toBe(
      // resolve(): on Windows an absolute POSIX-style home is anchored to the current drive.
      path.resolve(
        "/home/agent",
        ".auto-mobile",
        "adb-servers",
        "managed-slots",
        "registry",
        "slots.sqlite",
      ),
    );
  });

  test("honours the ADB-server coordination override shared by every daemon", () => {
    const resolved = defaultSlotRegistryPath(
      { AUTOMOBILE_ADB_SERVER_COORDINATION_DIR: "/srv/am-shared" },
      "/home/agent",
    );
    expect(resolved).toBe(path.join("/srv/am-shared", "managed-slots", "registry", "slots.sqlite"));
  });
});

describe("registry lock waits", () => {
  test("wait far less than the per-daemon DB so contention cannot stall the heartbeat path", () => {
    expect(MANAGED_SLOT_REGISTRY_BUSY_TIMEOUT_MS).toBeLessThan(SQLITE_BUSY_TIMEOUT_MS);
    expect(MANAGED_SLOT_REGISTRY_BUSY_TIMEOUT_MS).toBeLessThanOrEqual(1_000);
  });
});
