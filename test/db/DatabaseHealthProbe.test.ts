import { describe, expect, test } from "bun:test";
import { DefaultDatabaseHealthProbe } from "../../src/db/DatabaseHealthProbe";
import { FakeTimer } from "../fakes/FakeTimer";

describe("DefaultDatabaseHealthProbe", () => {
  test("throws a cached migration error without issuing SELECT 1", async () => {
    const migrationError = new Error("startup migration failed");
    let selectCalls = 0;
    const probe = new DefaultDatabaseHealthProbe({
      getMigrationsError: () => migrationError,
      executeSelectOne: async () => {
        selectCalls += 1;
      },
    });

    await expect(probe.check()).rejects.toBe(migrationError);
    expect(selectCalls).toBe(0);
  });

  test("issues a lightweight SELECT 1 when migrations have no cached error", async () => {
    let selectCalls = 0;
    const probe = new DefaultDatabaseHealthProbe({
      getMigrationsError: () => null,
      executeSelectOne: async () => {
        selectCalls += 1;
      },
    });

    await probe.check();

    expect(selectCalls).toBe(1);
  });

  test("bounds a wedged SELECT 1 probe", async () => {
    const timer = new FakeTimer();
    const probe = new DefaultDatabaseHealthProbe({
      timer,
      getMigrationsError: () => null,
      executeSelectOne: () => new Promise(() => {}),
      timeoutMs: 25,
    });

    await expect(timer.resolvePromise(probe.check(), 25)).rejects.toThrow(
      "Database health probe timed out after 25ms"
    );
  });
});
