import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Kysely } from "kysely";
import { BunSqliteDialect } from "../../../../src/db/bunSqliteDialect";
import { migrateBindingRegistry } from "../../../../src/daemon/sessionBroker/registry/bindingRegistryMigrations";
import {
  SqliteBindingRegistry,
  type BindingRegistryDatabase,
} from "../../../../src/daemon/sessionBroker/registry/sqliteBindingRegistry";
import type {
  BindingScopeIdentity,
  BindingScopeInvalidationReason,
} from "../../../../src/daemon/sessionBroker/registry/bindingRegistry";
import { FakeTimer } from "../../../fakes/FakeTimer";

// A registry written by a build before the broker landing (#12497) can hold the broker scope marked
// invalidated with reason "abandoned" by the old abandoned-scope sweep. The landing removed the
// revive branch, so ensureScope refused that scope forever and the broker never started again.

const IDENTITY: BindingScopeIdentity = {
  managedHostScope: "host-1",
  runnerNamespace: "broker",
  runnerIncarnation: "boot-1",
};

describe("ensureScope on a scope an older build marked abandoned", () => {
  let db: Kysely<BindingRegistryDatabase> | undefined;

  afterEach(async () => {
    await db?.destroy();
    db = undefined;
  });

  async function openWithScopeInState(
    state: "invalidating" | "invalidated",
    reason: BindingScopeInvalidationReason,
  ) {
    db = new Kysely<BindingRegistryDatabase>({
      dialect: new BunSqliteDialect({ database: new Database(":memory:") }),
    });
    await migrateBindingRegistry(db, ":memory:");
    const registry = new SqliteBindingRegistry(db, { timer: new FakeTimer() });
    const created = await registry.ensureScope(IDENTITY);
    if (created.kind !== "ready") {
      throw new Error("expected a fresh scope");
    }
    await db
      .updateTable("slot_scopes")
      .set({
        state,
        invalidation_reason: reason,
        invalidating_at_ms: 1,
        invalidated_at_ms: state === "invalidated" ? 2 : null,
      })
      .where("scope_key", "=", created.scope.scopeKey)
      .execute();
    return { registry, scopeKey: created.scope.scopeKey };
  }

  test.each(["invalidating", "invalidated"] as const)(
    "revives a %s scope whose reason is abandoned",
    async (state) => {
      const { registry, scopeKey } = await openWithScopeInState(state, "abandoned");

      const result = await registry.ensureScope(IDENTITY);

      expect(result.kind).toBe("ready");
      if (result.kind === "ready") {
        expect(result.revived).toBe(true);
        expect(result.scope.state).toBe("valid");
      }
      expect((await registry.getScope(scopeKey))?.state).toBe("valid");
    },
  );

  test("still refuses a scope invalidated for any other reason", async () => {
    const { registry } = await openWithScopeInState("invalidated", "operator_reset");

    expect((await registry.ensureScope(IDENTITY)).kind).toBe("scope_invalidated");
  });
});
