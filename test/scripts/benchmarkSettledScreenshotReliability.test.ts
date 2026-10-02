import { describe, expect, test } from "bun:test";
import { isAbsolute, join, posix, relative, resolve, win32 } from "node:path";
import { type BenchmarkLaunchSafety } from "../../scripts/benchmarkSettledScreenshotIsolation";

import { runBenchmark, type BenchmarkDeps } from "../../scripts/benchmark-settled-screenshot";
import {
  assertPrivateDaemonNamespace,
  assertServerBuilt,
  buildBenchmarkChildEnv,
  type BenchmarkChildEnv,
} from "../../scripts/benchmarkSettledScreenshotEnv";
import {
  aggregateFailureReasons,
  benchmarkExitCode,
  calculateMetrics,
  describeFailure,
  formatReportJson,
  formatReportTable,
  helpText,
  isInvalidSeries,
  parseBenchmarkArgs,
  settledAsyncDelta,
  type BenchmarkReport,
} from "../../scripts/benchmarkSettledScreenshotReport";

const safety: BenchmarkLaunchSafety = {
  homeDir: "/fake/home",
  builtInResidentPaths: [
    "/tmp/auto-mobile-daemon-501.sock",
    "/tmp/auto-mobile-daemon-501.pid",
    "/tmp/auto-mobile-daemon-501.lock",
  ],
  effectiveDaemonPaths: ["/fake/scratch/d.sock", "/fake/scratch/d.pid", "/fake/scratch/d.lock"],
};

const runDir = resolve("/tmp/am-bench-fake");
const expectedPaths: Record<string, string> = {
  AUTOMOBILE_DAEMON_SOCKET_PATH: join(runDir, "d.sock"),
  AUTOMOBILE_DAEMON_PID_FILE_PATH: join(runDir, "d.pid"),
  AUTOMOBILE_DAEMON_LOCK_FILE_PATH: join(runDir, "d.lock"),
  AUTOMOBILE_AUX_SOCKET_DIR: runDir,
  AUTOMOBILE_WEBRTC_STREAM_SOCKET_PATH: join(runDir, "w.sock"),
  AUTOMOBILE_DATA_DIR: join(runDir, "data"),
  AUTOMOBILE_LOG_DIR: join(runDir, "logs"),
  AUTOMOBILE_DB_PATH: join(runDir, "auto-mobile.db"),
  AUTOMOBILE_DAEMON_LAUNCH_CWD: runDir,
};
const success = { structuredContent: { success: true, observation: { platform: "ios" } } };
const options = () =>
  parseBenchmarkArgs([
    "--platform",
    "ios",
    "--iterations",
    "2",
    "--warmup",
    "1",
    "--server",
    "/fake/server.js",
  ]);

function harness(
  respond: (name: string, args: Record<string, unknown>, index: number) => unknown = () => success,
) {
  const events: string[] = [];
  const logs: string[] = [];
  const envs: BenchmarkChildEnv[] = [];
  let calls = 0;
  let clock = 0;
  let dirs = 0;
  const deps: BenchmarkDeps = {
    safety,
    serverExists: () => true,
    pickPort: async () => 49152,
    parentEnv: { PATH: "/fake/bin", AUTOMOBILE_COORDINATION_DIR: "/fake/shared" },
    makeRunDir: () => {
      events.push("make");
      dirs += 1;
      return `${runDir}-${dirs}`;
    },
    createClient: async ({ serverPath: server, env }) => {
      expect(server).toBe(resolve("/fake/server.js"));
      assertPrivateDaemonNamespace(env, `${runDir}-${dirs}`);
      events.push("create");
      envs.push(env);
      return {
        callTool: async (name, args) => {
          calls += 1;
          return respond(name, args, calls);
        },
        close: async () => {
          events.push("close");
        },
      };
    },
    stopPrivateDaemon: async ({ serverPath: server, env }) => {
      expect(server).toBe(resolve("/fake/server.js"));
      assertPrivateDaemonNamespace(env, `${runDir}-${dirs}`);
      expect(env).toBe(envs.at(-1));
      events.push("stop");
    },
    removeRunDir: (dir) => {
      expect(dir).toBe(`${runDir}-${dirs}`);
      events.push("remove");
    },
    now: () => clock++,
    log: (message) => {
      logs.push(message);
    },
    write: () => {},
  };
  return { deps, events, logs, envs, calls: () => calls };
}

