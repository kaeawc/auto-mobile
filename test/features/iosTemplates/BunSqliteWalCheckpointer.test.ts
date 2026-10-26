import { beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { copyFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { useScratchRoot } from "../../helpers/scratchRoot";
import { BunSqliteWalCheckpointer } from "../../../src/features/iosTemplates/BunSqliteWalCheckpointer";

let dir: string;
const scratch = useScratchRoot("wal-checkpoint-");
beforeEach(() => {
  dir = scratch.next();
});

test("folds a non-empty WAL into its database and truncates the log", async () => {
  const source = join(dir, "source");
  const copy = join(dir, "copy.sqlite");
  const live = new Database(join(source + ".sqlite"), { create: true });
  live.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;");
  live.exec(
    "CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('E63A5A84-4C3D-4635-9BB6-9EEA7ABBDE77');",
  );
  // Snapshot the files while the writer is open, as a clone sees a template left with a live log.
  copyFileSync(source + ".sqlite", copy);
  copyFileSync(source + ".sqlite-wal", copy + "-wal");
  live.close();
  expect(statSync(copy + "-wal").size).toBeGreaterThan(0);

  await new BunSqliteWalCheckpointer().checkpoint(copy);

  expect(statSync(copy + "-wal").size).toBe(0);
  expect(readFirstValue(copy)).toBe("E63A5A84-4C3D-4635-9BB6-9EEA7ABBDE77");
});

test("a file that is not a database is reported", async () => {
  const path = join(dir, "bad.sqlite");
  writeFileSync(path, "x".repeat(4096));
  await expect(new BunSqliteWalCheckpointer().checkpoint(path)).rejects.toThrow();
});

test("a missing database is not created", async () => {
  await expect(
    new BunSqliteWalCheckpointer().checkpoint(join(dir, "none.sqlite")),
  ).rejects.toThrow();
});

function readFirstValue(path: string): string | undefined {
  const database = new Database(path, { readonly: true });
  try {
    return database.query<{ v: string }, []>("SELECT v FROM t").get()?.v;
  } finally {
    database.close();
  }
}
