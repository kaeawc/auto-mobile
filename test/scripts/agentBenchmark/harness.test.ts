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
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeCommandRunner } from "./fakeCommandRunner";
import { TranscriptBuilder } from "./transcriptBuilder";

const START_MS = Date.UTC(2026, 9, 16, 1, 2, 3);
const DEVICES = "List of devices attached\nemulator-5554\tdevice\n";
const SCREEN = '<hierarchy><node text="Expected count: 3"/><node text="A &amp; B"/></hierarchy>';
// The harness builds paths with path.join, so expectations do too (Windows unit lane).
const RUN_DIR = join("/out", "demo", "20261016T010203Z");
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
    .onAdb("uiautomator", { stdout: SCREEN })
    .on("claude", () => ({ stdout: "2.1.301 (Claude Code)\n" }));
  const launches: ClaudeLaunchSpec[] = [];
  const logs: string[] = [];
  const deps: HarnessDeps = {
    runner,
    timer,
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
    expect(launch.cwd).toBe(RUN_DIR);
    expect(launch.stdin).toBe("Do it on emulator-5554.");
    expect(launch.args).toContain("suite-model");
    expect(launch.timeoutMs).toBe(60_000);
    expect(launch.env).toEqual({
      PATH: "/bin",
      AUTOMOBILE_AGENT_BENCH_SERIAL: "emulator-5554",
      AUTOMOBILE_AGENT_BENCH_RUN_DIR: RUN_DIR,
    });

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
    expect(fs.removed).toEqual(["/tmp/amb-test"]);
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
    expect(fs.removed).toEqual(["/tmp/amb-test"]);
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
});
