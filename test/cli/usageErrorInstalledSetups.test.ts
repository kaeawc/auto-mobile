import { SafeDaemonManager as DaemonManager } from "../fakes/SafeDaemonManager";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "../../src/cli/parseArgs";

import { DaemonLauncher } from "../../src/daemon/DaemonLauncher";
import type { DaemonLaunchCommand } from "../../src/daemon/DaemonLauncher";
import type { DaemonProcessSpawner } from "../../src/daemon/manager";
import type { DaemonOptions } from "../../src/daemon/types";
import { EVENT_ALL_MARKERS_ENV } from "../../src/utils/eventAllMarkers";
import { FakeTimer } from "../fakes/FakeTimer";

const invocationError = (args: string[]) =>
  parseArgs(args, { warn: () => {} }, {}).invalidInvocation;

// Issue #10132: main exits 1 when parseArgs reports a stray word. Pin the
// installed launchers so this guard cannot mistake a real launch value for a command.
// pins the argv every launcher in the repo really produces: the argv the daemon
// manager spawns its child with (built by the real DaemonManager with every option
// set) and every argv in the MCP client config templates, docs and container
// entrypoints. A new launcher flag whose value looks like a stray word fails here.

const repoRoot = join(import.meta.dir, "..", "..");

function readRepoFile(relativePath: string): string {
  // Normalise CRLF: a Windows checkout with autocrlf converts shell scripts.
  return readFileSync(join(repoRoot, relativePath), "utf-8").replaceAll("\r\n", "\n");
}

/** The argv the process sees: everything after the runtime and the entry script. */
function childArgv(spawnArgs: string[]): string[] {
  const modeIndex = spawnArgs.indexOf("--daemon-mode");
  expect(modeIndex).toBeGreaterThanOrEqual(0);
  return spawnArgs.slice(modeIndex);
}