function reportWith(metric: ReturnType<typeof calculateMetrics>): BenchmarkReport {
  return {
    platform: "ios",
    iterations: metric.sampleSize,
    warmup: 0,
    generatedAt: "2026-10-02T00:00:00.000Z",
    actionMode: "ambient default, not mode-controlled",
    results: { observe: { settled: metric } },
    settledVsAsync: {},
  };
}

describe("benchmark namespace isolation", () => {
  test("replaces resident and stray selectors without mutating the parent", () => {
    const parent: BenchmarkChildEnv = {
      PATH: "/fake/bin",
      ANDROID_HOME: "/fake/android",
      AUTOMOBILE_COORDINATION_DIR: "/fake/coordination",
      AUTOMOBILE_DAEMON_SOCKET_PATH: "/tmp/auto-mobile-daemon-501.sock",
      AUTOMOBILE_DAEMON_PID_FILE_PATH: "/tmp/auto-mobile-daemon-501.pid",
      AUTOMOBILE_DAEMON_LOCK_FILE_PATH: "/tmp/auto-mobile-daemon-501.lock",
      AUTOMOBILE_AUX_SOCKET_DIR: "~/.auto-mobile",
      AUTOMOBILE_DATA_DIR: "~/.auto-mobile",
      AUTOMOBILE_LOG_DIR: "~/.auto-mobile/logs",
      AUTOMOBILE_DB_PATH: "~/.auto-mobile/auto-mobile.db",
      AUTOMOBILE_DB_DIR: "/stray/db",
      AUTOMOBILE_WEBRTC_STREAM_SOCKET_PATH: "/stray/webrtc.sock",
      AUTOMOBILE_DAEMON_LAUNCH_CWD: "/stray/cwd",
    };
    for (const key of [...Object.keys(expectedPaths), "AUTOMOBILE_DB_DIR"]) {
      parent[key.replace("AUTOMOBILE_", "AUTO_MOBILE_")] = "/stray/alias";
    }
    const before = { ...parent };
    const env = buildBenchmarkChildEnv(parent, runDir);
    expect(env).toMatchObject(expectedPaths);
    expect(env.PATH).toBe(parent.PATH);
    expect(env.ANDROID_HOME).toBe(parent.ANDROID_HOME);
    expect(env.AUTOMOBILE_COORDINATION_DIR).toBe(parent.AUTOMOBILE_COORDINATION_DIR);
    expect(Object.keys(env).some((key) => key.startsWith("AUTO_MOBILE_"))).toBe(false);
    expect(Object.hasOwn(env, "AUTOMOBILE_DB_DIR")).toBe(false);
    expect(parent).toEqual(before);
    expect(env).not.toBe(parent);
    expect(() => assertPrivateDaemonNamespace(env, runDir)).not.toThrow();
    expect(buildBenchmarkChildEnv({}, runDir)).toEqual(expectedPaths);
  });

  test("every daemon path stays inside the run dir and replaces resident paths", () => {
    const directory = resolve("/fake/tmp/am-bench-ABC123");
    const residentDir = join(safety.homeDir, ".auto-mobile");
    const parent: BenchmarkChildEnv = {
      AUTOMOBILE_COORDINATION_DIR: resolve("/fake/resident/coordination"),
    };
    for (const key of Object.keys(expectedPaths)) {
      parent[key] = join(residentDir, key);
    }
    parent.AUTOMOBILE_DAEMON_SOCKET_PATH = "/tmp/auto-mobile-daemon-501.sock";
    parent.AUTOMOBILE_DAEMON_PID_FILE_PATH = "/tmp/auto-mobile-daemon-501.pid";
    parent.AUTOMOBILE_DAEMON_LOCK_FILE_PATH = "/tmp/auto-mobile-daemon-501.lock";
    parent.AUTOMOBILE_AUX_SOCKET_DIR = parent.AUTOMOBILE_COORDINATION_DIR;
    for (const env of [
      buildBenchmarkChildEnv({}, directory),
      buildBenchmarkChildEnv(parent, directory),
    ]) {
      for (const key of Object.keys(expectedPaths)) {
        const value = env[key];
        expect(value).toBeDefined();
        if (value === undefined) {
          throw new Error(`Missing daemon path: ${key}`);
        }
        const withinRun = relative(directory, value);
        expect(withinRun.startsWith("..")).toBe(false);
        expect(isAbsolute(withinRun)).toBe(false);
        const withinResident = relative(residentDir, value);
        expect(withinResident.startsWith("..") || isAbsolute(withinResident)).toBe(true);
        expect(value.startsWith(resolve("/tmp/auto-mobile-daemon-"))).toBe(false);
        expect(value).not.toBe(parent[key]);
        expect(value).not.toBe(parent.AUTOMOBILE_COORDINATION_DIR);
      }
    }
  });

  for (const count of [2, 3]) {
    test(`${count} concurrent namespaces have no equal or nested daemon paths`, () => {
      const environments = ["ABC123", "DEF456", "GHI789"]
        .slice(0, count)
        .map((suffix) => buildBenchmarkChildEnv({}, resolve(`/fake/tmp/am-bench-${suffix}`)));
      for (const [index, env] of environments.entries()) {
        for (const other of environments.slice(index + 1)) {
          for (const key of Object.keys(expectedPaths)) {
            for (const otherKey of Object.keys(expectedPaths)) {
              const value = env[key];
              const otherValue = other[otherKey];
              if (value === undefined || otherValue === undefined) {
                throw new Error(`Missing daemon paths: ${key}, ${otherKey}`);
              }
              expect(value).not.toBe(otherValue);
              for (const displacement of [
                relative(value, otherValue),
                relative(otherValue, value),
              ]) {
                expect(displacement.startsWith("..") || isAbsolute(displacement)).toBe(true);
              }
            }
          }
        }
      }
    });
  }

  test("sockets must fit, including auxiliary sockets", () => {
    expect(() => buildBenchmarkChildEnv({}, join(runDir, "a".repeat(80)))).toThrow(
      "shorter than 100 bytes",
    );
    expect(() => buildBenchmarkChildEnv({}, join(runDir, "é".repeat(40)))).toThrow(
      "shorter than 100 bytes",
    );
    expect(() => buildBenchmarkChildEnv({}, "relative")).toThrow("absolute");
    expect(() => buildBenchmarkChildEnv({}, resolve("/"))).toThrow("non-root");
  });

  test("namespace assertion rejects every missing, escaped or resident selector and legacy alias", () => {
    const env = buildBenchmarkChildEnv({}, runDir);
    for (const key of Object.keys(expectedPaths)) {
      const missing = { ...env };
      delete missing[key];
      expect(() => assertPrivateDaemonNamespace(missing, runDir)).toThrow(key);
      expect(() =>
        assertPrivateDaemonNamespace({ ...env, [key]: "/tmp/auto-mobile-daemon-501.sock" }, runDir),
      ).toThrow(key);
      expect(() =>
        assertPrivateDaemonNamespace({ ...env, [key]: resolve(runDir, "..", "resident") }, runDir),
      ).toThrow(key);
      const alias = key.replace("AUTOMOBILE_", "AUTO_MOBILE_");
      expect(() => assertPrivateDaemonNamespace({ ...env, [alias]: "" }, runDir)).toThrow(alias);
    }
    for (const key of ["AUTOMOBILE_DB_DIR", "AUTO_MOBILE_DB_DIR"]) {
      expect(() => assertPrivateDaemonNamespace({ ...env, [key]: undefined }, runDir)).toThrow(key);
    }
  });
});

