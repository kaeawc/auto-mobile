/**
 * Orchestrate one agent benchmark suite run.
 *
 * Measurement boundary: `wallClockSeconds` starts when the harness spawns Claude
 * and stops when Claude exits. Device preflight, the post-run screen dump, and
 * private-daemon teardown all happen outside it. Tool-call counts come only from
 * Claude's stream-json transcript.
 */
import { join } from "node:path";
import type { IdGenerator } from "../../src/utils/IdGenerator";
import type { Timer } from "../../src/utils/SystemTimer";
import { errorMessage } from "../../src/utils/describeUnknownError";
import { compareRun } from "./compare";
import type { LoadedSuite } from "./config";
import {
  captureScreen,
  decodeXmlEntities,
  resolveSerial,
  runPreflight,
  type CommandRunner,
} from "./device";
import {
  buildClaudeArgs,
  buildMcpConfig,
  fillPlaceholders,
  isolatedServerEnv,
  systemPromptFor,
  type ServerPaths,
} from "./invocation";
import { renderBaselineSnippet } from "./render";
import type { BenchmarkResult } from "./result";
import { auditTranscript } from "./transcript";

const VERSION_TIMEOUT_MS = 30_000;
const DAEMON_STOP_TIMEOUT_MS = 30_000;

export interface ClaudeLaunchSpec {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  stdin: string;
  stdoutPath: string;
  stderrPath: string;
  timeoutMs: number;
}

export interface ClaudeLauncher {
  launch(spec: ClaudeLaunchSpec): Promise<{ exitCode: number | null; timedOut: boolean }>;
}

export interface HarnessFs {
  mkdir(path: string): void;
  writeFile(path: string, content: string): void;
  readFile(path: string): string;
  exists(path: string): boolean;
  /** Create a short private temp directory outside the repository. */
  makeTempDir(prefix: string): string;
  remove(path: string): void;
}

export interface HarnessDeps {
  runner: CommandRunner;
  launcher: ClaudeLauncher;
  timer: Timer;
  /** Suffixes run directories so same-second runs of one suite never share one. */
  idGenerator: IdGenerator;
  fs: HarnessFs;
  /** Progress lines; the CLI sends these to stderr so `--json` stdout stays clean. */
  log(line: string): void;
  env: Record<string, string | undefined>;
}

export interface RunOptions {
  outputRoot: string;
  runtime: string;
  serverEntry: string;
  claudeCommand: string;
  deviceSerial?: string;
  modelOverride?: string;
}

/** `2026-10-16T01:02:03.456Z` → `20261016T010203Z`. */
export function runTimestamp(epochMs: number): string {
  return new Date(epochMs)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
}

async function claudeVersion(deps: HarnessDeps, command: string): Promise<string | undefined> {
  try {
    const result = await deps.runner.run(command, ["--version"], VERSION_TIMEOUT_MS);
    return result.exitCode === 0 ? result.stdout.trim() : undefined;
  } catch (error) {
    // The version is report metadata only; a missing CLI fails loudly at launch instead.
    deps.log(`claude --version failed: ${errorMessage(error)}`);
    return undefined;
  }
}

async function stopPrivateDaemon(deps: HarnessDeps, options: RunOptions, paths: ServerPaths) {
  // The same sanitized environment as the run, so an inherited socket or PID override
  // can never point this stop at the resident daemon.
  const env = isolatedServerEnv(deps.env, paths);
  try {
    const result = await deps.runner.run(
      options.runtime,
      [options.serverEntry, "--daemon", "stop"],
      DAEMON_STOP_TIMEOUT_MS,
      env,
    );
    if (result.exitCode !== 0) {
      deps.log(`private daemon stop exited ${result.exitCode}: ${result.stderr.trim()}`);
    }
  } catch (error) {
    // Best effort: the daemon also exits on its own after the orphan idle window.
    deps.log(`private daemon stop failed: ${errorMessage(error)}`);
  }
}

async function screenAfterRun(deps: HarnessDeps, serial: string, runDirectory: string) {
  try {
    const xml = await captureScreen(deps.runner, serial);
    deps.fs.writeFile(join(runDirectory, "screen.xml"), xml);
    return { screenText: decodeXmlEntities(xml) };
  } catch (error) {
    deps.log(`post-run screen dump failed: ${errorMessage(error)}`);
    return { screenError: errorMessage(error) };
  }
}

interface PreparedRun {
  runDirectory: string;
  /** Claude's cwd: outside the repository so no ancestor CLAUDE.md or skills load. */
  claudeCwd: string;
  paths: ServerPaths;
  serial: string;
  preflight: BenchmarkResult["preflight"];
}

