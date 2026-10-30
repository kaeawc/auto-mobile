/**
 * Orchestrate one agent benchmark suite run.
 *
 * Measurement boundary: `wallClockSeconds` starts when the harness spawns Claude
 * and stops when Claude exits. Device preflight, the post-run screen dump, and
 * private-daemon teardown all happen outside it. Tool-call counts come only from
 * Claude's stream-json transcript.
 */
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { IdGenerator } from "../../src/utils/IdGenerator";
import type { Timer } from "../../src/utils/SystemTimer";
import { errorMessage } from "../../src/utils/describeUnknownError";
import { compareRun, containsBounded } from "./compare";
import type { LoadedSuite } from "./config";
import {
  bootedIosSimulators,
  captureScreen,
  describeDevice,
  resolveSerial,
  runPreflight,
  screenTextForApp,
  type CommandRunner,
} from "./device";
import {
  buildClaudeArgs,
  buildMcpConfig,
  claudeLaunchEnv,
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
  /** Hex SHA-256 of a file's bytes. */
  sha256(path: string): string;
}

/** A device this benchmark holds: its daemon allocation claim plus a benchmark-only lock. */
export interface DeviceReservation {
  /** Drop the daemon allocation claim so the run's private daemon can take it. */
  handOff(): void;
  /**
   * Take the daemon allocation claim back after the private daemon stopped, so nothing
   * else drives the device during the post-run screen dump. Returns why it could not.
   */
  reclaim(): Promise<string | undefined>;
  /** Drop everything, including the benchmark lock that keeps other benchmarks off. */
  release(): void;
}

/** Device allocation claims, under the same ownership rules every AutoMobile daemon applies. */
export interface DeviceClaims {
  /** Reserve `serial` for this benchmark, or explain who holds it. */
  reserve(serial: string): Promise<DeviceReservation | { refused: string }>;
}

export interface HarnessDeps {
  runner: CommandRunner;
  launcher: ClaudeLauncher;
  timer: Timer;
  /** Suffixes run directories so same-second runs of one suite never share one. */
  idGenerator: IdGenerator;
  deviceClaims: DeviceClaims;
  fs: HarnessFs;
  /** Progress lines; the CLI sends these to stderr so `--json` stdout stays clean. */
  log(line: string): void;
  env: Record<string, string | undefined>;
  /** Host OS; only macOS can have iOS simulators or devices for the daemon to discover. */
  platform: NodeJS.Platform;
  /**
   * Connected physical iOS devices. `simctl` sees only simulators, but the private daemon
   * also discovers hardware through devicectl; either would make selection ambiguous.
   * `complete: false` means the sweep failed, so absence is unproven.
   */
  physicalIosDevices(): Promise<{ names: string[]; complete: boolean }>;
}

export interface RunOptions {
  outputRoot: string;
  runtime: string;
  serverEntry: string;
  /**
   * Digest of what executes and measures the run: the built server (`dist/`, with the
   * sidecars it loads at runtime), `bun.lock`, `package.json`, the harness sources, and the
   * Bun version. A stale or different build, or changed scoring code, reads as different.
   */
  serverBuild: string;
  claudeCommand: string;
  deviceSerial?: string;
  modelOverride?: string;
  /** Arm B of the instructions A/B: the MCP config turns on the server's instructions block. */
  serverInstructions?: boolean;
}

/**
 * A digest of what the agent was asked to do and how: the raw prompt, every suite setting
 * except the recorded baseline itself, and the requested model. A baseline taken under a
 * different digest measured a different task, so its deltas are flagged.
 */
export function suiteDigest(suite: LoadedSuite, modelOverride?: string): string {
  // The suite's own (repo-relative) app.apkPath is in the settings; the resolved absolute
  // path is not, so operators with different checkouts get the same digest.
  const settings = Object.fromEntries(
    Object.entries(suite.definition).filter(
      ([key]) => key !== "baseline" && key !== "baselineToolSequence",
    ),
  );
  const subject = JSON.stringify({
    prompt: suite.prompt,
    settings,
    model: modelOverride ?? suite.definition.claude.model ?? null,
  });
  return createHash("sha256").update(subject).digest("hex").slice(0, 16);
}

