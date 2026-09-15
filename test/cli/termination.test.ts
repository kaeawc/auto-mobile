import { expect, test } from "bun:test";
import path from "node:path";
import { terminateCliProcess } from "../../src/cli/termination";
import { defaultTimer } from "../../src/utils/SystemTimer";

test("passes the requested code through the injectable executable terminator", () => {
  const exitCodes: number[] = [];

  terminateCliProcess({ exitCode: 1 }, { terminate: (exitCode) => exitCodes.push(exitCode) });

  expect(exitCodes).toEqual([1]);
});

test("exits promptly after a bounded repair result despite an active diagnostic handle", async () => {
  const child = Bun.spawn(
    [process.execPath, path.join(import.meta.dir, "../fixtures/cliBoundedTerminationChild.ts")],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  let timeout: NodeJS.Timeout | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timeout = defaultTimer.setTimeout(() => {
      child.kill();
      reject(new Error("bounded repair child did not exit within 1 second"));
    }, 1_000);
  });

  try {
    expect(await Promise.race([child.exited, timedOut])).toBe(1);
    const stdout = await new Response(child.stdout).text();
    expect(JSON.parse(stdout)).toEqual({ status: "failed", phase: "verification" });
  } finally {
    if (timeout !== undefined) {
      defaultTimer.clearTimeout(timeout);
    }
    child.kill();
  }
});
