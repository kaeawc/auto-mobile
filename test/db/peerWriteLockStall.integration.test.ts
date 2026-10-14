import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

test("real peer write locks leave the event loop responsive", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      "scripts/db/peer-write-lock-stall-probe.ts",
      "--holds",
      "1500",
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
  expect(cases.map((row: { path: string }) => row.path)).toEqual([
    "app-db-session-upsert",
    "app-db-session-release",
    "app-db-transaction",
    "slot-registry-ensure-scope",
    "slot-registry-journal",
  ]);
  for (const row of cases) {
    expect(row.maxLoopStallMs).toBeLessThan(1000);
    if (row.path.startsWith("app-db-")) {
      expect(row.outcome).toBe("ok");
    }
  }
}, 60_000);
