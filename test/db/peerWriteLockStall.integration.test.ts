import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

// The peer holds its write lock for at most half the app connection's retry
// budget, leaving Windows scheduling slack before app writes give up (#17902).
const HOLD_MS = 1500;

test("real peer write locks leave the event loop responsive", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      "scripts/db/peer-write-lock-stall-probe.ts",
      "--holds",
      String(HOLD_MS),
      "--max-stall-ms",
      "1000",
    ],
    {
      cwd: fileURLToPath(new URL("../../", import.meta.url)),
      stdout: "pipe",
      stderr: "pipe",
      // Bound the probe below the test timeout, even if its event loop hangs.
      timeout: 55_000,
      killSignal: "SIGKILL",
    },
  );
  const [output, errors, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  // Retain the measured cases in failing test output as well as the standalone probe.
  expect({ exitCode, output, errors }).toMatchObject({ exitCode: 0 });
  const [header, ...cases] = output
    .trim()
    .split("\n")
    .map((line: string) => JSON.parse(line));
  expect(header.budgets.maxStallMs).toBe(1000);
  expect(HOLD_MS * 2).toBeLessThanOrEqual(header.budgets.appRetryTotalWaitMs);
  expect(cases.map((row: { path: string }) => row.path)).toEqual([
    "app-db-session-upsert",
    "app-db-session-release",
    "app-db-transaction",
    "binding-registry-ensure-scope",
    "binding-registry-journal",
  ]);
  for (const row of cases) {
    expect(row.maxLoopStallMs).toBeLessThan(1000);
    if (row.path.startsWith("app-db-")) {
      // The whole row names the path and its elapsed time when an app write gives up.
      expect(row).toMatchObject({ path: row.path, outcome: "ok" });
    }
  }
}, 60_000);
