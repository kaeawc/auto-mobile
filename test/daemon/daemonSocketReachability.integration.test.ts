import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonSocketReachability } from "../../src/daemon/client/daemonSocketReachability";
import { defaultTimer, type Timer } from "../../src/utils/SystemTimer";

// Real sockets, but skip the 50 ms absence-confirmation wait so the test stays well under budget.
const instantConfirmTimer: Timer = Object.assign(Object.create(defaultTimer), {
  sleep: async () => {},
});

(process.platform === "win32" ? describe.skip : describe)("real socket reachability", () => {
  let directory: string;
  let restricted: string | undefined;
  let server: Server | undefined;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "reachability-"));
  });

  afterEach(async () => {
    if (restricted) {
      chmodSync(restricted, 0o700);
      restricted = undefined;
    }
    if (server) {
      await new Promise<void>((resolve, reject) =>
        server!.close((error) => (error ? reject(error) : resolve())),
      );
      server = undefined;
    }
    rmSync(directory, { recursive: true, force: true });
  });

  test("a live socket answers", async () => {
    const path = join(directory, "live.sock");
    server = createServer((socket) => socket.destroy());
    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject);
      server!.listen(path, resolve);
    });
    const probe = new DaemonSocketReachability({ platform: "linux", existsSyncFn: existsSync });
    expect(await probe.probe(path, 20)).toBe("answered");
  });

  test("ENOENT confirms absence even when the existence check says present", async () => {
    const probe = new DaemonSocketReachability({
      platform: "linux",
      existsSyncFn: () => true,
      timer: instantConfirmTimer,
    });
    expect(await probe.probe(join(directory, "missing.sock"), 20)).toBe("absent");
  });

  (process.getuid?.() === 0 ? test.skip : test)("a permission-denied path is unknown", async () => {
    restricted = join(directory, "restricted");
    mkdirSync(restricted);
    chmodSync(restricted, 0o000);
    const probe = new DaemonSocketReachability({ platform: "linux", existsSyncFn: () => true });
    expect(await probe.probe(join(restricted, "socket"), 20)).toBe("unknown");
  });
});
