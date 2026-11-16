import { Database } from "bun:sqlite";

const [dbPath, hold] = process.argv.slice(2);
const holdMs = Number(hold);
if (!dbPath || !Number.isSafeInteger(holdMs) || holdMs <= 0) {
  throw new Error("Usage: peer-write-lock-holder.ts <dbPath> <positive holdMs>");
}

const db = new Database(dbPath);
try {
  db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;");
  db.exec("CREATE TABLE IF NOT EXISTS peer_probe (value INTEGER);");
  db.exec("BEGIN IMMEDIATE; INSERT INTO peer_probe VALUES (1);");
  // Wall-clock lock time, so the probe measures the hold from the peer's own clock (#17902).
  process.stdout.write(`LOCKED ${Date.now()}\n`);
  await Bun.sleep(holdMs);
  db.exec("COMMIT;");
  // Wall-clock release time, so the probe can tell a late peer from a stuck app write.
  process.stdout.write(`RELEASED ${Date.now()}\n`);
} finally {
  db.close();
}