describe("benchmark path flavours", () => {
  for (const { name, flavour, directory, root, wrongFlavour } of [
    {
      name: "posix",
      flavour: posix,
      directory: "/tmp/am-bench-fake",
      root: "/",
      wrongFlavour: "C:\\Temp\\am-bench-fake",
    },
    {
      name: "win32",
      flavour: win32,
      directory: "C:\\Temp\\am-bench-fake",
      root: "C:\\",
      wrongFlavour: "tmp/am-bench-fake",
    },
  ]) {
    test(`${name} builds and validates exact private selectors`, () => {
      const env = buildBenchmarkChildEnv({}, directory, flavour);
      expect(env).toEqual({
        AUTOMOBILE_DAEMON_SOCKET_PATH: flavour.join(directory, "d.sock"),
        AUTOMOBILE_DAEMON_PID_FILE_PATH: flavour.join(directory, "d.pid"),
        AUTOMOBILE_DAEMON_LOCK_FILE_PATH: flavour.join(directory, "d.lock"),
        AUTOMOBILE_AUX_SOCKET_DIR: directory,
        AUTOMOBILE_WEBRTC_STREAM_SOCKET_PATH: flavour.join(directory, "w.sock"),
        AUTOMOBILE_DATA_DIR: flavour.join(directory, "data"),
        AUTOMOBILE_LOG_DIR: flavour.join(directory, "logs"),
        AUTOMOBILE_DB_PATH: flavour.join(directory, "auto-mobile.db"),
        AUTOMOBILE_DAEMON_LAUNCH_CWD: directory,
      });
      expect(() => assertPrivateDaemonNamespace(env, directory, flavour)).not.toThrow();
    });

    test(`${name} rejects relative or wrong-flavour directories and roots`, () => {
      for (const invalid of ["relative", wrongFlavour]) {
        expect(() => buildBenchmarkChildEnv({}, invalid, flavour)).toThrow("absolute");
        expect(() => assertPrivateDaemonNamespace({}, invalid, flavour)).toThrow("absolute");
      }
      expect(() => buildBenchmarkChildEnv({}, root, flavour)).toThrow("non-root");
      expect(() => assertPrivateDaemonNamespace({}, root, flavour)).toThrow("non-root");
    });

    test(`${name} enforces the observation-stream socket UTF-8 byte boundary`, () => {
      const basename = "observation-stream.sock";
      const padding = 99 - Buffer.byteLength(flavour.join(directory, basename), "utf8");
      // Multibyte padding proves this is a byte limit, not a character limit.
      const at99 = directory + "é".repeat(Math.floor(padding / 2)) + "a".repeat(padding % 2);
      const at100 = at99 + "a";
      expect(Buffer.byteLength(flavour.join(at99, basename), "utf8")).toBe(99);
      expect(Buffer.byteLength(flavour.join(at100, basename), "utf8")).toBe(100);
      expect(Buffer.byteLength(flavour.join(at100, "d.sock"), "utf8")).toBeLessThan(100);
      const env = buildBenchmarkChildEnv({}, at99, flavour);
      expect(() => assertPrivateDaemonNamespace(env, at99, flavour)).not.toThrow();
      expect(() => buildBenchmarkChildEnv({}, at100, flavour)).toThrow("shorter than 100 bytes");
      expect(() => assertPrivateDaemonNamespace({}, at100, flavour)).toThrow(
        "shorter than 100 bytes",
      );
    });
  }
});