async function prepare(suite: LoadedSuite, options: RunOptions, deps: HarnessDeps) {
  const { definition } = suite;
  const serial = await resolveSerial(deps.runner, options.deviceSerial);
  const startedAt = runTimestamp(deps.timer.now());
  const runId = deps.idGenerator.next().slice(0, 8);
  const runDirectory = join(options.outputRoot, definition.name, `${startedAt}-${runId}`);
  deps.fs.mkdir(runDirectory);
  const preflightStart = deps.timer.now();
  deps.log(`[${definition.name}] preflight on ${serial}`);
  const log = await runPreflight(deps.runner, {
    serial,
    packageName: definition.app.packageName,
    apkPath: suite.apkPath,
    clearAppData: definition.preflight.clearAppData,
    sharedPreferences: definition.preflight.sharedPreferences,
    launchUri: definition.preflight.launchUri,
    stageFile: (name, content) => {
      const path = join(runDirectory, "preflight", name);
      deps.fs.mkdir(join(runDirectory, "preflight"));
      deps.fs.writeFile(path, content);
      return path;
    },
  });
  await deps.timer.sleep(definition.preflight.settleSeconds * 1000);
  const durationSeconds = (deps.timer.now() - preflightStart) / 1000;
  deps.fs.writeFile(join(runDirectory, "preflight.log"), `${log.join("\n")}\n`);
  const paths: ServerPaths = {
    runtime: options.runtime,
    serverEntry: options.serverEntry,
    auxSocketDir: deps.fs.makeTempDir("amb-"),
    dbDir: join(runDirectory, "db"),
    logDir: join(runDirectory, "logs"),
  };
  deps.fs.mkdir(paths.dbDir);
  deps.fs.mkdir(paths.logDir);
  const prepared: PreparedRun = {
    runDirectory,
    claudeCwd: deps.fs.makeTempDir("amb-cwd-"),
    paths,
    serial,
    preflight: { log, durationSeconds },
  };
  return { startedAt, prepared };
}

async function launchClaude(
  suite: LoadedSuite,
  options: RunOptions,
  deps: HarnessDeps,
  run: PreparedRun,
) {
  const { definition } = suite;
  const placeholders = {
    deviceSerial: run.serial,
    packageName: definition.app.packageName,
    runDirectory: run.runDirectory,
  };
  const mcpConfigPath = join(run.runDirectory, "mcp-config.json");
  deps.fs.writeFile(mcpConfigPath, `${JSON.stringify(buildMcpConfig(run.paths), null, 2)}\n`);
  const prompt = fillPlaceholders(suite.prompt, placeholders);
  deps.fs.writeFile(join(run.runDirectory, "prompt.md"), prompt);
  const args = buildClaudeArgs(
    definition,
    mcpConfigPath,
    systemPromptFor(definition, placeholders),
    options.modelOverride,
  );
  deps.fs.writeFile(
    join(run.runDirectory, "claude-command.json"),
    `${JSON.stringify({ command: options.claudeCommand, args, cwd: run.claudeCwd }, null, 2)}\n`,
  );
  deps.log(`[${definition.name}] running claude (timeout ${definition.claude.timeoutSeconds}s)`);
  const start = deps.timer.now();
  const exit = await deps.launcher.launch({
    command: options.claudeCommand,
    args,
    cwd: run.claudeCwd,
    env: {
      ...isolatedServerEnv(deps.env, run.paths),
      AUTOMOBILE_AGENT_BENCH_SERIAL: run.serial,
      AUTOMOBILE_AGENT_BENCH_RUN_DIR: run.runDirectory,
    },
    stdin: prompt,
    stdoutPath: join(run.runDirectory, "claude.jsonl"),
    stderrPath: join(run.runDirectory, "claude.stderr"),
    timeoutMs: definition.claude.timeoutSeconds * 1000,
  });
  return { ...exit, wallClockSeconds: (deps.timer.now() - start) / 1000 };
}

export async function runSuite(
  suite: LoadedSuite,
  options: RunOptions,
  deps: HarnessDeps,
): Promise<BenchmarkResult> {
  const { definition } = suite;
  const { startedAt, prepared } = await prepare(suite, options, deps);
  const version = await claudeVersion(deps, options.claudeCommand);
  let exit: Awaited<ReturnType<typeof launchClaude>>;
  let screen: { screenText?: string; screenError?: string } = {};
  try {
    exit = await launchClaude(suite, options, deps, prepared);
    if (definition.verify.screenIncludes.length > 0) {
      screen = await screenAfterRun(deps, prepared.serial, prepared.runDirectory);
    }
  } finally {
    await stopPrivateDaemon(deps, options, prepared.paths);
    deps.fs.remove(prepared.paths.auxSocketDir);
    deps.fs.remove(prepared.claudeCwd);
  }
  const transcriptPath = join(prepared.runDirectory, "claude.jsonl");
  const audit = auditTranscript(
    deps.fs.exists(transcriptPath) ? deps.fs.readFile(transcriptPath) : "",
    definition,
  );
  const outcome = {
    claudeExitCode: exit.exitCode,
    timedOut: exit.timedOut,
    wallClockSeconds: Math.round(exit.wallClockSeconds * 100) / 100,
    ...screen,
  };
  const result: BenchmarkResult = {
    suite: definition.name,
    suitePath: suite.suitePath,
    runDirectory: prepared.runDirectory,
    startedAt,
    deviceSerial: prepared.serial,
    claude: {
      requestedModel: options.modelOverride ?? definition.claude.model,
      observedModel: audit.observedModel,
      version,
    },
    preflight: prepared.preflight,
    outcome,
    audit,
    comparison: compareRun(
      audit,
      outcome,
      definition.verify,
      definition.baseline,
      definition.baselineToolSequence,
    ),
  };
  deps.fs.writeFile(
    join(prepared.runDirectory, "result.json"),
    `${JSON.stringify(result, null, 2)}\n`,
  );
  if (result.comparison.verdict === "passed") {
    deps.fs.writeFile(join(prepared.runDirectory, "baseline.yml"), renderBaselineSnippet(result));
  }
  return result;
}
