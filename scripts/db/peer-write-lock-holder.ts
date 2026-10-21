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
  process.stdout.write("LOCKED\n");
  await Bun.sleep(holdMs);
  db.exec("COMMIT;");
  process.stdout.write("RELEASED\n");
} finally {
  db.close();
}