/** Elapsed-time reading: monotonic when the timer has one, so a clock step cannot skew it. */
function elapsedNow(timer: Timer): number {
  return timer.monotonicNow?.() ?? timer.now();
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
    // "2.1.301 (Claude Code)" -> "2.1.301", the form the stream's init event reports.
    // Only the CLI's own "X.Y.Z (Claude Code)" line, or a bare version, counts: a wrapper
    // banner or warning must leave the version unknown rather than fingerprint as one.
    const version = result.stdout.match(/^\s*(\d+\.\d+\.\d+)(?:\s+\(Claude Code\))?\s*$/m)?.[1];
    return result.exitCode === 0 ? version : undefined;
  } catch (error) {
    // The version is report metadata only; a missing CLI fails loudly at launch instead.
    deps.log(`claude --version failed: ${errorMessage(error)}`);
    return undefined;
  }
}

/** Reclaim attempts while a daemon whose stop failed exits on its orphan idle window. */
const RECLAIM_RETRIES = 10;
const RECLAIM_RETRY_MS = 1_000;

/** Stops the run's private daemon; false when the stop did not confirm it exited. */
async function stopPrivateDaemon(
  deps: HarnessDeps,
  options: RunOptions,
  paths: ServerPaths,
): Promise<boolean> {
  // The same sanitized environment as the run, so an inherited socket or PID override
  // can never point this stop at the resident daemon.
  const env = isolatedServerEnv(deps.env, paths, deps.platform);
  try {
    const result = await deps.runner.run(
      options.runtime,
      [options.serverEntry, "--daemon", "stop"],
      DAEMON_STOP_TIMEOUT_MS,
      env,
    );
    if (result.exitCode !== 0) {
      deps.log(`private daemon stop exited ${result.exitCode}: ${result.stderr.trim()}`);
      return false;
    }
    return true;
  } catch (error) {
    // Best effort: the daemon also exits on its own after the orphan idle window.
    deps.log(`private daemon stop failed: ${errorMessage(error)}`);
    return false;
  }
}

/**
 * Takes the device claim back after the run. When the daemon's stop was not confirmed it may
 * still hold its claim until its orphan idle window ends, so a refusal is retried for a
 * bounded time instead of failing the paid run's screen check at once.
 */
async function reclaimAfterRun(
  deps: HarnessDeps,
  run: PreparedRun,
  daemonStopConfirmed: boolean,
): Promise<string | undefined> {
  let refused = await run.reservation.reclaim();
  for (let attempt = 0; refused && !daemonStopConfirmed && attempt < RECLAIM_RETRIES; attempt++) {
    await deps.timer.sleep(RECLAIM_RETRY_MS);
    refused = await run.reservation.reclaim();
  }
  return refused;
}