describe("daemon child process argv (src/daemon/manager.ts withDaemonOptions)", () => {
  const tempDirs: string[] = [];
  let previousEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    previousEnv = {
      AUTOMOBILE_DATA_DIR: process.env.AUTOMOBILE_DATA_DIR,
      [EVENT_ALL_MARKERS_ENV]: process.env[EVENT_ALL_MARKERS_ENV],
    };
  });

  afterEach(() => {
    // Preserve preload isolation and explicit overrides for the next suite.
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  // Runs the real DaemonManager.start against a fake spawner and returns the args it
  // handed to spawn(). Nothing is spawned and no daemon is contacted.
  async function spawnedArgs(
    options: DaemonOptions,
    resolveLaunch: () => DaemonLaunchCommand = () => ({
      command: "auto-mobile",
      args: ["--daemon-mode"],
    }),
  ): Promise<string[]> {
    const stateDir = mkdtempSync(join(tmpdir(), "usage-error-spawn-argv-"));
    tempDirs.push(stateDir);
    process.env.AUTOMOBILE_DATA_DIR = stateDir;

    let captured: string[] | undefined;
    const processSpawner: DaemonProcessSpawner = {
      spawn: (_command: string, args: string[], _options: SpawnOptions) => {
        captured = [...args];
        return {
          unref() {},
          once() {
            return this;
          },
          off() {
            return this;
          },
        } as ChildProcess;
      },
    };

    let statusCalls = 0;
    class TestDaemonManager extends DaemonManager {
      override findAllDaemonProcesses(): number[] {
        return [];
      }
      override async status(): Promise<any> {
        statusCalls++;
        return statusCalls === 1
          ? { running: false }
          : { running: true, pid: 1234, port: 31847, socketPath: join(stateDir, "daemon.sock") };
      }
      override async waitForReady(_timeout: number): Promise<boolean> {
        return true;
      }
    }

    const manager = new TestDaemonManager(
      undefined,
      undefined,
      new FakeTimer(),
      join(stateDir, "daemon.lock"),
      join(stateDir, "daemon.pid"),
      join(stateDir, "daemon.sock"),
      undefined,
      processSpawner,
      undefined,
      resolveLaunch,
    );
    await manager.start(options);
    expect(captured).toBeDefined();
    return captured ?? [];
  }

  // Every DaemonOptions field withDaemonOptions serializes, set at once so every
  // value-taking flag is followed by a bare-word value.
  const everyOption: DaemonOptions = {
    port: 9164,
    host: "127.0.0.1",
    strictPort: true,
    debug: true,
    debugPerf: true,
    planExecutionLockScope: "global",
    runnerReadinessTimeoutMs: 45000,
    videoQualityPreset: "balanced",
    videoTargetBitrateKbps: 2500,
    videoMaxThroughputMbps: 12,
    videoFps: 30,
    videoFormat: "mp4",
    videoMaxArchiveSizeMb: 512,
    networkMockable: true,
    embeddedSdk: true,
    enabledTools: ["clipboard", "sqlQuery"],
    disabledTools: ["observe"],
    dismissKeyboardAfterInput: true,
    eventAllMarkers: ["@", "/"],
    noUiPerfMode: true,
    noNavigationScreenshots: true,
    noWaitForPollingOverhead: true,
    noOcclusion: true,
    noA11yIncludeNotImportantViews: true,
    noA11yReportViewIds: true,
    noA11yRetrieveInteractiveWindows: true,
    memPerfAudit: true,
    accessibilityAudit: true,
    accessibilityLevel: "AA",
    accessibilityFailureMode: "report",
    accessibilityMinSeverity: "warning",
    accessibilityUseBaseline: true,
    predictiveUi: true,
    rawElementSearch: true,
    skipCtrlProxyDownload: true,
    mcpRecording: true,
    observeResultIncludeElements: true,
    toolResultsNoStructuredContent: true,
    actionsDiffObserve: true,
    actionsNoObserve: true,
    actionsCompactMetadata: true,
  };

  test("a daemon started with every option set produces no usage error", async () => {
    const args = await spawnedArgs(everyOption);

    // The test is only meaningful if the real manager serialized the options.
    expect(args).toContain("--port");
    expect(args).toContain("--enable-tool");
    expect(args).toContain("--a11y-level");
    // Connection-scoped presentation options never reach the shared daemon (#10377).
    expect(args).not.toContain("--actions-compact-metadata");
    expect(args).not.toContain("--tool-results-no-structured-content");
    expect(invocationError(childArgv(args))).toBeUndefined();
  });

  test("the empty-marker override form (--event-all-markers=) produces no usage error", async () => {
    const args = await spawnedArgs({ eventAllMarkersCliOverride: true });

    expect(args.some((arg) => arg.startsWith("--event-all-markers="))).toBe(true);
    expect(invocationError(childArgv(args))).toBeUndefined();
  });

  test("the default start (no options) produces no usage error", async () => {
    const args = await spawnedArgs({});

    expect(args[0]).toBe("--daemon-mode");
    expect(invocationError(childArgv(args))).toBeUndefined();
  });

  test.each([
    ["local entry script", { entryScript: "/repo/dist/src/index.js", version: "0.0.83" }],
    [
      "bunx on PATH",
      {
        entryScript: null,
        version: "0.0.83",
        environment: { PATH: "/opt/bin" },
        platform: "darwin" as const,
        executableExists: (path: string) => path === "/opt/bin/bunx",
      },
    ],
    [
      "bun x fallback",
      {
        entryScript: null,
        version: "0.0.83",
        environment: { PATH: "/opt/bin" },
        platform: "darwin" as const,
        executableExists: () => false,
      },
    ],
  ])("launcher variant %s: the child argv has no usage error", async (_label, dependencies) => {
    const launcher = new DaemonLauncher(dependencies);
    const args = await spawnedArgs(everyOption, () => launcher.resolveCommand());

    // Everything before --daemon-mode is consumed by the runtime / package runner
    // (`bun`, `bunx -y`, `bun x -y <spec>`), never by this process.
    expect(invocationError(childArgv(args))).toBeUndefined();
  });

  test("the child argv is exactly what a stray word would break: a bare word makes it fail", async () => {
    const args = await spawnedArgs({ port: 9164 });

    expect(invocationError([...childArgv(args), "extra"])).toContain("Unexpected argument: extra");
  });
});

