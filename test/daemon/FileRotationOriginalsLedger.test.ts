import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { FileRotationOriginalsLedger } from "../../src/daemon/FileRotationOriginalsLedger";
import { CountingIdGenerator } from "../../src/utils/IdGenerator";
import { logger } from "../../src/utils/logger";
import { useScratchRoot } from "../helpers/scratchRoot";

const ORIGINALS = {
  accelerometerRotation: 1 as const,
  userRotation: 0,
  deviceStateRotationLock: "0:1:1:2:2:0",
  deviceStateRotationLockState: 2,
};

const scratch = useScratchRoot("rotation-originals-");
let directory: string;
beforeEach(() => {
  directory = path.join(scratch.next(), "rotation-originals");
});
afterEach(() => {
  spyOn(logger, "warn").mockRestore();
});

const ledger = () => new FileRotationOriginalsLedger(() => directory, new CountingIdGenerator());

test("a missing directory loads no records", async () => {
  expect((await ledger().loadAll()).size).toBe(0);
});

test("records survive a new ledger instance; the first save wins", async () => {
  expect(await ledger().save("emulator-5554", ORIGINALS)).toBe(true);
  expect(await ledger().save("emulator-5554", { accelerometerRotation: 0, userRotation: 1 })).toBe(
    false,
  );
  const loaded = await ledger().loadAll();
  expect([...loaded]).toEqual([["emulator-5554", ORIGINALS]]);
  // No temporary files are left behind.
  expect(readdirSync(directory)).toEqual(["emulator-5554.json"]);
});

test("device ids are encoded into safe file names", async () => {
  await ledger().save("192.168.0.2:5555", ORIGINALS);
  expect(readdirSync(directory)).toEqual([`${encodeURIComponent("192.168.0.2:5555")}.json`]);
  expect([...(await ledger().loadAll()).keys()]).toEqual(["192.168.0.2:5555"]);
});

test("clear removes only a record equal to the given state", async () => {
  await ledger().save("d1", ORIGINALS);
  await ledger().clear("d1", { ...ORIGINALS, userRotation: 3 });
  expect((await ledger().loadAll()).size).toBe(1);
  await ledger().clear("d1", { ...ORIGINALS });
  expect((await ledger().loadAll()).size).toBe(0);
  await ledger().clear("d1", ORIGINALS);
});

test("an unreadable record is logged and dropped", async () => {
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  await ledger().save("d1", ORIGINALS);
  writeFileSync(path.join(directory, "d2.json"), "{not json");
  const loaded = await ledger().loadAll();
  expect([...loaded.keys()]).toEqual(["d1"]);
  expect(String(warn.mock.calls[0]?.[0])).toContain("Dropping unreadable rotation originals");
  expect(readdirSync(directory)).toEqual(["d1.json"]);
});
