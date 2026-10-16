import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { parseSuiteDefinition, type LoadedSuite } from "../../../scripts/agent-benchmark/config";
import {
  runSuite,
  runTimestamp,
  type ClaudeLaunchSpec,
  type HarnessDeps,
  type HarnessFs,
} from "../../../scripts/agent-benchmark/harness";
import { CountingIdGenerator } from "../../../src/utils/IdGenerator";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeCommandRunner } from "./fakeCommandRunner";
import { TranscriptBuilder } from "./transcriptBuilder";

const START_MS = Date.UTC(2026, 9, 16, 1, 2, 3);
const DEVICES = "List of devices attached\nemulator-5554\tdevice\n";
const SCREEN = '<hierarchy><node text="Expected count: 3"/><node text="A &amp; B"/></hierarchy>';
// The harness builds paths with path.join, so expectations do too (Windows unit lane).
const RUN_DIR = join("/out", "demo", "20261016T010203Z-run-1");
const artifact = (...parts: string[]) => join(RUN_DIR, ...parts);

class MemoryFs implements HarnessFs {
  readonly files = new Map<string, string>();
  readonly dirs = new Set<string>();
  readonly removed: string[] = [];
  mkdir(path: string) {
    this.dirs.add(path);
  }
  writeFile(path: string, content: string) {
    this.files.set(path, content);
  }
  readFile(path: string) {
    const content = this.files.get(path);
    if (content === undefined) {
      throw new Error(`ENOENT ${path}`);
    }
    return content;
  }
  exists(path: string) {
    return this.files.has(path);
  }
  makeTempDir(prefix: string) {
    return `/tmp/${prefix}test`;
  }
  remove(path: string) {
    this.removed.push(path);
  }
}

function loadedSuite(overrides: Record<string, unknown> = {}): LoadedSuite {
  return {
    definition: parseSuiteDefinition(
      {
        name: "demo",
        platform: "android",
        prompt: "p.md",
        app: { packageName: "dev.example" },
        preflight: { launchUri: "example:start", settleSeconds: 3 },
        claude: { model: "suite-model", timeoutSeconds: 60 },
        verify: { answerIncludes: ["COUNT: 3"], screenIncludes: ["Expected count: 3", "A & B"] },
        ...overrides,
      },
      "demo.yml",
    ),
    suitePath: "/suites/demo.yml",
    promptPath: "/prompts/p.md",
    prompt: "Do it on {deviceSerial}.",
  };
}

function setup(transcript: string, launchMs = 42_000) {
  const timer = new FakeTimer();
  timer.setCurrentTime(START_MS);
  timer.enableAutoAdvance();
  const fs = new MemoryFs();
  const runner = new FakeCommandRunner()
    .onAdb("devices", { stdout: DEVICES })
    .onAdb("pm path", { stdout: "package:/x.apk" })
    .onAdb("pm clear", { stdout: "Success\n" })
    .onAdb("exec-out cat", { stdout: SCREEN })
    .on("claude", () => ({ stdout: "2.1.301 (Claude Code)\n" }));
  const launches: ClaudeLaunchSpec[] = [];
  const logs: string[] = [];
  const deps: HarnessDeps = {
    runner,
    timer,
    idGenerator: new CountingIdGenerator("run"),
    deviceClaims: { liveOwner: () => undefined },
    fs,
    log: (line) => logs.push(line),
    env: { PATH: "/bin", UNSET: undefined },
    launcher: {
      async launch(spec) {
        launches.push(spec);
        timer.advanceTime(launchMs);
        fs.writeFile(spec.stdoutPath, transcript);
        return { exitCode: 0, timedOut: false };
      },
    },
  };
  const options = {
    outputRoot: "/out",
    runtime: "/usr/bin/bun",
    serverEntry: "/repo/dist/src/index.js",
    claudeCommand: "claude",
  };
  return { timer, fs, runner, launches, logs, deps, options };
}

const PASSING = new TranscriptBuilder()
  .init()
  .mcp("observe")
  .mcp("tapOn")
  .result({ finalText: "COUNT: 3" })
  .build();