async function screenAfterRun(
  deps: HarnessDeps,
  run: PreparedRun,
  packageName: string,
  daemonStopConfirmed: boolean,
) {
  // The private daemon released its claim on stop; another session could take the device
  // before the dump, so the screen read must happen under the benchmark's own claim again.
  let refused: string | undefined;
  try {
    refused = await reclaimAfterRun(deps, run, daemonStopConfirmed);
  } catch (error) {
    // The run is already paid for: fail the screen check closed but still write the result.
    deps.log(`post-run screen dump skipped: reclaim failed: ${errorMessage(error)}`);
    return { screenError: `could not reclaim ${run.serial}: ${errorMessage(error)}` };
  }
  if (refused) {
    deps.log(`post-run screen dump skipped: ${run.serial} ${refused}`);
    return { screenError: `${run.serial} ${refused} after the run; the screen was not read` };
  }
  try {
    const xml = await captureScreen(deps.runner, run.serial);
    deps.fs.writeFile(join(run.runDirectory, "screen.xml"), xml);
    return { screenText: await screenTextForApp(xml, packageName) };
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
  /** The reservation held through preflight; handOff and release are idempotent. */
  reservation: RunReservation;
}

type RunReservation = Pick<DeviceReservation, "handOff" | "release" | "reclaim">;

async function prepare(suite: LoadedSuite, options: RunOptions, deps: HarnessDeps) {
  const serial = await resolveSerial(deps.runner, options.deviceSerial);
  const simulators = await bootedIosSimulators(deps.runner, deps.platform);
  if (simulators.length > 0) {
    throw new Error(
      `Booted iOS simulator(s) (${simulators.join(", ")}) would also be visible to the ` +
        "benchmark's AutoMobile server and make device selection ambiguous; shut them down first.",
    );
  }
  const phones = await deps.physicalIosDevices();
  if (phones.names.length > 0) {
    throw new Error(
      `Connected iOS device(s) (${phones.names.join(", ")}) would also be visible to the ` +
        "benchmark's AutoMobile server and make device selection ambiguous; disconnect them first.",
    );
  }
  if (!phones.complete) {
    // A later successful sweep by the daemon could still find one after preflight ran.
    throw new Error(
      "Could not list connected iOS devices (devicectl failed); the benchmark needs to know " +
        "none is connected, so fix devicectl before running.",
    );
  }
  // Preflight clears app data, so hold this device's allocation claim through it: another
  // AutoMobile session (or a concurrent benchmark) is refused instead of racing it.
  // launchClaude releases it just before the run's own private daemon needs to claim it.
  const reservation = await deps.deviceClaims.reserve(serial);
  if ("refused" in reservation) {
    throw new Error(`${serial} ${reservation.refused}; stop it before benchmarking.`);
  }
  const release = once(() => reservation.release());
  const handOff = once(() => reservation.handOff());
  try {
    return await prepareReserved(suite, options, deps, serial, {
      handOff,
      release,
      reclaim: () => reservation.reclaim(),
    });
  } catch (error) {
    release();
    throw error;
  }
}

function once(action: () => void): () => void {
  let done = false;
  return () => {
    if (!done) {
      done = true;
      action();
    }
  };
}

async function prepareReserved(
  suite: LoadedSuite,
  options: RunOptions,
  deps: HarnessDeps,
  serial: string,
  reservation: RunReservation,
) {
  const { definition } = suite;
  const startedAt = runTimestamp(deps.timer.now());
  const runId = deps.idGenerator.next().slice(0, 8);
  const runDirectory = join(options.outputRoot, definition.name, `${startedAt}-${runId}`);
  deps.fs.mkdir(runDirectory);
  const preflightStart = elapsedNow(deps.timer);
  deps.log(`[${definition.name}] preflight on ${serial}`);
  const { log, appBuild } = await runPreflight(deps.runner, {
    serial,
    packageName: definition.app.packageName,
    apkPath: suite.apkPath,
    apkDigest: suite.apkPath ? deps.fs.sha256(suite.apkPath) : undefined,
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
  // Fingerprint after the settle, so a deep link that changes orientation is recorded as the
  // state Claude measures, and before verification, so nothing runs between the verified start
  // screen and the measured launch.
  const device = await deviceFingerprint(deps, serial);
  const durationSeconds = (elapsedNow(deps.timer) - preflightStart) / 1000;
  deps.fs.writeFile(join(runDirectory, "preflight.log"), `${log.join("\n")}\n`);
  await verifyStartScreen(suite, deps, serial, runDirectory);
  const { paths, claudeCwd } = allocateRunDirectories(options, deps, runDirectory);
  const prepared: PreparedRun = {
    runDirectory,
    claudeCwd,
    paths,
    serial,
    preflight: { log, durationSeconds, appBuild, device },
    reservation,
  };
  return { startedAt, prepared };
}

/**
 * Confirm preflight landed where the suite expects before paying for a run: a changed
 * preference contract or a redirected deep link would otherwise hand Claude a different
 * starting screen, and its recovery would leak into the baseline.
 */
async function verifyStartScreen(
  suite: LoadedSuite,
  deps: HarnessDeps,
  serial: string,
  runDirectory: string,
) {
  const expected = suite.definition.preflight.startScreenIncludes;
  if (expected.length === 0) {
    return;
  }
  const xml = await captureScreen(deps.runner, serial);
  deps.fs.writeFile(join(runDirectory, "start-screen.xml"), xml);
  const text = await screenTextForApp(xml, suite.definition.app.packageName);
  const missing = expected.filter((needle) => !containsBounded(text, needle));
  if (missing.length > 0) {
    throw new Error(
      `Preflight did not reach the expected start screen (missing: ${missing.join(", ")}); ` +
        `see ${join(runDirectory, "start-screen.xml")}.`,
    );
  }
}

function unknownFingerprints(result: BenchmarkResult): string[] {
  return [
    ...(result.preflight.appBuild === "unknown" ? ["app build"] : []),
    ...(result.preflight.device === "unknown" ? ["device"] : []),
    ...(result.claude.version === undefined ? ["Claude Code version"] : []),
    // Suites without claude.model run the environment's default, so only the observed
    // model can flag a later default change.
    ...(result.claude.observedModel === undefined ? ["model"] : []),
  ];
}

async function deviceFingerprint(deps: HarnessDeps, serial: string): Promise<string> {
  try {
    return await describeDevice(deps.runner, serial);
  } catch (error) {
    // Report metadata only: an unreadable environment is recorded as "unknown", never a match.
    deps.log(`device fingerprint failed: ${errorMessage(error)}`);
    return "unknown";
  }
}

/** Create the run's temp and state directories, removing any already made if one fails. */
function allocateRunDirectories(options: RunOptions, deps: HarnessDeps, runDirectory: string) {
  const tempDirs: string[] = [];
  const makeTempDir = (prefix: string) => {
    const dir = deps.fs.makeTempDir(prefix);
    tempDirs.push(dir);
    return dir;
  };
  try {
    const paths: ServerPaths = {
      runtime: options.runtime,
      serverEntry: options.serverEntry,
      auxSocketDir: makeTempDir("amb-"),
      dataDir: join(runDirectory, "data"),
      dbDir: join(runDirectory, "db"),
      logDir: join(runDirectory, "logs"),
    };
    deps.fs.mkdir(paths.dataDir);
    deps.fs.mkdir(paths.dbDir);
    deps.fs.mkdir(paths.logDir);
    return { paths, claudeCwd: makeTempDir("amb-cwd-") };
  } catch (error) {
    tempDirs.forEach((dir) => deps.fs.remove(dir));
    throw error;
  }
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
  deps.fs.writeFile(
    mcpConfigPath,
    `${JSON.stringify(
      buildMcpConfig(run.paths, deps.env, deps.platform, undefined, {
        instructions: options.serverInstructions,
      }),
      null,
      2,
    )}\n`,
  );
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
  // The private daemon claims the device on Claude's first tool call, so hand the daemon
  // claim over now; the benchmark lock stays held until the run ends.
  run.reservation.handOff();
  deps.log(`[${definition.name}] running claude (timeout ${definition.claude.timeoutSeconds}s)`);
  const start = elapsedNow(deps.timer);
  const exit = await deps.launcher.launch({
    command: options.claudeCommand,
    args,
    cwd: run.claudeCwd,
    env: {
      ...claudeLaunchEnv(deps.env, run.paths, deps.platform),
      // User-level CLAUDE.md, auto-memory, and managed policy skills differ per operator or
      // host; keep runs comparable.
      CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
      CLAUDE_CODE_DISABLE_POLICY_SKILLS: "1",
      AUTOMOBILE_AGENT_BENCH_SERIAL: run.serial,
      AUTOMOBILE_AGENT_BENCH_RUN_DIR: run.runDirectory,
    },
    stdin: prompt,
    stdoutPath: join(run.runDirectory, "claude.jsonl"),
    stderrPath: join(run.runDirectory, "claude.stderr"),
    timeoutMs: definition.claude.timeoutSeconds * 1000,
  });
  return { ...exit, wallClockSeconds: (elapsedNow(deps.timer) - start) / 1000 };
}

export async function runSuite(
  suite: LoadedSuite,
  options: RunOptions,
  deps: HarnessDeps,
): Promise<BenchmarkResult> {
  const { definition } = suite;
  // Probe before preflight: a slow --version wrapper must not stall between the verified
  // start screen and the measured launch.
  const version = await claudeVersion(deps, options.claudeCommand);
  const { startedAt, prepared } = await prepare(suite, options, deps);
  const digest = suiteDigest(suite, options.modelOverride);
  const { serverBuild } = options;
  let exit: Awaited<ReturnType<typeof launchClaude>>;
  let screen: { screenText?: string; screenError?: string } = {};
  let daemonStopped = false;
  try {
    exit = await launchClaude(suite, options, deps, prepared);
    // Stop the private daemon first so its device claim is free for the benchmark to retake.
    const stopConfirmed = await stopPrivateDaemon(deps, options, prepared.paths);
    daemonStopped = true;
    if (definition.verify.screenIncludes.length > 0) {
      screen = await screenAfterRun(deps, prepared, definition.app.packageName, stopConfirmed);
    }
  } finally {
    if (!daemonStopped) {
      await stopPrivateDaemon(deps, options, prepared.paths);
    }
    prepared.reservation.release();
    deps.fs.remove(prepared.paths.auxSocketDir);
    deps.fs.remove(prepared.claudeCwd);
  }
  const transcriptPath = join(prepared.runDirectory, "claude.jsonl");
  const audit = auditTranscript(
    deps.fs.exists(transcriptPath) ? deps.fs.readFile(transcriptPath) : "",
    definition,
  );
  // The init event names the CLI that actually ran; a wrapper's --version may describe
  // itself instead, so the probe is only the fallback when the stream reports none.
  const claudeCodeVersion = audit.claudeCodeVersion ?? version;
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
    suiteDigest: digest,
    serverBuild,
    claude: {
      requestedModel: options.modelOverride ?? definition.claude.model,
      observedModel: audit.observedModel,
      version: claudeCodeVersion,
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
      {
        appBuild: prepared.preflight.appBuild,
        serverBuild,
        suiteDigest: digest,
        claudeCodeVersion,
        deviceFingerprint: prepared.preflight.device,
      },
    ),
  };
  deps.fs.writeFile(
    join(prepared.runDirectory, "result.json"),
    `${JSON.stringify(result, null, 2)}\n`,
  );
  // A run that recovered from stumbles still passes, but its error count and recovery
  // calls would make a misleading baseline; only clean passes produce a snippet.
  if (result.comparison.verdict === "passed" && !definition.preflight.clearAppData) {
    // Without a reset, earlier runs' databases, permissions, and back stack carry over
    // invisibly; the start-screen check sees only text, so the run is not reproducible.
    deps.log(`[${definition.name}] passed, but clearAppData is false; no baseline.yml written`);
  } else if (result.comparison.verdict === "passed" && unknownFingerprints(result).length > 0) {
    // A baseline without these could never flag a later run on another build, device, or CLI.
    deps.log(
      `[${definition.name}] passed, but the ${unknownFingerprints(result).join(" and ")} ` +
        "fingerprint is unknown; no baseline.yml written",
    );
  } else if (result.comparison.verdict === "passed" && result.comparison.stumbles === 0) {
    deps.fs.writeFile(join(prepared.runDirectory, "baseline.yml"), renderBaselineSnippet(result));
  } else if (result.comparison.verdict === "passed") {
    deps.log(
      `[${definition.name}] passed with ${result.comparison.stumbles} stumble(s); no baseline.yml written`,
    );
  }
  return result;
}
