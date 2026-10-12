import { expect, test } from "bun:test";
import {
  DatabaseHealthProbeTimeoutError,
  DefaultDatabaseHealthProbe,
} from "../../src/db/DatabaseHealthProbe";
import { FakeTimer } from "../fakes/FakeTimer";

test("deadline rejects with the typed timeout, duration and unchanged message", async () => {
  const timer = new FakeTimer();
  const probe = new DefaultDatabaseHealthProbe({
    timer,
    timeoutMs: 1234,
    getMigrationsError: () => null,
    executeSelectOne: () => new Promise(() => {}),
  });
  const result = probe.check();
  const rejection = result.then(
    () => null,
    (error: unknown) => error,
  );
  timer.advanceTime(1234);
  const error = await rejection;
  expect(error).toBeInstanceOf(DatabaseHealthProbeTimeoutError);
  expect(error).toMatchObject({
    timeoutMs: 1234,
    message: "Database health probe timed out after 1234ms",
  });
});

test("an executor rejection preserves its own error class and identity", async () => {
  class SqliteFailure extends Error {}
  const error = new SqliteFailure("database disk image is malformed");
  const probe = new DefaultDatabaseHealthProbe({
    timer: new FakeTimer(),
    getMigrationsError: () => null,
    executeSelectOne: () => Promise.reject(error),
  });
  await expect(probe.check()).rejects.toBe(error);
});
