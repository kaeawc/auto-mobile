import { afterEach, expect, spyOn, test } from "bun:test";
import { RotationOriginalsPersistence } from "../../src/daemon/rotationOriginalsPersistence";
import { logger } from "../../src/utils/logger";
import { FakeRotationOriginalsLedger } from "../fakes/FakeRotationOriginalsLedger";

const ORIGINALS = { accelerometerRotation: 1 as const, userRotation: 0 };
const OTHER = { accelerometerRotation: 0 as const, userRotation: 1 };

afterEach(() => {
  spyOn(logger, "warn").mockRestore();
});

test("preload turns an earlier daemon's records into orphans, each taken once", async () => {
  const ledger = new FakeRotationOriginalsLedger();
  ledger.records.set("d1", ORIGINALS);
  const persistence = new RotationOriginalsPersistence(ledger);
  expect(persistence.takeOrphan("d1")).toBeUndefined();
  await persistence.preload();
  await persistence.preload();
  expect(ledger.calls).toEqual(["loadAll"]);
  expect(persistence.takeOrphan("d1")).toEqual(ORIGINALS);
  expect(persistence.takeOrphan("d1")).toBeUndefined();
  expect(persistence.takeOrphan("d2")).toBeUndefined();
});

test("a record this daemon saved is never an orphan, even when preload reads it", async () => {
  const ledger = new FakeRotationOriginalsLedger();
  const persistence = new RotationOriginalsPersistence(ledger);
  await persistence.record("d1", ORIGINALS);
  await persistence.preload();
  expect(persistence.takeOrphan("d1")).toBeUndefined();
  expect(ledger.records.get("d1")).toEqual(ORIGINALS);
});

test("the oldest record wins and forget clears only a matching record", async () => {
  const ledger = new FakeRotationOriginalsLedger();
  const persistence = new RotationOriginalsPersistence(ledger);
  await persistence.record("d1", ORIGINALS);
  await persistence.record("d1", OTHER);
  expect(ledger.records.get("d1")).toEqual(ORIGINALS);
  await persistence.forget("d1", OTHER);
  expect(ledger.records.get("d1")).toEqual(ORIGINALS);
  await persistence.forget("d1", ORIGINALS);
  expect(ledger.records.has("d1")).toBe(false);
});

test("operations on one device run in call order", async () => {
  const ledger = new FakeRotationOriginalsLedger();
  const persistence = new RotationOriginalsPersistence(ledger);
  const save = persistence.record("d1", ORIGINALS);
  const clear = persistence.forget("d1", ORIGINALS);
  await Promise.all([save, clear]);
  expect(ledger.calls).toEqual(["save d1", "clear d1"]);
  expect(ledger.records.has("d1")).toBe(false);
});

test("ledger failures are logged with the error and never reject", async () => {
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  const ledger = new FakeRotationOriginalsLedger();
  const persistence = new RotationOriginalsPersistence(ledger);
  ledger.failNext = "loadAll";
  await persistence.preload();
  ledger.failNext = "save";
  await persistence.record("d1", ORIGINALS);
  ledger.failNext = "clear";
  await persistence.forget("d1", ORIGINALS);
  expect(warn.mock.calls.map(([message]) => String(message))).toEqual([
    expect.stringContaining("loadAll refused"),
    expect.stringContaining("Failed to save saved rotation originals for d1"),
    expect.stringContaining("Failed to clear saved rotation originals for d1"),
  ]);
  // A later save still runs after a failed one.
  await persistence.record("d1", ORIGINALS);
  expect(ledger.records.get("d1")).toEqual(ORIGINALS);
});
