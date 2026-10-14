import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ChildProcess } from "node:child_process";
import { DefaultHostCommandExecutor } from "../../src/utils/HostCommandExecutor";
import { defaultTimer } from "../../src/utils/SystemTimer";
import { isProcessRunning } from "../../src/utils/processLiveness";
import {
  runAndroidCommand,
  AndroidCommandTerminatedError,
} from "../../src/utils/android-cmdline-tools/runAndroidCommand";
import { terminateColdBootProcess } from "../../src/devices/coldBootProcessTermination";
import { IOSCtrlProxyManager } from "../../src/ctrlProxy/IOSCtrlProxyManager";
import { IosCtrlProxyProcessClient } from "../../src/ctrlProxy/ios/IosCtrlProxyProcessClient";
import { WebpBinaryResolver } from "../../src/utils/image/webp/WebpBinaryResolver";
import { ActionableError } from "../../src/models/ActionableError";

const host = new DefaultHostCommandExecutor();
let dir: string;
function pidOf(child: ChildProcess): number {
  if (!child.pid) {
    throw new Error("Test child has no pid");
  }
  return child.pid;
}
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") {
      return false;
    }
    throw error;
  }
}
async function waitUntil(pred: () => boolean | Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!(await pred())) {
    if (Date.now() >= end) {
      throw new Error(`Predicate did not hold within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => defaultTimer.setTimeout(() => resolve(undefined), 10));
  }
}
async function cleanup(pids: number[]): Promise<void> {
  for (const pid of pids) {
    if (!isProcessRunning(pid)) {
      continue;
    }
    try {
      process.kill(pid, "SIGKILL");
    } catch (error) {
      // An owned child can exit between the liveness probe and signal.
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
        throw error;
      }
    }
  }
  await waitUntil(() => pids.every((pid) => !isProcessRunning(pid)));
}
async function parentPid(pid: number): Promise<number> {
  return Number(
    (await host.executeCommand("ps", ["-o", "ppid=", "-p", String(pid)])).stdout.trim(),
  );
}
function readPid(file: string): number {
  const pid = Number(readFileSync(file, "utf8").trim());
  if (!Number.isInteger(pid) || pid <= 1) {
    throw new Error(`Invalid owned pid in ${file}`);
  }
  return pid;
}

class RestrictedStartupClient extends IosCtrlProxyProcessClient {
  discovered: number[] = [];
  constructor(private readonly owned: Set<number>) {
    super(host, defaultTimer);
  }
  override async findStartupCandidatePids(deadline?: number): Promise<number[]> {
    this.discovered = await super.findStartupCandidatePids(deadline);
    return this.discovered.filter((pid) => this.owned.has(pid));
  }
}

describe.skipIf(process.platform === "win32")("request-owned native descendants", () => {
  beforeAll(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "automobile-native-descendants-"));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("one-shot leaf cancellation removes its sleep child", async () => {
    const controller = new AbortController();
    const { child, result } = host.executeCommandWithChild("sleep", ["30"], {
      signal: controller.signal,
    });
    const rejected = result.catch((error) => error);
    try {
      controller.abort();
      expect(await rejected).toBeInstanceOf(Error);
      await waitUntil(() => !isAlive(pidOf(child)));
    } finally {
      await cleanup([pidOf(child)]);
    }
  });

  test("one-shot cancellation leaves a forked grandchild running (direct-child kill only)", async () => {
    const file = path.join(dir, "gc.pid");
    const controller = new AbortController();
    const { child, result } = host.executeCommandWithChild(
      "/bin/sh",
      ["-c", `sleep 30 & echo $! > '${file}'; wait`],
      { signal: controller.signal },
    );
    const rejected = result.catch((error) => error);
    let grandchild: number | undefined;
    try {
      await waitUntil(() => existsSync(file) && readFileSync(file, "utf8").trim().length > 0);
      grandchild = readPid(file);
      controller.abort();
      expect(await rejected).toBeInstanceOf(Error);
      await waitUntil(() => !isAlive(pidOf(child)));
      expect(isAlive(grandchild)).toBe(true);
    } finally {
      if (!grandchild && existsSync(file)) {
        grandchild = readPid(file);
      }
      await cleanup([pidOf(child), ...(grandchild ? [grandchild] : [])]);
    }
  });

  for (const ignoresTerm of [false, true]) {
    test(`sdkmanager cancellation ${ignoresTerm ? "escalates for a TERM-ignoring shell" : "removes its sleep child"}`, async () => {
      const controller = new AbortController();
      let child: ChildProcess | undefined;
      const ready = path.join(dir, "term-ready");
      const result = runAndroidCommand(
        {
          timer: defaultTimer,
          spawn: (c, a, o) => {
            child = host.spawn(c, a, o);
            return child;
          },
        },
        {
          command: ignoresTerm ? "/bin/sh" : "sleep",
          // Record each short-lived grandchild for cleanup, including on assertion failure.
          args: ignoresTerm
            ? [
                "-c",
                `trap "" TERM; echo ready > '${ready}'; while :; do sleep 0.05 & echo $! >> '${dir}/term-children'; wait; done`,
              ]
            : ["30"],
          signal: controller.signal,
          timeoutMs: 2500,
          terminationGraceMs: 150,
          maxStdoutChars: 1000,
          maxStderrChars: 1000,
          name: "sdkmanager",
          spawnErrorPrefix: "fake: ",
          onStart: () => {},
        },
      ).catch((error) => error);
      try {
        if (ignoresTerm) {
          await waitUntil(() => existsSync(ready));
        }
        controller.abort();
        const error = await result;
        expect(error).toBeInstanceOf(AndroidCommandTerminatedError);
        expect(error.reason).toBe("cancelled");
        await waitUntil(() => !isAlive(pidOf(child!)));
      } finally {
        const file = path.join(dir, "term-children");
        const descendants = existsSync(file)
          ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(Number)
          : [];
        await cleanup([...(child ? [pidOf(child)] : []), ...descendants]);
      }
    });
  }

  test("cancelled cold boot confirms its sleep child is gone", async () => {
    const child = host.spawn("sleep", ["30"]);
    try {
      expect(await terminateColdBootProcess(child, "harmless sleep", defaultTimer).confirmed).toBe(
        true,
      );
      expect(isAlive(pidOf(child))).toBe(false);
    } finally {
      await cleanup([pidOf(child)]);
    }
  });

  test("daemon SIGKILL leaves sleep running while stdin EOF terminates cat", async () => {
    const file = path.join(dir, "daemon-pids.json");
    const script = path.join(dir, "fake-daemon.ts");
    writeFileSync(
      script,
      `import { DefaultHostCommandExecutor } from ${JSON.stringify(path.resolve("src/utils/HostCommandExecutor.ts"))};
import { writeFileSync } from "node:fs";
const host = new DefaultHostCommandExecutor();
const sleep = host.spawn("sleep", ["30"], { stdio: ["ignore", "pipe", "pipe"] });
const cat = host.spawn("cat", [], { stdio: ["pipe", "pipe", "pipe"] });
writeFileSync(${JSON.stringify(file)}, JSON.stringify({ sleep: sleep.pid, cat: cat.pid }));
setInterval(() => {}, 1000);
`,
    );
    const daemon = host.spawn(process.execPath, [script], { stdio: "ignore" });
    let children: { sleep: number; cat: number } | undefined;
    try {
      await waitUntil(() => existsSync(file));
      children = JSON.parse(readFileSync(file, "utf8"));
      expect(isAlive(children!.cat)).toBe(true);
      daemon.kill("SIGKILL");
      await waitUntil(() => !isAlive(pidOf(daemon)) && !isAlive(children!.cat));
      expect(isAlive(children!.sleep)).toBe(true);
      const ppid = await parentPid(children!.sleep);
      expect(ppid).not.toBe(pidOf(daemon));
      if (process.platform === "darwin") {
        expect(ppid).toBe(1);
      }
    } finally {
      if (!children && existsSync(file)) {
        children = JSON.parse(readFileSync(file, "utf8"));
      }
      await cleanup([pidOf(daemon), ...(children ? [children.sleep, children.cat] : [])]);
    }
  });

  test.skipIf(process.platform !== "darwin")(
    "startup sweep reaps only the orphaned daemon-shaped runner tree",
    async () => {
      const owned = new Set<number>();
      const orphanFile = path.join(dir, "orphan.pid");
      const sleepFile = path.join(dir, "runner-sleep.pid");
      const shape = `sleep 30 & echo $! > '${sleepFile}'; wait; : xcodebuild test-without-building -xctestrun /nonexistent/automobile-12060.xctestrun -destination 'platform=iOS Simulator,id=AUTOMOBILE-12060-FAKE' -only-testing:CtrlProxyUITests/CtrlProxyUITests/testRunService`;
      const outer = host.spawn(
        "/bin/sh",
        [
          "-c",
          `/bin/sh -c ${"'" + shape.replaceAll("'", "'\\''") + "'"} & echo $! > '${orphanFile}'`,
        ],
        { stdio: "ignore" },
      );
      owned.add(pidOf(outer));
      let counter: ChildProcess | undefined;
      const counterFile = path.join(dir, "counter-sleep.pid");
      try {
        await waitUntil(() => existsSync(orphanFile) && existsSync(sleepFile));
        const orphan = readPid(orphanFile);
        owned.add(orphan);
        owned.add(readPid(sleepFile));
        await waitUntil(async () => (await parentPid(orphan)) === 1);
        counter = host.spawn("/bin/sh", ["-c", shape.replace(sleepFile, counterFile)], {
          stdio: "ignore",
        });
        owned.add(pidOf(counter));
        await waitUntil(() => existsSync(counterFile));
        owned.add(readPid(counterFile));
        expect(await parentPid(pidOf(counter))).not.toBe(1);
        const client = new RestrictedStartupClient(owned);
        await IOSCtrlProxyManager.reapOrphanedRunnerProcessesOnStartup(client, defaultTimer);
        expect(client.discovered).toContain(orphan);
        expect(client.discovered).toContain(pidOf(counter));
        await waitUntil(() => !isAlive(orphan) && !isAlive(readPid(sleepFile)));
        expect(isAlive(pidOf(counter))).toBe(true);
        expect(isAlive(readPid(counterFile))).toBe(true);
      } finally {
        for (const file of [orphanFile, sleepFile, counterFile]) {
          if (existsSync(file)) {
            owned.add(readPid(file));
          }
        }
        await cleanup([...owned]);
      }
    },
  );

  test("cwebp deadline kills the fake command path child", async () => {
    const script = path.join(dir, "cwebp");
    writeFileSync(script, "#!/bin/sh\nexec sleep 30\n", { mode: 0o755 });
    let child: ChildProcess | undefined;
    const executor = new DefaultHostCommandExecutor();
    const originalSpawn = executor.spawn.bind(executor);
    executor.spawn = (c, a, o) => {
      child = originalSpawn(c, a, o);
      return child;
    };
    const resolver = new WebpBinaryResolver({
      env: { AUTOMOBILE_CWEBP_PATH: script },
      processExecutor: executor,
      codecTimeoutMs: 200,
    });
    let watchdog: NodeJS.Timeout | undefined;
    try {
      const result = await Promise.race([
        resolver.runCwebp([], Buffer.from("x")).catch((error) => error),
        new Promise((resolve) => {
          watchdog = defaultTimer.setTimeout(
            () => resolve(new Error("Codec still pending after 700ms")),
            700,
          );
        }),
      ]);
      expect(result).toBeInstanceOf(ActionableError);
      expect((result as Error).message).toContain("200ms");
      await waitUntil(() => !!child && !isAlive(pidOf(child)));
    } finally {
      if (watchdog) {
        defaultTimer.clearTimeout(watchdog);
      }
      if (child) {
        await cleanup([pidOf(child)]);
      }
    }
  });
});
