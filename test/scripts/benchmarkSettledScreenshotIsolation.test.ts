import { describe, expect, test } from "bun:test";
import { type AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import {
  assertPrivateBenchmarkLaunch,
  assertPrivateBenchmarkRunDir,
  buildLaunchSafety,
  buildPrivateBenchmarkLaunch,
  pickBenchmarkPort,
  stopPrivateDaemon,
  type BenchmarkLaunchOptions,
  type BenchmarkLaunchSafety,
  type BenchmarkPortServer,
  type BenchmarkStopChild,
  type BenchmarkStopSpawner,
} from "../../scripts/benchmarkSettledScreenshotIsolation";
import { buildBenchmarkChildEnv } from "../../scripts/benchmarkSettledScreenshotEnv";
import {
  runBenchmark,
  type BenchmarkDeps,
  type BenchmarkSignals,
} from "../../scripts/benchmark-settled-screenshot";
import { parseBenchmarkArgs } from "../../scripts/benchmarkSettledScreenshotReport";
import { FakeTimer } from "../fakes/FakeTimer";

const runDir = resolve("/tmp/am-bench-isolation");
const safety: BenchmarkLaunchSafety = {
  homeDir: resolve("/fake/home"),
  builtInResidentPaths: [
    "/tmp/auto-mobile-daemon-501.sock",
    "/tmp/auto-mobile-daemon-501.pid",
    "/tmp/auto-mobile-daemon-501.lock",
  ],
  effectiveDaemonPaths: [
    "/fake/scratch/gate-ns/d.sock",
    "/fake/scratch/gate-ns/d.pid",
    "/fake/scratch/gate-ns/d.lock",
  ],
};
function launchOptions(): BenchmarkLaunchOptions {
  return {
    serverPath: "/fake/server.js",
    env: buildBenchmarkChildEnv({}, runDir),
    runDir,
    port: 49152,
  };
}

class FakePortServer implements BenchmarkPortServer {
  bound: { host: string; port: number } | undefined;
  closed = 0;
  error: ((error: Error) => void) | undefined;
  assigned: AddressInfo | string | null | undefined = {
    address: "127.0.0.1",
    family: "IPv4",
    port: 49152,
  };
  bindError: Error | undefined;
  closeError: Error | undefined;
  once(_event: "error", handler: (error: Error) => void): this {
    this.error = handler;
    return this;
  }
  listen(options: { host: string; port: number }, handler: () => void): this {
    this.bound = options;
    if (this.bindError) {
      this.error?.(this.bindError);
    } else {
      handler();
    }
    return this;
  }
  address(): AddressInfo | string | null | undefined {
    return this.assigned;
  }
  close(handler: (error?: Error) => void): this {
    this.closed++;
    handler(this.closeError);
    return this;
  }
}

class FakeStopChild implements BenchmarkStopChild {
  errorHandler: ((error: Error) => void) | undefined;
  closeHandler: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined;
  unrefs = 0;
  once(event: "error", handler: (error: Error) => void): this;
  once(event: "close", handler: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  once(
    event: "error" | "close",
    handler:
      | ((error: Error) => void)
      | ((code: number | null, signal: NodeJS.Signals | null) => void),
  ): this {
    if (event === "error") {
      this.errorHandler = handler as (error: Error) => void;
    } else {
      this.closeHandler = handler as (code: number | null, signal: NodeJS.Signals | null) => void;
    }
    return this;
  }
  unref(): void {
    this.unrefs++;
  }
}

function stopHarness() {
  const timer = new FakeTimer();
  const child = new FakeStopChild();
  const launches: Array<{ command: string; args: string[]; env: Record<string, string> }> = [];
  const spawn: BenchmarkStopSpawner = (command, args, options) => {
    launches.push({ command, args, env: options.env });
    return child;
  };
  return { child, timer, launches, deps: { spawn, timer, safety } };
}

class FakeSignals implements BenchmarkSignals {
  handler: ((signal: "SIGINT" | "SIGTERM") => Promise<void>) | undefined;
  exits: number[] = [];
  unregistered = 0;
  onTerminate(handler: (signal: "SIGINT" | "SIGTERM") => Promise<void>): () => void {
    this.handler = handler;
    return () => {
      this.unregistered++;
    };
  }
  exit(code: 130 | 143): void {
    this.exits.push(code);
  }
  terminate(signal: "SIGINT" | "SIGTERM" = "SIGTERM"): Promise<void> {
    if (!this.handler) {
      throw new Error("No termination handler registered");
    }
    return this.handler(signal);
  }
}

function benchmarkHarness() {
  const signals = new FakeSignals();
  const events: string[] = [];
  const launches: BenchmarkLaunchOptions[] = [];
  const logs: string[] = [];
  let port = 49152;
  const deps: BenchmarkDeps = {
    safety,
    parentEnv: {
      AUTOMOBILE_DAEMON_SOCKET_PATH: "/tmp/auto-mobile-daemon-501.sock",
      AUTOMOBILE_DAEMON_PID_FILE_PATH: "/tmp/auto-mobile-daemon-501.pid",
      AUTOMOBILE_DAEMON_LOCK_FILE_PATH: "/tmp/auto-mobile-daemon-501.lock",
      AUTOMOBILE_DAEMON_LAUNCH_LOG_PATH: join(safety.homeDir, ".auto-mobile", "resident.log"),
      AUTOMOBILE_DAEMON_STRAY: "resident",
      AUTO_MOBILE_DAEMON_STRAY: "resident",
    },
    makeRunDir: () => `${runDir}-${port}`,
    removeRunDir: () => {
      events.push("remove");
    },
    serverExists: () => true,
    pickPort: async () => port++,
    now: () => 0,
    write: () => {},
    log: (message) => {
      logs.push(message);
    },
    signals,
    createClient: async (options) => {
      const launch = buildPrivateBenchmarkLaunch(options, "client", safety);
      expect(launch.args).toEqual([
        options.serverPath,
        "--port",
        String(options.port),
        "--strict-port",
      ]);
      expect(options.env.AUTOMOBILE_DAEMON_STRAY).toBeUndefined();
      expect(options.env.AUTOMOBILE_DAEMON_LAUNCH_LOG_PATH).toBeUndefined();
      launches.push(options);
      events.push("client");
      return {
        callTool: async () => ({ structuredContent: { success: true } }),
        close: async () => {
          events.push("close");
        },
      };
    },
    stopPrivateDaemon: async (options) => {
      const launch = buildPrivateBenchmarkLaunch(options, "stop", safety);
      expect(launch.args).toEqual([
        options.serverPath,
        "--daemon",
        "stop",
        "--port",
        String(options.port),
        "--strict-port",
      ]);
      launches.push(options);
      events.push("stop");
    },
  };
  return { deps, signals, events, launches, logs };
}
const options = () =>
  parseBenchmarkArgs(["--platform", "ios", "--iterations", "1", "--warmup", "0"]);

// A microtask-only deferred seam keeps setup/call races deterministic without real clocks.
function deferred<T>() {
  let resolveValue: (value: T) => void = () => {};
  const promise = new Promise<T>((resolvePromise) => {
    resolveValue = resolvePromise;
  });
  return { promise, resolve: resolveValue };
}

describe("ephemeral benchmark port probe", () => {
  test("returns the assigned port, binds daemon loopback port zero and closes", async () => {
    const server = new FakePortServer();
    expect(await pickBenchmarkPort(() => server)).toBe(49152);
    expect(server.bound).toEqual({ host: "127.0.0.1", port: 0 });
    expect(server.closed).toBe(1);
  });
  test("bind failure closes and explains how to retry", async () => {
    const server = new FakePortServer();
    server.bindError = new Error("permission denied");
    await expect(pickBenchmarkPort(() => server)).rejects.toThrow(
      "check loopback binding permissions and retry: permission denied",
    );
    expect(server.closed).toBe(1);
  });
  for (const address of [
    undefined,
    null,
    "unix.sock",
    { address: "127.0.0.1", family: "IPv4", port: 0 },
    { address: "127.0.0.1", family: "IPv4", port: 3005 },
  ]) {
    test(`rejects unusable address ${JSON.stringify(address)}`, async () => {
      const server = new FakePortServer();
      server.assigned = address;
      await expect(pickBenchmarkPort(() => server)).rejects.toThrow(
        "usable private benchmark port",
      );
      expect(server.closed).toBe(1);
    });
  }
  test("propagates probe close failure", async () => {
    const server = new FakePortServer();
    server.closeError = new Error("close broke");
    await expect(pickBenchmarkPort(() => server)).rejects.toThrow("close broke");
  });
});

describe("private namespace and argv guard", () => {
  test("fixed guard decisions survive configured and unset daemon path env maps", () => {
    const builtInPaths = [
      "/tmp/auto-mobile-daemon-501.sock",
      "/tmp/auto-mobile-daemon-501.pid",
      "/tmp/auto-mobile-daemon-501.lock",
    ] as const;
    const configuredEnv = {
      AUTOMOBILE_DAEMON_SOCKET_PATH: "/fake/scratch/gate-ns/d.sock",
      AUTOMOBILE_DAEMON_PID_FILE_PATH: "/fake/scratch/gate-ns/d.pid",
      AUTOMOBILE_DAEMON_LOCK_FILE_PATH: "/fake/scratch/gate-ns/d.lock",
    };
    const configured = buildLaunchSafety(configuredEnv, safety.homeDir, builtInPaths);
    const unset = buildLaunchSafety({}, safety.homeDir, builtInPaths);
    expect(configured).toEqual(safety);
    expect(unset.effectiveDaemonPaths).toEqual(builtInPaths);
    for (const guard of [safety, configured, unset]) {
      for (const directory of [
        "/fake/home/.auto-mobile",
        "/fake/home/.auto-mobile/bench",
        "/tmp/auto-mobile-daemon-501/bench",
        "/private/tmp/auto-mobile-daemon-501/bench",
        ...builtInPaths,
      ]) {
        expect(() => assertPrivateBenchmarkRunDir(directory, guard)).toThrow(
          "resident namespace path",
        );
      }
      for (const directory of [runDir, ...Object.values(configuredEnv)]) {
        expect(() => assertPrivateBenchmarkRunDir(directory, guard)).not.toThrow();
      }
      expect(() => buildPrivateBenchmarkLaunch(launchOptions(), "client", guard)).not.toThrow();
      for (const [index, key] of [
        "AUTOMOBILE_DAEMON_SOCKET_PATH",
        "AUTOMOBILE_DAEMON_PID_FILE_PATH",
        "AUTOMOBILE_DAEMON_LOCK_FILE_PATH",
      ].entries()) {
        const options = launchOptions();
        options.env[key] = builtInPaths[index];
        expect(() => buildPrivateBenchmarkLaunch(options, "client", guard)).toThrow(
          "Refusing benchmark child launch",
        );
      }
      // These exact private paths pass assertPrivateDaemonNamespace, exercising the
      // effective-path equality rule independently of its containment check.
      for (const effectivePath of guard.effectiveDaemonPaths) {
        if (builtInPaths.some((path) => path === effectivePath)) {
          continue;
        }
        const directory = "/fake/scratch/gate-ns";
        const options = {
          ...launchOptions(),
          runDir: directory,
          env: buildBenchmarkChildEnv({}, directory),
        };
        const equalityGuard = { ...guard, effectiveDaemonPaths: [effectivePath] };
        expect(() => buildPrivateBenchmarkLaunch(options, "client", equalityGuard)).toThrow(
          "resident namespace path",
        );
      }
    }
  });

  test("safety builder preserves daemon alias precedence and launch cwd resolution", () => {
    const builtInPaths = ["/fake/default.sock", "/fake/default.pid", "/fake/default.lock"] as const;
    const guard = buildLaunchSafety(
      {
        AUTOMOBILE_DAEMON_LAUNCH_CWD: "/fake/launch",
        AUTOMOBILE_DAEMON_SOCKET_PATH: "canonical.sock",
        AUTO_MOBILE_DAEMON_SOCKET_PATH: "ignored.sock",
        AUTO_MOBILE_DAEMON_PID_FILE_PATH: "alias.pid",
        AUTOMOBILE_DAEMON_LOCK_FILE_PATH: "",
        AUTO_MOBILE_DAEMON_LOCK_FILE_PATH: "ignored.lock",
      },
      "/fake/home",
      builtInPaths,
    );
    expect(guard.effectiveDaemonPaths).toEqual([
      resolve("/fake/launch", "canonical.sock"),
      resolve("/fake/launch", "alias.pid"),
      "/fake/default.lock",
    ]);
    expect(() => assertPrivateBenchmarkRunDir("/fake/default.lock", guard)).toThrow(
      "resident namespace path",
    );
  });
  test("derives guarded child args and private paths", () => {
    const options = launchOptions();
    const launch = buildPrivateBenchmarkLaunch(options, "client", safety);
    expect(launch.args).toEqual([options.serverPath, "--port", "49152", "--strict-port"]);
    expect(Object.values(launch.env).every((path) => path.startsWith(runDir))).toBe(true);
    expect(options.port).toBeGreaterThan(3010);
  });
  for (const [key, value] of [
    ["AUTOMOBILE_DAEMON_SOCKET_PATH", "/tmp/auto-mobile-daemon-501.sock"],
    ["AUTOMOBILE_DAEMON_PID_FILE_PATH", "/tmp/auto-mobile-daemon-501.pid"],
    ["AUTOMOBILE_DAEMON_LOCK_FILE_PATH", "/tmp/auto-mobile-daemon-501.lock"],
    ["AUTOMOBILE_DATA_DIR", join(safety.homeDir, ".auto-mobile")],
    ["AUTOMOBILE_DAEMON_STRAY", "parent-selector"],
    ["AUTOMOBILE_DAEMON_LAUNCH_LOG_PATH", join(safety.homeDir, ".auto-mobile", "resident.log")],
  ]) {
    test(`refuses ${key} before reaching spawner`, async () => {
      const fake = stopHarness();
      const options = launchOptions();
      options.env[key] = value;
      await expect(stopPrivateDaemon(options, fake.deps)).rejects.toThrow(
        "Refusing benchmark child launch",
      );
      expect(fake.launches).toEqual([]);
    });
  }
  for (const directory of [
    join(safety.homeDir, ".auto-mobile"),
    join(safety.homeDir, ".auto-mobile", "bench"),
    "/tmp/auto-mobile-daemon-501",
    "/tmp/auto-mobile-daemon-501/bench",
    "/private/tmp/auto-mobile-daemon-501",
    "/tmp/auto-mobile-daemon-501.sock",
    "/tmp/auto-mobile-daemon-501.pid",
    "/tmp/auto-mobile-daemon-501.lock",
  ]) {
    test(`refuses resident run directory ${directory}`, async () => {
      const fake = stopHarness();
      const options = launchOptions();
      options.runDir = directory;
      options.env = buildBenchmarkChildEnv({}, directory);
      await expect(stopPrivateDaemon(options, fake.deps)).rejects.toThrow(
        "resident namespace path",
      );
      expect(fake.launches).toEqual([]);
    });
  }
  for (const port of [3000, 3005, 3010, 0, 80, 70000, NaN, 49152.5]) {
    test(`refuses port ${port} before spawner`, async () => {
      const fake = stopHarness();
      await expect(stopPrivateDaemon({ ...launchOptions(), port }, fake.deps)).rejects.toThrow(
        "port must be",
      );
      expect(fake.launches).toEqual([]);
    });
  }
  for (const argv of [
    ["/fake/server.js", "--port", "49152"],
    ["/fake/server.js", "--port", "49153", "--strict-port"],
    ["/fake/server.js", "--port", "49152", "--strict-port", "--port", "49152"],
  ]) {
    test(`refuses client argv ${argv.join(" ")}`, () => {
      let launched = false;
      expect(() => {
        assertPrivateBenchmarkLaunch(launchOptions(), argv, "client", safety);
        launched = true;
      }).toThrow("expected");
      expect(launched).toBe(false);
    });
  }
  for (const command of ["restart", "start"]) {
    test(`refuses stop argv ${command}`, () => {
      let launched = false;
      expect(() => {
        assertPrivateBenchmarkLaunch(
          launchOptions(),
          ["/fake/server.js", "--daemon", command, "--port", "49152", "--strict-port"],
          "stop",
          safety,
        );
        launched = true;
      }).toThrow("expected");
      expect(launched).toBe(false);
    });
  }
  test("rejects injected default values even when exact private paths match", () => {
    const options = launchOptions();
    expect(() =>
      buildPrivateBenchmarkLaunch(options, "client", {
        ...safety,
        builtInResidentPaths: [join(runDir, "d.lock")],
      }),
    ).toThrow("resident namespace path");
  });
});

describe("stop own daemon with fake process and timer", () => {
  test("spawns exact stop argv/private env and clears timeout on success", async () => {
    const fake = stopHarness();
    const options = launchOptions();
    const stopping = stopPrivateDaemon(options, fake.deps);
    expect(fake.launches).toEqual([
      {
        command: process.execPath,
        args: [options.serverPath, "--daemon", "stop", "--port", "49152", "--strict-port"],
        env: options.env,
      },
    ]);
    expect(fake.timer.getPendingTimeouts()).toEqual([30000]);
    fake.child.closeHandler?.(0, null);
    await stopping;
    expect(fake.timer.getPendingTimeoutCount()).toBe(0);
    fake.timer.advanceTime(30000);
    expect(fake.child.unrefs).toBe(0);
  });
  test("times out without signalling and unrefs only its child", async () => {
    const fake = stopHarness();
    const stopping = stopPrivateDaemon(launchOptions(), fake.deps);
    fake.timer.advanceTime(30000);
    await expect(stopping).rejects.toThrow("timed out after 30000ms");
    expect(fake.child.unrefs).toBe(1);
  });
  test("spawn error clears timeout and preserves cause", async () => {
    const fake = stopHarness();
    const stopping = stopPrivateDaemon(launchOptions(), fake.deps);
    fake.child.errorHandler?.(new Error("spawn denied"));
    await expect(stopping).rejects.toThrow("spawn denied");
    expect(fake.timer.getPendingTimeoutCount()).toBe(0);
  });
  for (const [code, signal] of [
    [1, null],
    [null, "SIGTERM"],
  ] as const) {
    test(`nonzero stop ${signal ?? code} fails`, async () => {
      const fake = stopHarness();
      const stopping = stopPrivateDaemon(launchOptions(), fake.deps);
      fake.child.closeHandler?.(code, signal);
      await expect(stopping).rejects.toThrow(`exited with ${signal ?? code}`);
      expect(fake.timer.getPendingTimeoutCount()).toBe(0);
    });
  }
});

describe("benchmark lifecycle isolation and termination", () => {
  test("full fake run guards both launches using the identical port and private env", async () => {
    const fake = benchmarkHarness();
    await runBenchmark(options(), fake.deps);
    expect(fake.events).toEqual(["client", "close", "stop", "remove"]);
    expect(fake.launches[0]).toBe(fake.launches[1]);
    expect(fake.launches[0].port).toBe(49152);
    expect(fake.signals.unregistered).toBe(1);
  });
  test("concurrent fake runs get independent ports and namespaces", async () => {
    const fake = benchmarkHarness();
    delete fake.deps.signals;
    await Promise.all([runBenchmark(options(), fake.deps), runBenchmark(options(), fake.deps)]);
    const clients = fake.launches.slice(0, 2);
    expect(clients[0].port).not.toBe(clients[1].port);
    expect(clients[0].env.AUTOMOBILE_DAEMON_SOCKET_PATH).not.toBe(
      clients[1].env.AUTOMOBILE_DAEMON_SOCKET_PATH,
    );
    expect(fake.events.filter((event) => event === "stop")).toHaveLength(2);
  });
  for (const mode of ["port-failure", "invalid-port", "invalid-dir"] as const) {
    test(`${mode} never launches or stops a daemon`, async () => {
      const fake = benchmarkHarness();
      if (mode === "port-failure") {
        fake.deps.pickPort = async () => {
          throw new Error("port unavailable");
        };
      }
      if (mode === "invalid-port") {
        fake.deps.pickPort = async () => 3000;
      }
      if (mode === "invalid-dir") {
        fake.deps.makeRunDir = () => "/tmp/auto-mobile-daemon-501";
      }
      await expect(runBenchmark(options(), fake.deps)).rejects.toThrow();
      expect(fake.events).toEqual(mode === "invalid-dir" ? [] : ["remove"]);
      expect(fake.launches).toEqual([]);
    });
  }
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    test(`${signal} during a call cleans exactly once even if signalled twice`, async () => {
      const fake = benchmarkHarness();
      const entered = deferred<void>();
      const response = deferred<unknown>();
      fake.deps.createClient = async (launch) => {
        buildPrivateBenchmarkLaunch(launch, "client", safety);
        fake.events.push("client");
        return {
          callTool: async () => {
            entered.resolve();
            return response.promise;
          },
          close: async () => {
            fake.events.push("close");
          },
        };
      };
      const running = runBenchmark(options(), fake.deps);
      const result = running.then(
        () => undefined,
        (error: unknown) => error,
      );
      await entered.promise;
      await Promise.all([fake.signals.terminate(signal), fake.signals.terminate(signal)]);
      expect(fake.events).toEqual(["client", "close", "stop", "remove"]);
      expect(fake.signals.exits).toEqual([signal === "SIGINT" ? 130 : 143]);
      response.resolve({ structuredContent: { success: true } });
      expect(await result).toBeInstanceOf(Error);
      expect(String(await result)).toContain("terminated");
      expect(fake.events).toEqual(["client", "close", "stop", "remove"]);
      expect(fake.signals.unregistered).toBe(1);
    });
  }
  test("termination before port selection completes removes only the private dir, without stop", async () => {
    const fake = benchmarkHarness();
    const entered = deferred<void>();
    const picked = deferred<number>();
    fake.deps.pickPort = async () => {
      entered.resolve();
      return picked.promise;
    };
    const running = runBenchmark(options(), fake.deps);
    const result = running.then(
      () => undefined,
      (error: unknown) => error,
    );
    await entered.promise;
    const termination = fake.signals.terminate();
    picked.resolve(49152);
    await termination;
    expect(String(await result)).toContain("terminated");
    expect(fake.events).toEqual(["remove"]);
    expect(fake.launches).toEqual([]);
    expect(fake.signals.exits).toEqual([143]);
  });
  test("termination during connection waits for client then closes it once", async () => {
    const fake = benchmarkHarness();
    const entered = deferred<void>();
    const connected = deferred<void>();
    const create = fake.deps.createClient;
    fake.deps.createClient = async (launch) => {
      entered.resolve();
      await connected.promise;
      return create(launch);
    };
    const running = runBenchmark(options(), fake.deps);
    const result = running.then(
      () => undefined,
      (error: unknown) => error,
    );
    await entered.promise;
    const termination = fake.signals.terminate();
    expect(fake.events).toEqual([]);
    connected.resolve();
    await termination;
    expect(await result).toBeInstanceOf(Error);
    expect(String(await result)).toContain("terminated");
    expect(fake.events).toEqual(["client", "close", "stop", "remove"]);
  });
  test("termination stop failure retains namespace and exits once", async () => {
    const fake = benchmarkHarness();
    const entered = deferred<void>();
    const response = deferred<unknown>();
    fake.deps.createClient = async () => ({
      callTool: async () => {
        entered.resolve();
        return response.promise;
      },
      close: async () => {
        fake.events.push("close");
      },
    });
    fake.deps.stopPrivateDaemon = async () => {
      fake.events.push("stop");
      throw new Error("stop failed");
    };
    const running = runBenchmark(options(), fake.deps);
    const result = running.then(
      () => undefined,
      (error: unknown) => error,
    );
    await entered.promise;
    await fake.signals.terminate();
    await fake.signals.terminate();
    response.resolve({});
    expect(await result).toBeInstanceOf(Error);
    expect(String(await result)).toContain("terminated");
    expect(fake.events).toEqual(["close", "stop"]);
    expect(fake.logs.join("\n")).toContain("retaining");
    expect(fake.signals.exits).toEqual([143]);
  });
});