describe("benchmark injectable lifecycle", () => {
  test("passes a private env and stops before removal in distinct runs", async () => {
    const fake = harness();
    await runBenchmark(options(), fake.deps);
    await runBenchmark(options(), fake.deps);
    expect(fake.events).toEqual([
      "make",
      "create",
      "close",
      "stop",
      "remove",
      "make",
      "create",
      "close",
      "stop",
      "remove",
    ]);
    expect(fake.envs[0].AUTOMOBILE_DAEMON_SOCKET_PATH).not.toBe(
      fake.envs[1].AUTOMOBILE_DAEMON_SOCKET_PATH,
    );
  });

  test("missing build fails before directory or client side effects", async () => {
    const fake = harness();
    fake.deps.serverExists = () => false;
    await expect(runBenchmark(options(), fake.deps)).rejects.toThrow('run "bun run build" first');
    expect(fake.events).toEqual([]);
    expect(() => assertServerBuilt("/missing/server.js", false)).toThrow("/missing/server.js");
    expect(() => assertServerBuilt("/present/server.js", true)).not.toThrow();
  });

  test("primary failure still closes, stops and removes", async () => {
    const fake = harness(() => {
      throw new Error("launch broke");
    });
    await expect(runBenchmark({ ...options(), app: "fake.app" }, fake.deps)).rejects.toThrow(
      "launch broke",
    );
    expect(fake.events).toEqual(["make", "create", "close", "stop", "remove"]);
    expect(fake.logs.join("\n")).toContain("launch broke");
  });

  test("a failed connection still attempts private stop", async () => {
    const fake = harness();
    fake.deps.createClient = async ({ env }) => {
      assertPrivateDaemonNamespace(env, `${runDir}-1`);
      fake.envs.push(env);
      throw new Error("connect failed");
    };
    await expect(runBenchmark(options(), fake.deps)).rejects.toThrow("connect failed");
    expect(fake.events).toEqual(["make", "stop", "remove"]);
  });

  test("stop failure keeps the run dir and warns without masking the primary error", async () => {
    const fake = harness(() => ({
      isError: true,
      content: [{ type: "text", text: "launch failed" }],
    }));
    fake.deps.stopPrivateDaemon = async () => {
      fake.events.push("stop");
      throw new Error("stop failed");
    };
    await expect(runBenchmark({ ...options(), app: "fake.app" }, fake.deps)).rejects.toThrow(
      "launch failed",
    );
    expect(fake.events).toEqual(["make", "create", "close", "stop"]);
    expect(fake.logs.join("\n")).toContain(`retaining ${runDir}-1: stop failed`);
  });

  test("guard refuses cleanup if the env has been retargeted", async () => {
    const fake = harness();
    const create = fake.deps.createClient;
    fake.deps.createClient = async (launch) => {
      const client = await create(launch);
      const { env } = launch;
      env.AUTOMOBILE_DAEMON_SOCKET_PATH = "/outside/resident.sock";
      return client;
    };
    await runBenchmark(options(), fake.deps);
    expect(fake.events).toEqual(["make", "create", "close"]);
    expect(fake.logs.join("\n")).toContain("retaining");
  });

  test("close and removal errors do not replace the primary failure", async () => {
    const fake = harness();
    fake.deps.createClient = async ({ env }) => {
      fake.envs.push(env);
      return {
        callTool: async () => ({
          isError: true,
          content: [{ type: "text", text: "launch failed" }],
        }),
        close: async () => {
          throw new Error("close failed");
        },
      };
    };
    fake.deps.removeRunDir = () => {
      throw new Error("remove failed");
    };
    await expect(runBenchmark({ ...options(), app: "fake.app" }, fake.deps)).rejects.toThrow(
      "launch failed",
    );
    expect(fake.events).toContain("stop");
    expect(fake.logs.join("\n")).toContain("close failed");
    expect(fake.logs.join("\n")).toContain("remove failed");
  });

  test("private daemon start failures are measured normally, exclude warmup and still clean up", async () => {
    const message =
      "Found live AutoMobile daemon process(es) (123) but none became reachable within 100ms. Refusing to terminate a live daemon during start";
    for (const respond of [
      () => ({ isError: true, content: [{ type: "text", text: message }] }),
      () => ({ structuredContent: { success: false, error: { message } } }),
      () => {
        throw new Error(message);
      },
    ]) {
      const fake = harness(respond);
      const report = await runBenchmark(options(), fake.deps);
      expect(fake.calls()).toBe(12); // Four series, each with one warmup and two measured calls.
      for (const series of Object.values(report.results)) {
        for (const metric of Object.values(series)) {
          expect(metric).toEqual({
            invalid: true,
            sampleSize: 2,
            failures: 2,
            screenshotSettledFalse: 0,
            failureReasons: [{ message, count: 2 }],
          });
        }
      }
      expect(report.settledVsAsync).toEqual({});
      expect(JSON.parse(formatReportJson(report)).results).toEqual(report.results);
      expect(formatReportTable(report)).toContain("INVALID");
      expect(formatReportTable(report)).toContain(
        "observe/settled (2/2): 2x Found live AutoMobile",
      );
      expect(benchmarkExitCode(report, { allowFailures: false })).toBe(1);
      expect(benchmarkExitCode(report, { allowFailures: true })).toBe(0);
      expect(fake.events).toEqual(["make", "create", "close", "stop", "remove"]);
    }
  });

  test("ordinary thrown calls are counted, warmup excluded, partial failures keep latency", async () => {
    const fake = harness((_name, _args, index) => {
      if (index <= 2) {
        throw new Error("transient failure");
      }
      return success;
    });
    const report = await runBenchmark(options(), fake.deps);
    expect(fake.calls()).toBe(12);
    expect(report.results.observe.async).toMatchObject({
      sampleSize: 2,
      failures: 1,
      p50: 1,
      failureReasons: [{ message: "transient failure", count: 1 }],
    });
    expect(report.results.observe.settled.failures).toBe(0);
    expect(benchmarkExitCode(report, { allowFailures: false })).toBe(0);
  });

  test("all failed error envelopes produce invalid JSON, table reasons and no delta", async () => {
    const fake = harness(() => ({
      structuredContent: { success: false, error: "volume_up rejected" },
    }));
    const report = await runBenchmark(options(), fake.deps);
    const metric = report.results.observe.settled;
    expect(metric).toEqual({
      invalid: true,
      sampleSize: 2,
      failures: 2,
      screenshotSettledFalse: 0,
      failureReasons: [{ message: "volume_up rejected", count: 2 }],
    });
    expect(report.settledVsAsync).toEqual({});
    expect(JSON.parse(formatReportJson(report)).results.observe.settled).toEqual(metric);
    expect(formatReportTable(report)).toContain("INVALID");
    expect(formatReportTable(report)).toContain("observe/settled (2/2): 2x volume_up rejected");
    expect(benchmarkExitCode(report, { allowFailures: false })).toBe(1);
    expect(benchmarkExitCode(report, { allowFailures: true })).toBe(0);
  });
});