describe("MCP client config templates and entrypoints", () => {
  // The package specifier is consumed by bunx/npx; only what follows reaches main().
  const PACKAGE_SPECIFIER = "@kaeawc/auto-mobile@latest";

  test("scripts/install.sh generators (JSON, TOML, YAML) only emit flags that pass the check", () => {
    const install = readRepoFile("scripts/install.sh");
    const start = install.indexOf("generate_auto_mobile_config() {");
    const yamlStart = install.indexOf("generate_auto_mobile_config_yaml() {");
    const end = install.indexOf("\n}\n", yamlStart);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const generators = install.slice(start, end);

    // Quoted argv elements as they appear in the three generator formats.
    const elements = [...generators.matchAll(/"([^"\n]+)"/g)]
      .map((match) => match[1])
      .filter((element) => element.startsWith("@kaeawc/") || element.startsWith("--"));
    const flags = [...new Set(elements.filter((element) => element.startsWith("--")))].sort();

    expect(elements.some((element) => element === PACKAGE_SPECIFIER)).toBe(true);
    // The only extra argv any preset adds. A new entry must be added to this pin
    // deliberately, after checking it against invocationError.
    expect(flags).toEqual(["--debug", "--debug-perf"]);
    expect(invocationError([])).toBeUndefined();
    expect(invocationError(flags)).toBeUndefined();
    expect(invocationError(["--debug", "--debug-perf"])).toBeUndefined();
  });

  test(".claude-plugin/plugin.json launches the server with no argv after the package", () => {
    const plugin = JSON.parse(readRepoFile(".claude-plugin/plugin.json")) as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };
    const server = plugin.mcpServers["auto-mobile"];

    expect(server.command).toBe("bunx");
    expect(server.args).toEqual([PACKAGE_SPECIFIER]);
    expect(invocationError(server.args.slice(1))).toBeUndefined();
  });

  test("docs/index.md manual MCP configuration launches the server with no argv", () => {
    const docs = readRepoFile("docs/index.md");
    const block = docs.match(/"command": "bunx",\s*"args": (\[[^\]]*\])/);
    expect(block).not.toBeNull();
    const args = JSON.parse(block![1]) as string[];

    expect(args).toEqual([PACKAGE_SPECIFIER]);
    expect(invocationError(args.slice(1))).toBeUndefined();
  });

  test("docs/using/dynamic-tools.md documents --enable-tool/--disable-tool launches", () => {
    const docs = readRepoFile("docs/using/dynamic-tools.md");
    const invocations = docs
      .split("\n")
      .filter((line) => line.startsWith("auto-mobile --"))
      .map((line) => line.trim().split(/\s+/).slice(1));

    expect(invocations).toContainEqual(["--enable-tool", "clipboard", "--enable-tool", "sqlQuery"]);
    expect(invocations).toContainEqual(["--disable-tool", "observe"]);
    for (const argv of invocations) {
      expect(invocationError(argv)).toBeUndefined();
    }
  });

  test("the Dockerfile entrypoints start the stdio server with no argv", () => {
    const dockerfile = readRepoFile("Dockerfile");
    const commands = [...dockerfile.matchAll(/^CMD (\[.*\])$/gm)].map(
      (match) => JSON.parse(match[1]) as string[],
    );

    expect(commands).toContainEqual(["bun", "dist/src/index.js"]);
    expect(commands).toContainEqual(["bun", "--watch", "src/index.ts"]);
    // After the runtime flags and the entry script nothing remains.
    expect(invocationError([])).toBeUndefined();
  });

  describe("external launchers that name a mode flag first", () => {
    // Pinned from the Android junit-runner module's DaemonSocketClient.kt (buildDaemonCommand
    // and its .withX() option appends), the Android desktop-core module's
    // DesktopDaemonLifecycle.kt, the iOS XCTestRunner's DaemonManager+Launch.swift,
    // scripts/install.sh (AUTO_MOBILE_CMD) and docs: `<runner> <package> --daemon <subcommand> [flags]` and `--cli <tool> ...`.
    const launcherArgv: Array<[string, string[]]> = [
      ["--daemon start", ["--daemon", "start"]],
      ["--daemon restart", ["--daemon", "restart"]],
      ["--daemon health", ["--daemon", "health"]],
      ["--daemon stop", ["--daemon", "stop"]],
      ["--daemon status", ["--daemon", "status"]],
      [
        "--daemon start with appended option flags",
        [
          "--daemon",
          "start",
          "--dismiss-keyboard-after-input",
          "--no-ui-perf-mode",
          "--no-navigation-screenshots",
          "--no-waitfor-polling-overhead",
          "--no-include-not-important-views",
          "--no-report-view-ids",
          "--no-retrieve-interactive-windows",
          "--network-mockable",
        ],
      ],
      ["--cli help", ["--cli", "help"]],
      ["--cli doctor", ["--cli", "doctor"]],
      ["--cli doctor --json", ["--cli", "doctor", "--json"]],
      ["--cli with a tool and parameters", ["--cli", "observe", "--platform", "android"]],
      [
        "embedded sdk flags before --cli",
        ["--embedded-sdk", "--network-mockable", "--cli", "observe"],
      ],
    ];

    test.each(launcherArgv)("%s", (_label, argv) => {
      expect(invocationError(argv)).toBeUndefined();
    });
  });
});
