import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { parseSuiteDefinition, type LoadedSuite } from "../../../scripts/agent-benchmark/config";
import {
  runSuite,
  runTimestamp,
  suiteDigest,
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
const SCREEN =
  '<hierarchy><node package="dev.example" text="Expected count: 3"/>' +
  '<node package="dev.example" content-desc="A &amp; B"/></hierarchy>';
// The harness builds paths with path.join, so expectations do too (Windows unit lane).
const APK_DIGEST = `a1b2c3d4e5f60718${"0".repeat(48)}`;
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
  sha256(_path: string) {
    return APK_DIGEST;
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
  const claims: string[] = [];
  const logs: string[] = [];
  const deps: HarnessDeps = {
    runner,
    timer,
    idGenerator: new CountingIdGenerator("run"),
    deviceClaims: {
      reserve: async (serial) => {
        claims.push(`reserve ${serial}`);
        return {
          handOff: () => claims.push(`hand off ${serial}`),
          release: () => claims.push(`release ${serial}`),
        };
      },
    },
    fs,
    log: (line) => logs.push(line),
    env: { PATH: "/bin", UNSET: undefined },
    launcher: {
      async launch(spec) {
        launches.push(spec);
        claims.push("launch");
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
  return { timer, fs, runner, launches, logs, claims, deps, options };
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

  test("screen checks ignore other packages and non-visible attributes", async () => {
    const { runner, deps, options } = setup(PASSING);
    runner.onAdb("exec-out cat", {
      stdout:
        '<hierarchy><node package="wrong.app" text="Expected count: 3"/>' +
        '<node package="dev.example" resource-id="dev.example:id/A &amp; B" text=""/></hierarchy>',
    });
    const result = await runSuite(loadedSuite(), options, deps);
    expect(result.comparison.verdict).toBe("failed");
    expect(result.outcome.screenText).toBe("");
  });

  test("a pass that recovered from a stumble writes no baseline snippet", async () => {
    const recovered = new TranscriptBuilder()
      .init()
      .mcp("tapOn", "Element not found", { isError: true })
      .mcp("observe")
      .mcp("tapOn")
      .result({ finalText: "COUNT: 3" })
      .build();
    const { fs, logs, deps, options } = setup(recovered);
    const result = await runSuite(loadedSuite(), options, deps);
    expect(result.comparison.verdict).toBe("passed");
    expect(result.comparison.stumbles).toBe(1);
    expect(fs.exists(artifact("baseline.yml"))).toBe(false);
    expect(logs).toContain("[demo] passed with 1 stumble(s); no baseline.yml written");
  });

  test("an APK suite fingerprints the build by content, not install time", async () => {
    const { runner, deps, options } = setup(PASSING);
    runner.onAdb("dumpsys package", {
      stdout:
        "versionCode=7 minSdk=26\n    versionName=1.0\n    lastUpdateTime=2026-10-16 10:00:00\n",
    });
    runner
      .onAdb("pm path", { stdout: "package:/data/app/x/base.apk\n" })
      .onAdb("sha256sum", { stdout: `${APK_DIGEST}  /data/app/x/base.apk\n` });
    const suite = { ...loadedSuite(), apkPath: "/repo/app.apk" };
    const result = await runSuite(suite, options, deps);
    expect(result.preflight.appBuild).toBe("versionName=1.0 versionCode=7 sha256=a1b2c3d4e5f60718");
    expect(result.preflight.log).toContain("verified dev.example is /repo/app.apk");
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

  test("a failed setup removes the temp directories it already created", async () => {
    const { fs, launches, deps, options } = setup(PASSING);
    fs.makeTempDir = (prefix: string) => {
      if (prefix === "amb-cwd-") {
        throw new Error("ENOSPC");
      }
      return `/tmp/${prefix}test`;
    };
    await expect(runSuite(loadedSuite(), options, deps)).rejects.toThrow(/ENOSPC/);
    expect(fs.removed).toEqual(["/tmp/amb-test"]);
    expect(launches).toHaveLength(0);
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
      AUTO_MOBILE_ADB_SERVER_COORDINATION_DIR: "/shared/legacy-claims",
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
      expect(env.AUTO_MOBILE_ADB_SERVER_COORDINATION_DIR).toBe("/shared/legacy-claims");
    }
  });

  test("inherited run-shaping Claude variables are dropped; auth variables are kept", async () => {
    const { launches, deps, options } = setup(PASSING);
    deps.env = {
      PATH: "/bin",
      CLAUDE_CODE_MAX_TURNS: "3",
      MCP_CONNECTION_NONBLOCKING: "1",
      MCP_TOOL_TIMEOUT: "100",
      MAX_THINKING_TOKENS: "0",
      CLAUDE_CODE_EFFORT_LEVEL: "low",
      CLAUDE_CODE_DISABLE_THINKING: "1",
      CLAUDE_CODE_SUBAGENT_MODEL: "haiku",
      CLAUDE_ADDITIONAL_DIRECTORIES: "/elsewhere",
      DISABLE_PROMPT_CACHING: "1",
      DISABLE_PROMPT_CACHING_OPUS: "1",
      ENABLE_PROMPT_CACHING_1H_BEDROCK: "1",
      FORCE_PROMPT_CACHING_5M: "1",
      ANTHROPIC_API_KEY: "sk-test",
      ANTHROPIC_MODEL: "provider-model-id",
      CLAUDE_CODE_USE_BEDROCK: "1",
      CLAUDE_CODE_OAUTH_TOKEN: "oauth",
      CLAUDE_CODE_HTTPS_PROXY: "http://proxy",
    };
    await runSuite(loadedSuite(), options, deps);
    const env = launches[0].env;
    for (const name of [
      "CLAUDE_CODE_MAX_TURNS",
      "MCP_CONNECTION_NONBLOCKING",
      "MCP_TOOL_TIMEOUT",
      "MAX_THINKING_TOKENS",
      "CLAUDE_CODE_EFFORT_LEVEL",
      "CLAUDE_CODE_DISABLE_THINKING",
      "CLAUDE_CODE_SUBAGENT_MODEL",
      "CLAUDE_ADDITIONAL_DIRECTORIES",
      "DISABLE_PROMPT_CACHING",
      "DISABLE_PROMPT_CACHING_OPUS",
      "ENABLE_PROMPT_CACHING_1H_BEDROCK",
      "FORCE_PROMPT_CACHING_5M",
    ]) {
      expect({ name, value: env[name] }).toEqual({ name, value: undefined });
    }
    expect(env.ANTHROPIC_API_KEY).toBe("sk-test");
    expect(env.ANTHROPIC_MODEL).toBe("provider-model-id");
    expect(env.CLAUDE_CODE_USE_BEDROCK).toBe("1");
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("oauth");
    expect(env.CLAUDE_CODE_HTTPS_PROXY).toBe("http://proxy");
  });

  test("the suite digest covers the task, not the recorded baseline", () => {
    const base = suiteDigest(loadedSuite());
    expect(base).toMatch(/^[0-9a-f]{16}$/);
    expect(suiteDigest(loadedSuite())).toBe(base);
    expect(suiteDigest(loadedSuite({ baseline: { totalToolCalls: 9 } }))).toBe(base);
    expect(suiteDigest({ ...loadedSuite(), apkPath: "/other/checkout/app.apk" })).toBe(base);
    expect(suiteDigest({ ...loadedSuite(), prompt: "Do something else." })).not.toBe(base);
    expect(suiteDigest(loadedSuite({ preflight: { launchUri: "example:other" } }))).not.toBe(base);
    expect(suiteDigest(loadedSuite(), "other-model")).not.toBe(base);
    expect(suiteDigest(loadedSuite(), "suite-model")).toBe(base);
  });

  test("the run result and baseline snippet carry the suite digest", async () => {
    const { fs, deps, options } = setup(PASSING);
    const result = await runSuite(loadedSuite(), options, deps);
    expect(result.suiteDigest).toBe(suiteDigest(loadedSuite()));
    expect(fs.readFile(artifact("baseline.yml"))).toContain(`suiteDigest: ${result.suiteDigest}`);
  });

  test("the device claim is held through preflight and released before Claude starts", async () => {
    const { claims, runner, deps, options } = setup(PASSING);
    const order: string[] = [];
    const inner = deps.runner;
    deps.runner = {
      run: (command, args, timeoutMs, env) => {
        if (args.includes("pm") && args.includes("clear")) {
          order.push(`pm clear with ${claims.at(-1)}`);
        }
        return inner.run(command, args, timeoutMs, env);
      },
    };
    await runSuite(loadedSuite(), options, deps);
    expect(order).toEqual(["pm clear with reserve emulator-5554"]);
    expect(claims).toEqual([
      "reserve emulator-5554",
      "hand off emulator-5554",
      "launch",
      "release emulator-5554",
    ]);
    expect(runner.adbCalls().some((call) => call.includes("pm clear"))).toBe(true);
  });

  test("elapsed times use the monotonic clock, so a wall-clock step cannot skew them", async () => {
    const { timer, deps, options } = setup(PASSING, 42_000);
    const launcher = deps.launcher;
    deps.launcher = {
      async launch(spec) {
        const exit = await launcher.launch(spec);
        timer.stepWallClock(-3_600_000);
        return exit;
      },
    };
    const result = await runSuite(loadedSuite(), options, deps);
    expect(result.outcome.wallClockSeconds).toBe(42);
  });

  test("a suite's start-screen check stops the run before Claude when preflight lands elsewhere", async () => {
    const { claims, launches, fs, runner, deps, options } = setup(PASSING);
    runner.onAdb("exec-out cat", {
      stdout: '<hierarchy><node package="dev.example" text="Welcome! Sign in"/></hierarchy>',
    });
    const suite = loadedSuite({
      preflight: { launchUri: "example:start", startScreenIncludes: ["Bug repro"] },
    });
    await expect(runSuite(suite, options, deps)).rejects.toThrow(
      /did not reach the expected start screen \(missing: Bug repro\)/,
    );
    expect(launches).toHaveLength(0);
    expect(fs.exists(artifact("start-screen.xml"))).toBe(true);
    expect(claims.at(-1)).toBe("release emulator-5554");
  });

  test("a matching start screen proceeds, and the device fingerprint is recorded", async () => {
    const { runner, deps, options } = setup(PASSING);
    runner
      .onAdb("exec-out cat", {
        stdout: '<hierarchy><node package="dev.example" text="Bug repro"/></hierarchy>',
      })
      .onAdb("getprop", { stdout: "36\npixel\nen-US\nPhysical size: 1x2\nPhysical density: 3\n" });
    const suite = loadedSuite({
      preflight: { launchUri: "example:start", startScreenIncludes: ["Bug repro"] },
      verify: { answerIncludes: ["COUNT: 3"] },
    });
    const result = await runSuite(suite, options, deps);
    expect(result.comparison.verdict).toBe("passed");
    expect(result.preflight.device).toBe("sdk=36 model=pixel locale=en-US size=1x2 density=3");
  });

  test("a failed preflight releases the device claim", async () => {
    const { claims, runner, deps, options } = setup(PASSING);
    runner.onAdb("pm clear", { stdout: "Failed\n" });
    await expect(runSuite(loadedSuite(), options, deps)).rejects.toThrow(/did not succeed/);
    expect(claims).toEqual(["reserve emulator-5554", "release emulator-5554"]);
  });

  test("an unreadable foreign claim also keeps the device untouched", async () => {
    const { runner, deps, options } = setup(PASSING);
    deps.deviceClaims = {
      reserve: async () => ({
        refused: "is claimed by another AutoMobile session (an unreadable claim)",
      }),
    };
    await expect(runSuite(loadedSuite(), options, deps)).rejects.toThrow(
      /claimed by another AutoMobile session \(an unreadable claim\)/,
    );
    expect(runner.adbCalls()).toEqual(["devices"]);
  });

  test("the MCP config repeats the shared claim root for allowlisted server envs", async () => {
    const { fs, deps, options } = setup(PASSING);
    deps.env = { PATH: "/bin", AUTO_MOBILE_ADB_SERVER_COORDINATION_DIR: "/shared/legacy" };
    await runSuite(loadedSuite(), options, deps);
    const env = JSON.parse(fs.readFile(artifact("mcp-config.json"))).mcpServers["auto-mobile"].env;
    expect(env.AUTO_MOBILE_ADB_SERVER_COORDINATION_DIR).toBe("/shared/legacy");
    expect(env.PATH).toBeUndefined();
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
    deps.deviceClaims = {
      reserve: async (serial) =>
        serial === "emulator-5554"
          ? { refused: "is claimed by another AutoMobile session (pid 4242)" }
          : { handOff: () => undefined, release: () => undefined },
    };
    await expect(runSuite(loadedSuite(), options, deps)).rejects.toThrow(
      /emulator-5554 is claimed by another AutoMobile session \(pid 4242\)/,
    );
    expect(runner.adbCalls()).toEqual(["devices"]);
    expect(launches).toHaveLength(0);
    expect(fs.dirs.size).toBe(0);
  });
});