describe("benchmark failure reporting", () => {
  test("failure descriptions handle text, structured errors, JSON text and empty envelopes", () => {
    for (const envelope of [
      { isError: true, content: [{ type: "text", text: "failed" }] },
      { structuredContent: { error: "failed" } },
      { structuredContent: { error: { message: "failed" } } },
      { structuredContent: { success: false, message: "failed" } },
      { content: [{ type: "text", text: JSON.stringify({ success: false, error: "failed" }) }] },
    ]) {
      expect(describeFailure(envelope)).toBe("failed");
    }
    expect(describeFailure({ isError: true, content: [{ type: "text", text: "{broken" }] })).toBe(
      "{broken",
    );
    for (const envelope of [
      undefined,
      null,
      {},
      { structuredContent: { error: {}, message: " " } },
      { isError: true, content: [{ type: "text", text: "" }] },
    ]) {
      expect(describeFailure(envelope)).toBe("failed with no error message");
    }
  });

  test("aggregation deduplicates and sorts count descending then message", () => {
    expect(aggregateFailureReasons(["z", "b", "z", "a", "b", " "])).toEqual([
      { message: "b", count: 2 },
      { message: "z", count: 2 },
      { message: "a", count: 1 },
      { message: "failed with no error message", count: 1 },
    ]);
  });

  test("JSON preserves full messages and table flattens and truncates only its display", () => {
    const message = `failure\n${"x".repeat(300)}`;
    const report = reportWith(calculateMetrics([1, 2], 1, 0, [message]));
    const table = formatReportTable(report);
    expect(
      JSON.parse(formatReportJson(report)).results.observe.settled.failureReasons[0].message,
    ).toBe(message);
    expect(table).toContain("Failure reasons:");
    expect(table).toContain("observe/settled (1/2): 1x failure ");
    expect(table).toContain("…");
    expect(table).not.toContain(message);
    expect(formatReportTable(reportWith(calculateMetrics([1], 0, 0)))).not.toContain(
      "Failure reasons:",
    );
  });

  test("validity ignores empty samples and invalid metrics omit every percentile", () => {
    expect(isInvalidSeries(0, 0)).toBe(false);
    expect(isInvalidSeries(2, 1)).toBe(false);
    expect(isInvalidSeries(2, 2)).toBe(true);
    const invalid = calculateMetrics([1, 2], 2, 1, ["error", "error"]);
    for (const key of ["p50", "p95", "p99", "min", "max"]) {
      expect(Object.hasOwn(invalid, key)).toBe(false);
    }
    const valid = calculateMetrics([1, 2], 1, 0, ["error"]);
    expect(valid).toMatchObject({
      p50: 1,
      p95: 2,
      failureReasons: [{ message: "error", count: 1 }],
    });
    expect(settledAsyncDelta(invalid, valid)).toBeUndefined();
    expect(settledAsyncDelta(valid, invalid)).toBeUndefined();
  });

  test("allow-failures defaults false, is parsed and documented", () => {
    expect(parseBenchmarkArgs(["--platform", "ios"]).allowFailures).toBe(false);
    expect(parseBenchmarkArgs(["--platform", "ios", "--allow-failures"]).allowFailures).toBe(true);
    expect(helpText()).toContain("--allow-failures");
  });
});
