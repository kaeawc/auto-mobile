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
        prompt: "p.txt",
        app: { packageName: "dev.example" },
        preflight: { launchUri: "example:start", settleSeconds: 3 },
        claude: { model: "suite-model", timeoutSeconds: 60 },
        verify: { answerIncludes: ["COUNT: 3"], screenIncludes: ["Expected count: 3", "A & B"] },
        ...overrides,
      },
      "demo.yml",
    ),
    suitePath: "/suites/demo.yml",
    promptPath: "/prompts/p.txt",
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
    .onAdb("dumpsys package", {
      stdout:
        "versionCode=7 minSdk=26\n    versionName=1.0\n    lastUpdateTime=2026-10-16 10:00:00\n",
    })
    .onAdb("getprop", {
      stdout:
        "36\npixel\nen-US\nAP4A\nnull\n0\nnull\nPhysical size: 1x2\nPhysical density: 3\n1.0\n1\n1\n1\nNight mode: no\n",
    })
    .onAdb("dumpsys window displays", { stdout: "  mRotation=0\n" })
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
          reclaim: async () => {
            claims.push(`reclaim ${serial}`);
            return undefined;
          },
          release: () => claims.push(`release ${serial}`),
        };
      },
    },
    fs,
    log: (line) => logs.push(line),
    env: { PATH: "/bin", UNSET: undefined },
    platform: "linux",
    physicalIosDevices: async () => ({ names: [], complete: true }),
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
    serverBuild: "sha256=5e5e5e5e5e5e5e5e",
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
      version: "2.1.301",
    });

    const [launch] = launches;
    expect(launch.cwd).toBe("/tmp/amb-cwd-test");
    expect(launch.stdin).toBe("Do it on emulator-5554.");
    expect(launch.args).toContain("suite-model");
    expect(launch.timeoutMs).toBe(60_000);
    expect(launch.env).toEqual({
      // Already absolute for the deps' POSIX platform, on any host.
      PATH: "/bin",
      AUTOMOBILE_AUX_SOCKET_DIR: "/tmp/amb-test",
      AUTOMOBILE_HARNESS_PRIVATE_DAEMON: "1",
      AUTOMOBILE_PRIVATE_DAEMON_ORPHAN_IDLE_MS: "5000",
      AUTOMOBILE_DATA_DIR: artifact("data"),
      AUTOMOBILE_DB_DIR: artifact("db"),
      AUTOMOBILE_LOG_DIR: artifact("logs"),
      CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
      CLAUDE_CODE_DISABLE_POLICY_SKILLS: "1",
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
    // The probe failed, so the version comes from the stream's init event instead.
    expect(result.claude.version).toBe("2.1.301");
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
      expect(env.AUTOMOBILE_DATA_DIR).toBe(artifact("data"));
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
      API_TIMEOUT_MS: "10",
      MAX_THINKING_TOKENS: "0",
      CLAUDE_CODE_EFFORT_LEVEL: "low",
      CLAUDE_CODE_DISABLE_THINKING: "1",
      CLAUDE_CODE_SUBAGENT_MODEL: "haiku",
      CLAUDE_ADDITIONAL_DIRECTORIES: "/elsewhere",
      CLAUDE_CODE_SIMPLE: "1",
      CLAUDE_CODE_SIMPLE_SYSTEM_PROMPT: "1",
      CLAUDE_CODE_ENABLE_TASKS: "1",
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
      "API_TIMEOUT_MS",
      "MAX_THINKING_TOKENS",
      "CLAUDE_CODE_EFFORT_LEVEL",
      "CLAUDE_CODE_DISABLE_THINKING",
      "CLAUDE_CODE_SUBAGENT_MODEL",
      "CLAUDE_ADDITIONAL_DIRECTORIES",
      "CLAUDE_CODE_SIMPLE",
      "CLAUDE_CODE_SIMPLE_SYSTEM_PROMPT",
      "CLAUDE_CODE_ENABLE_TASKS",
      "DISABLE_PROMPT_CACHING",
      "DISABLE_PROMPT_CACHING_OPUS",
      "ENABLE_PROMPT_CACHING_1H_BEDROCK",
      "FORCE_PROMPT_CACHING_5M",
    ]) {
      expect(env[name], name).toBeUndefined();
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

  test("the run result and baseline snippet carry the server build digest", async () => {
    const { fs, deps, options } = setup(PASSING);
    const result = await runSuite(loadedSuite(), options, deps);
    expect(result.serverBuild).toBe("sha256=5e5e5e5e5e5e5e5e");
    expect(fs.readFile(artifact("baseline.yml"))).toContain("serverBuild: sha256=5e5e5e5e5e5e5e5e");
  });

  test("the post-run screen is read only after the daemon stops and the claim is retaken", async () => {
    const { claims, runner, deps, options } = setup(PASSING);
    const inner = deps.runner;
    deps.runner = {
      run: (command, args, timeoutMs, env) => {
        if (args.includes("--daemon")) {
          claims.push("daemon stop");
        } else if (args.includes("exec-out") && claims.includes("launch")) {
          claims.push("screen dump");
        }
        return inner.run(command, args, timeoutMs, env);
      },
    };
    await runSuite(loadedSuite(), options, deps);
    expect(claims.slice(claims.indexOf("launch"))).toEqual([
      "launch",
      "daemon stop",
      "reclaim emulator-5554",
      "screen dump",
      "release emulator-5554",
    ]);
    expect(runner.calls.filter((call) => call.args.includes("--daemon"))).toHaveLength(1);
  });

  test("a reclaim that throws fails the screen check but still writes the result", async () => {
    const { fs, claims, deps, options } = setup(PASSING);
    const reserve = deps.deviceClaims.reserve;
    deps.deviceClaims = {
      reserve: async (serial) => {
        const held = await reserve(serial);
        return "refused" in held
          ? held
          : {
              ...held,
              reclaim: async () => {
                throw new Error("claim dir unreadable");
              },
            };
      },
    };
    const result = await runSuite(loadedSuite(), options, deps);
    expect(result.comparison.verdict).toBe("failed");
    expect(result.outcome.screenError).toBe(
      "could not reclaim emulator-5554: claim dir unreadable",
    );
    expect(fs.exists(artifact("result.json"))).toBe(true);
    expect(claims.at(-1)).toBe("release emulator-5554");
  });

  test("a device taken by another session after the run fails the screen check unread", async () => {
    const { claims, runner, logs, deps, options } = setup(PASSING);
    const reserve = deps.deviceClaims.reserve;
    deps.deviceClaims = {
      reserve: async (serial) => {
        const held = await reserve(serial);
        return "refused" in held
          ? held
          : { ...held, reclaim: async () => "is claimed by another AutoMobile session (pid 4242)" };
      },
    };
    const result = await runSuite(loadedSuite(), options, deps);
    expect(result.comparison.verdict).toBe("failed");
    expect(result.outcome.screenError).toBe(
      "emulator-5554 is claimed by another AutoMobile session (pid 4242) after the run; the screen was not read",
    );
    // This suite has no start-screen check, so the only dump would be the skipped one.
    expect(runner.adbCalls().some((call) => call.includes("exec-out"))).toBe(false);
    expect(logs.some((line) => line.startsWith("post-run screen dump skipped"))).toBe(true);
    expect(claims.at(-1)).toBe("release emulator-5554");
  });

  test("after an unconfirmed daemon stop, a refused reclaim is retried through the orphan window", async () => {
    const { runner, deps, options } = setup(PASSING);
    runner.on("/usr/bin/bun", () => ({ exitCode: 1, stderr: "timed out\n" }));
    let attempts = 0;
    const reserve = deps.deviceClaims.reserve;
    deps.deviceClaims = {
      reserve: async (serial) => {
        const held = await reserve(serial);
        return "refused" in held
          ? held
          : {
              ...held,
              // The lingering daemon holds its claim for two more attempts, then exits.
              reclaim: async () => (++attempts <= 2 ? "is claimed by the run's daemon" : undefined),
            };
      },
    };
    const result = await runSuite(loadedSuite(), options, deps);
    expect(attempts).toBe(3);
    expect(result.outcome.screenError).toBeUndefined();
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
      "reclaim emulator-5554",
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
      .onAdb("getprop", {
        stdout:
          "36\npixel\nen-US\nAP4A\nnull\n0\nnull\nGMT\nnull\nPhysical size: 1x2\nPhysical density: 3\n1.0\n1\n1\n1\nNight mode: no\n",
      });
    const suite = loadedSuite({
      preflight: { launchUri: "example:start", startScreenIncludes: ["Bug repro"] },
      verify: { answerIncludes: ["COUNT: 3"], screenIncludes: ["Bug repro"] },
    });
    const result = await runSuite(suite, options, deps);
    expect(result.comparison.verdict).toBe("passed");
    expect(result.preflight.device).toBe(
      "sdk=36 model=pixel locale=en-US build=AP4A a11y=none nav=3button ime=none tz=GMT clock=locale size=1x2 density=3 font=1 anim=1/1/1 theme=light rotation=0",
    );
    // Fingerprinting runs before the settle and start-screen check, never between it and launch.
    const calls = runner.adbCalls();
    expect(calls.findIndex((call) => call.includes("getprop"))).toBeLessThan(
      calls.findIndex((call) => call.includes("exec-out")),
    );
  });

  test("a failed preflight releases the device claim", async () => {
    const { claims, runner, deps, options } = setup(PASSING);
    runner.onAdb("pm clear", { stdout: "Failed\n" });
    await expect(runSuite(loadedSuite(), options, deps)).rejects.toThrow(/did not succeed/);
    expect(claims).toEqual(["reserve emulator-5554", "release emulator-5554"]);
  });

  test("a booted iOS simulator stops the run before anything touches the device", async () => {
    const { runner, launches, claims, deps, options } = setup(PASSING);
    deps.platform = "darwin";
    runner.on("xcrun", () => ({
      stdout: JSON.stringify({ devices: { ios: [{ name: "iPhone 17", state: "Booted" }] } }),
    }));
    await expect(runSuite(loadedSuite(), options, deps)).rejects.toThrow(
      /Booted iOS simulator\(s\) \(iPhone 17\).*shut them down first/,
    );
    expect(runner.adbCalls()).toEqual(["devices"]);
    expect(claims).toEqual([]);
    expect(launches).toHaveLength(0);
  });

  test("a connected physical iOS device stops the run before anything touches the device", async () => {
    const { runner, launches, claims, deps, options } = setup(PASSING);
    deps.physicalIosDevices = async () => ({ names: ["Test iPhone"], complete: true });
    await expect(runSuite(loadedSuite(), options, deps)).rejects.toThrow(
      /Connected iOS device\(s\) \(Test iPhone\).*disconnect them first/,
    );
    expect(runner.adbCalls()).toEqual(["devices"]);
    expect(claims).toEqual([]);
    expect(launches).toHaveLength(0);
  });

  test("an incomplete iOS device sweep stops the run instead of reading as none", async () => {
    const { runner, launches, claims, deps, options } = setup(PASSING);
    deps.physicalIosDevices = async () => ({ names: [], complete: false });
    await expect(runSuite(loadedSuite(), options, deps)).rejects.toThrow(
      /Could not list connected iOS devices/,
    );
    expect(runner.adbCalls()).toEqual(["devices"]);
    expect(claims).toEqual([]);
    expect(launches).toHaveLength(0);
  });

  test("a pass with an unknown device or app fingerprint writes no baseline snippet", async () => {
    const { fs, logs, runner, deps, options } = setup(PASSING);
    runner.onAdb("getprop", { exitCode: 1, stderr: "device offline" });
    const result = await runSuite(loadedSuite(), options, deps);
    expect(result.comparison.verdict).toBe("passed");
    expect(result.preflight.device).toBe("unknown");
    expect(fs.exists(artifact("baseline.yml"))).toBe(false);
    expect(logs).toContain(
      "[demo] passed, but the device fingerprint is unknown; no baseline.yml written",
    );
  });

  test("a failed --version probe falls back to the version the stream reports", async () => {
    const { fs, runner, deps, options } = setup(PASSING);
    runner.on("claude", () => ({ exitCode: 1, stderr: "wrapper: unknown flag" }));
    const result = await runSuite(loadedSuite(), options, deps);
    expect(result.claude.version).toBe("2.1.301");
    expect(fs.readFile(artifact("baseline.yml"))).toContain("claudeCodeVersion: 2.1.301");
  });

  test("a --version banner without a CLI version leaves the version unknown", async () => {
    const noVersion = PASSING.split("\n")
      .map((line) => line.replace(/"claude_code_version":"[^"]*",?/, ""))
      .join("\n");
    const { runner, deps, options } = setup(noVersion);
    runner.on("claude", () => ({ stdout: "warning: update 9.9.9 available\n" }));
    expect((await runSuite(loadedSuite(), options, deps)).claude.version).toBeUndefined();
    runner.on("claude", () => ({ stdout: "notice\n2.1.301 (Claude Code)\n" }));
    expect((await runSuite(loadedSuite(), options, deps)).claude.version).toBe("2.1.301");
  });

  test("the version the stream reports wins over a wrapper's own --version", async () => {
    const { runner, deps, options } = setup(PASSING);
    runner.on("claude", () => ({ stdout: "1.0.0 (team-wrapper)\n" }));
    const result = await runSuite(loadedSuite(), options, deps);
    expect(result.claude.version).toBe("2.1.301");
  });

  test("a pass whose model was never observed writes no baseline", async () => {
    const noModel = PASSING.split("\n")
      .map((line) => line.replace(/"model":"[^"]*",?/g, ""))
      .join("\n");
    const { fs, logs, deps, options } = setup(noModel);
    const result = await runSuite(loadedSuite(), options, deps);
    expect(result.comparison.verdict).toBe("passed");
    expect(result.claude.observedModel).toBeUndefined();
    expect(fs.exists(artifact("baseline.yml"))).toBe(false);
    expect(logs).toContain(
      "[demo] passed, but the model fingerprint is unknown; no baseline.yml written",
    );
  });

  test("the Claude version is probed before preflight touches the device", async () => {
    const { runner, deps, options } = setup(PASSING);
    await runSuite(loadedSuite(), options, deps);
    const order = runner.calls.map((call) =>
      call.command === "claude" ? "version" : call.args.join(" "),
    );
    expect(order.indexOf("version")).toBeLessThan(
      order.findIndex((call) => call.includes("pm clear")),
    );
  });

  test("a pass with no Claude Code version from either source writes no baseline", async () => {
    const noVersion = PASSING.split("\n")
      .map((line) => line.replace(/"claude_code_version":"[^"]*",?/, ""))
      .join("\n");
    const { fs, logs, runner, deps, options } = setup(noVersion);
    runner.on("claude", () => ({ exitCode: 1 }));
    const result = await runSuite(loadedSuite(), options, deps);
    expect(result.comparison.verdict).toBe("passed");
    expect(result.claude.version).toBeUndefined();
    expect(fs.exists(artifact("baseline.yml"))).toBe(false);
    expect(logs).toContain(
      "[demo] passed, but the Claude Code version fingerprint is unknown; no baseline.yml written",
    );
  });

  test("a pass without clearing app data writes no baseline snippet", async () => {
    const { fs, logs, deps, options } = setup(PASSING);
    const suite = loadedSuite({
      preflight: { launchUri: "example:start", settleSeconds: 3, clearAppData: false },
    });
    const result = await runSuite(suite, options, deps);
    expect(result.comparison.verdict).toBe("passed");
    expect(fs.exists(artifact("baseline.yml"))).toBe(false);
    expect(logs).toContain("[demo] passed, but clearAppData is false; no baseline.yml written");
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
          : { handOff: () => undefined, reclaim: async () => undefined, release: () => undefined },
    };
    await expect(runSuite(loadedSuite(), options, deps)).rejects.toThrow(
      /emulator-5554 is claimed by another AutoMobile session \(pid 4242\)/,
    );
    expect(runner.adbCalls()).toEqual(["devices"]);
    expect(launches).toHaveLength(0);
    expect(fs.dirs.size).toBe(0);
  });
});