describe("agent benchmark harness", () => {
  test("timestamps are compact UTC", () => {
    expect(runTimestamp(START_MS + 456)).toBe("20261016T010203Z");
  });

  test("a passing run measures only the Claude window and writes every artifact", async () => {
    const { fs, runner, launches, deps, options } = setup(PASSING);
    const result = await runSuite(loadedSuite(), options, deps);

    expect(result.comparison.verdict).toBe("passed");
    expect(result.outcome.wallClockSeconds).toBe(42);
    expect(result.preflight.durationSeconds).toBe(3);
    expect(result.runDirectory).toBe(RUN_DIR);
    expect(result.claude).toEqual({
      requestedModel: "suite-model",
      observedModel: "claude-test-model",
      version: "2.1.301 (Claude Code)",
    });

    const [launch] = launches;
    expect(launch.cwd).toBe("/tmp/amb-cwd-test");
    expect(launch.stdin).toBe("Do it on emulator-5554.");
    expect(launch.args).toContain("suite-model");
    expect(launch.timeoutMs).toBe(60_000);
    expect(launch.env).toEqual({
      PATH: "/bin",
      AUTOMOBILE_AUX_SOCKET_DIR: "/tmp/amb-test",
      AUTOMOBILE_HARNESS_PRIVATE_DAEMON: "1",
      AUTOMOBILE_PRIVATE_DAEMON_ORPHAN_IDLE_MS: "5000",
      AUTOMOBILE_DB_DIR: artifact("db"),
      AUTOMOBILE_LOG_DIR: artifact("logs"),
      CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
      AUTOMOBILE_AGENT_BENCH_SERIAL: "emulator-5554",
      AUTOMOBILE_AGENT_BENCH_RUN_DIR: RUN_DIR,
    });
    expect(JSON.parse(fs.readFile(artifact("claude-command.json"))).cwd).toBe("/tmp/amb-cwd-test");

    const mcpConfig = JSON.parse(fs.readFile(artifact("mcp-config.json")));
    expect(mcpConfig.mcpServers["auto-mobile"].env.AUTOMOBILE_AUX_SOCKET_DIR).toBe("/tmp/amb-test");
    expect(fs.readFile(artifact("prompt.md"))).toBe("Do it on emulator-5554.");
    expect(fs.readFile(artifact("screen.xml"))).toBe(SCREEN);
    expect(fs.readFile(artifact("preflight.log"))).toContain("launched example:start");
    expect(JSON.parse(fs.readFile(artifact("result.json"))).suite).toBe("demo");
    expect(fs.readFile(artifact("baseline.yml"))).toContain("baselineToolSequence:");
    expect([...fs.dirs]).toEqual(expect.arrayContaining([artifact("db"), artifact("logs")]));

    const stop = runner.calls.find((call) => call.args.includes("--daemon"));
    expect(stop?.command).toBe("/usr/bin/bun");
    expect(stop?.args).toEqual(["/repo/dist/src/index.js", "--daemon", "stop"]);
    expect(stop?.env?.AUTOMOBILE_AUX_SOCKET_DIR).toBe("/tmp/amb-test");
    expect(fs.removed).toEqual(["/tmp/amb-test", "/tmp/amb-cwd-test"]);
  });

  test("a failed verification keeps artifacts but writes no baseline snippet", async () => {
    const wrong = new TranscriptBuilder()
      .init()
      .mcp("observe")
      .result({ finalText: "COUNT: 2" })
      .build();
    const { fs, deps, options } = setup(wrong);
    const result = await runSuite(loadedSuite(), options, deps);
    expect(result.comparison.verdict).toBe("failed");
    expect(fs.exists(artifact("result.json"))).toBe(true);
    expect(fs.exists(artifact("baseline.yml"))).toBe(false);
  });

  test("no screen dump is taken when the suite has no screen checks", async () => {
    const { runner, deps, options } = setup(PASSING);
    await runSuite(loadedSuite({ verify: { answerIncludes: ["COUNT: 3"] } }), options, deps);
    expect(runner.adbCalls().some((call) => call.includes("uiautomator"))).toBe(false);
  });

  test("a launch failure still stops the private daemon and removes the socket dir", async () => {
    const { fs, runner, deps, options } = setup(PASSING);
    deps.launcher = {
      launch: () => Promise.reject(new Error("Failed to launch claude: ENOENT")),
    };
    await expect(runSuite(loadedSuite(), options, deps)).rejects.toThrow(/ENOENT/);
    expect(runner.calls.some((call) => call.args.includes("--daemon"))).toBe(true);
    expect(fs.removed).toEqual(["/tmp/amb-test", "/tmp/amb-cwd-test"]);
  });

  test("a missing transcript makes the run incomplete rather than throwing", async () => {
    const { deps, options, fs } = setup(PASSING);
    deps.launcher = { launch: async () => ({ exitCode: 1, timedOut: false }) };
    const result = await runSuite(loadedSuite(), options, deps);
    expect(result.comparison.verdict).toBe("incomplete");
    expect(fs.exists(artifact("result.json"))).toBe(true);
  });

  test("teardown and version failures are logged, not fatal", async () => {
    const { runner, logs, deps, options } = setup(PASSING);
    runner.on("/usr/bin/bun", () => ({ exitCode: 3, stderr: "no daemon\n" }));
    runner.on("claude", () => {
      throw new Error("spawn claude ENOENT");
    });
    const result = await runSuite(loadedSuite(), options, deps);
    expect(result.claude.version).toBeUndefined();
    expect(logs).toContain("private daemon stop exited 3: no daemon");
    expect(logs).toContain("claude --version failed: spawn claude ENOENT");
  });

  test("inherited state overrides never reach Claude, the server, or the daemon stop", async () => {
    const { runner, launches, deps, options } = setup(PASSING);
    deps.env = {
      PATH: "/bin",
      AUTOMOBILE_DB_PATH: "/home/me/.auto-mobile/auto-mobile.db",
      AUTOMOBILE_DAEMON_SOCKET_PATH: "/tmp/resident.sock",
      AUTOMOBILE_DAEMON_PID_FILE_PATH: "/tmp/resident.pid",
      AUTO_MOBILE_DB_DIR: "/home/me/legacy-db",
      AUTOMOBILE_ADB_SERVER_COORDINATION_DIR: "/shared/claims",
    };
    await runSuite(loadedSuite(), options, deps);
    const stop = runner.calls.find((call) => call.args.includes("--daemon"));
    for (const env of [launches[0].env, stop?.env ?? {}]) {
      expect(env.AUTOMOBILE_DB_PATH).toBeUndefined();
      expect(env.AUTOMOBILE_DAEMON_SOCKET_PATH).toBeUndefined();
      expect(env.AUTOMOBILE_DAEMON_PID_FILE_PATH).toBeUndefined();
      expect(env.AUTO_MOBILE_DB_DIR).toBeUndefined();
      expect(env.AUTOMOBILE_DB_DIR).toBe(artifact("db"));
      expect(env.AUTOMOBILE_ADB_SERVER_COORDINATION_DIR).toBe("/shared/claims");
    }
  });

  test("runs of one suite in the same second get separate directories", async () => {
    const first = setup(PASSING);
    const second = setup(PASSING);
    second.deps.idGenerator = first.deps.idGenerator;
    const a = await runSuite(loadedSuite(), first.options, first.deps);
    const b = await runSuite(loadedSuite(), second.options, second.deps);
    expect(a.startedAt).toBe(b.startedAt);
    expect(a.runDirectory).not.toBe(b.runDirectory);
  });

  test("a device claimed by another AutoMobile session is never touched", async () => {
    const { runner, launches, fs, deps, options } = setup(PASSING);
    deps.deviceClaims = { liveOwner: (serial) => (serial === "emulator-5554" ? 4242 : undefined) };
    await expect(runSuite(loadedSuite(), options, deps)).rejects.toThrow(
      /emulator-5554 is claimed by another AutoMobile session \(pid 4242\)/,
    );
    expect(runner.adbCalls()).toEqual(["devices"]);
    expect(launches).toHaveLength(0);
    expect(fs.dirs.size).toBe(0);
  });
});
