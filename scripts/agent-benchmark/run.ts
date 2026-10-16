#!/usr/bin/env bun
/**
 * Agent UI benchmark: run Claude Code against the auto-mobile MCP server on a
 * real Android device and audit how it did. Local/manual only — it launches
 * Claude (API cost) and drives a device, so it is never part of the unit suite.
 *
 * Usage:
 *   bun scripts/agent-benchmark/run.ts --suite <name|path.yml> [--suite ...]
 *   bun scripts/agent-benchmark/run.ts --all
 *   bun scripts/agent-benchmark/run.ts --from-result <run-dir|result.json> [...]
 *
 * Options:
 *   --device <serial>   target device (default: the single online device)
 *   --model <model>     override the suite's claude.model for a controlled comparison
 *   --json              print BenchmarkResult JSON (an array for several runs) on stdout
 *   --dry-run           validate suites and print the claude invocation; no device, no API
 *   --claude <command>  Claude Code executable (default: claude)
 *   --output <dir>      artifact root (default: scratch/agent-benchmarks)
 *
 * Exit codes: 0 every run passed; 1 a run failed or was incomplete; 2 usage error.
 * See docs/using/agent-benchmarks.md.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { familySync } from "detect-libc";
import {
  ForwardLeaseForeignDeviceOwnership,
  deviceAllocationClaimPath,
} from "../../src/daemon/foreignDeviceOwnership";
import { createForeignCtrlProxyForwardEvidence } from "../../src/features/observe/android/foreignCtrlProxyForwardEvidence";
import { errorMessage } from "../../src/utils/describeUnknownError";
import { resolveAndroidSdkRoot } from "../../src/utils/android-cmdline-tools/androidSdkRoot";
import { getSharedDevicectlDeviceLister } from "../../src/utils/ios-cmdline-tools/DevicectlDeviceLister";
import {
  readExclusiveLockContent,
  releaseExclusiveLock,
  tryAcquireExclusiveLock,
} from "../../src/utils/fileLock";
import { defaultIdGenerator } from "../../src/utils/IdGenerator";
import { defaultTimer, type Timer } from "../../src/utils/SystemTimer";
import { loadSuite, type LoadedSuite } from "./config";
import type { CommandRunner } from "./device";
import {
  runSuite,
  type ClaudeLauncher,
  type DeviceClaims,
  type HarnessDeps,
  type HarnessFs,
} from "./harness";
import { buildClaudeArgs, buildMcpConfig, providerIdentity, systemPromptFor } from "./invocation";
import { renderReport, renderSummary } from "./render";
import type { BenchmarkResult } from "./result";

const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
export const SUITES_DIR = join(REPO_ROOT, "benchmark", "agent", "suites");
const KILL_GRACE_MS = 10_000;

export interface CliOptions {
  suites: string[];
  all: boolean;
  fromResults: string[];
  device?: string;
  model?: string;
  json: boolean;
  dryRun: boolean;
  claude: string;
  output: string;
  help: boolean;
}

const VALUE_FLAGS = new Set([
  "--suite",
  "--from-result",
  "--device",
  "--model",
  "--claude",
  "--output",
]);

export function parseCliArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    suites: [],
    all: false,
    fromResults: [],
    json: false,
    dryRun: false,
    claude: "claude",
    output: join(REPO_ROOT, "scratch", "agent-benchmarks"),
    help: false,
  };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (VALUE_FLAGS.has(flag)) {
      const value = argv[++index];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`${flag} needs a value`);
      }
      applyValueFlag(options, flag, value);
      continue;
    }
    switch (flag) {
      case "--all":
        options.all = true;
        break;
      case "--json":
        options.json = true;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${flag}`);
    }
  }
  const modes = [options.suites.length > 0, options.all, options.fromResults.length > 0];
  if (!options.help && modes.filter(Boolean).length !== 1) {
    // --all with --suite would silently drop the named suite, so the modes are exclusive.
    throw new Error("Pass one of --suite, --all, or --from-result.");
  }
  return options;
}

function applyValueFlag(options: CliOptions, flag: string, value: string): void {
  switch (flag) {
    case "--suite":
      options.suites.push(value);
      return;
    case "--from-result":
      options.fromResults.push(value);
      return;
    case "--device":
      options.device = value;
      return;
    case "--model":
      options.model = value;
      return;
    case "--claude":
      // Claude runs from a temp cwd, so a relative path must be resolved here; a bare name
      // is left for PATH lookup.
      options.claude = /[\\/]/.test(value) ? resolve(value) : value;
      return;
    default:
      options.output = resolve(value);
  }
}

/** `bug-repro` → `<suites dir>/bug-repro.yml`; anything with a `.yml`/`.yaml` suffix is a path. */
export function resolveSuitePath(nameOrPath: string, suitesDir: string = SUITES_DIR): string {
  return /\.ya?ml$/.test(nameOrPath) ? resolve(nameOrPath) : join(suitesDir, `${nameOrPath}.yml`);
}

function suitePaths(options: CliOptions): string[] {
  if (!options.all) {
    return options.suites.map((suite) => resolveSuitePath(suite));
  }
  return readdirSync(SUITES_DIR)
    .filter((file) => /\.ya?ml$/.test(file))
    .sort()
    .map((file) => join(SUITES_DIR, file));
}

function resultPath(path: string): string {
  return statSync(path).isDirectory() ? join(path, "result.json") : path;
}

const realRunner: CommandRunner = {
  async run(command, args, timeoutMs, env) {
    const result = spawnSync(command, args, {
      encoding: "utf8",
      timeout: timeoutMs,
      env: env ?? process.env,
      maxBuffer: 64 * 1024 * 1024,
    });
    if (result.error) {
      throw result.error;
    }
    return { exitCode: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
  },
};

/**
 * Signal a launched process and everything it started. POSIX children are spawned as their own
 * process group, so a `--claude` wrapper that does not `exec` cannot leave Claude and its MCP
 * server running after a timeout; Windows has no groups, so taskkill walks the tree.
 */
export function killProcessTree(
  pid: number,
  signal: NodeJS.Signals,
  platform: NodeJS.Platform = process.platform,
  deps: {
    kill: (pid: number, signal: NodeJS.Signals) => void;
    taskkill: (pid: number) => void;
  } = {
    kill: (target, sig) => process.kill(target, sig),
    taskkill: (target) => {
      spawnSync("taskkill", ["/pid", String(target), "/T", "/F"], { stdio: "ignore" });
    },
  },
): void {
  if (platform === "win32") {
    deps.taskkill(pid);
    return;
  }
  try {
    deps.kill(-pid, signal);
  } catch {
    // The group is already gone (or never formed); fall back to the process itself.
    try {
      deps.kill(pid, signal);
    } catch {
      // Already exited: nothing left to signal.
    }
  }
}

function createLauncher(timer: Timer): ClaudeLauncher {
  return {
    launch(spec) {
      const stdout = openSync(spec.stdoutPath, "w");
      const stderr = openSync(spec.stderrPath, "w");
      const child = spawn(spec.command, spec.args, {
        cwd: spec.cwd,
        env: spec.env,
        stdio: ["pipe", stdout, stderr],
        // Its own process group, so the timeout and an interrupt reach every descendant.
        detached: process.platform !== "win32",
      });
      const killTree = (signal: NodeJS.Signals) => {
        if (child.pid !== undefined) {
          killProcessTree(child.pid, signal);
        }
      };
      // A separate group no longer receives the terminal's Ctrl+C, so forward an interrupt
      // or termination to the group, then let the signal end the harness as usual.
      const forward = (signal: NodeJS.Signals) => {
        killTree("SIGTERM");
        process.off("SIGINT", forward);
        process.off("SIGTERM", forward);
        process.kill(process.pid, signal);
      };
      process.on("SIGINT", forward);
      process.on("SIGTERM", forward);
      // Claude can exit before reading stdin (bad flag, auth failure); the resulting
      // EPIPE must not crash the CLI. The child close/error handlers settle the run.
      child.stdin.on("error", () => undefined);
      child.stdin.end(spec.stdin);
      let timedOut = false;
      let killHandle: NodeJS.Timeout | undefined;
      const timeoutHandle = timer.setTimeout(() => {
        timedOut = true;
        killTree("SIGTERM");
        killHandle = timer.setTimeout(() => killTree("SIGKILL"), KILL_GRACE_MS);
      }, spec.timeoutMs);
      // A failed spawn can emit both `error` and `close`; settle (and close the fds) once.
      let settled = false;
      const settle = () => {
        if (settled) {
          return false;
        }
        settled = true;
        process.off("SIGINT", forward);
        process.off("SIGTERM", forward);
        timer.clearTimeout(timeoutHandle);
        if (killHandle) {
          timer.clearTimeout(killHandle);
        }
        closeSync(stdout);
        closeSync(stderr);
        return true;
      };
      return new Promise((resolveExit, rejectExit) => {
        child.once("error", (error) => {
          if (settle()) {
            rejectExit(new Error(`Failed to launch ${spec.command}: ${errorMessage(error)}`));
          }
        });
        child.once("close", (code) => {
          if (settle()) {
            resolveExit({ exitCode: code, timedOut });
          }
        });
      });
    },
  };
}

const realFs: HarnessFs = {
  mkdir: (path) => mkdirSync(path, { recursive: true }),
  writeFile: (path, content) => writeFileSync(path, content),
  readFile: (path) => readFileSync(path, "utf8"),
  exists: (path) => existsSync(path),
  // Aux sockets need a short path (sun_path is ~104 bytes on macOS); prefer /tmp.
  makeTempDir: (prefix) =>
    mkdtempSync(join(process.platform === "win32" ? tmpdir() : "/tmp", prefix)),
  remove: (path) => rmSync(path, { recursive: true, force: true }),
  sha256: (path) => createHash("sha256").update(readFileSync(path)).digest("hex"),
};

/**
 * The canonical ownership rules daemons use before allocating a device (the CtrlProxy
 * forwarding lease, current and 0.0.84 allocation claims, unreadable claims, and live
 * CtrlProxy forwards, each confirmed against its owner), then this process's own claim.
 * The claim names no control socket: the harness serves none, so other daemons judge it
 * by this process's liveness alone instead of lapsing it after their startup grace.
 */
async function claimForBenchmark(
  serial: string,
): Promise<{ release(): void } | { refused: string }> {
  const ownership = new ForwardLeaseForeignDeviceOwnership(
    process.pid,
    undefined,
    undefined,
    () => undefined,
    undefined,
    createForeignCtrlProxyForwardEvidence(),
  );
  const holder = async () => {
    await ownership.refresh([serial]);
    const pid = ownership.foreignOwnerPid(serial);
    if (pid !== undefined) {
      return `is claimed by another AutoMobile session (pid ${pid})`;
    }
    return ownership.foreignClaimUnreadable(serial)
      ? "is claimed by another AutoMobile session (an unreadable claim)"
      : undefined;
  };
  const before = await holder();
  if (before) {
    return { refused: before };
  }
  if (!(await ownership.claim(serial))) {
    return { refused: (await holder()) ?? "could not be claimed" };
  }
  // claim() fails open for daemons when the claim cannot be written; a benchmark about to
  // clear app data must not, so confirm the claim file now names this process.
  if (readExclusiveLockContent(deviceAllocationClaimPath(serial))?.pid !== process.pid) {
    ownership.release(serial);
    return { refused: `could not be claimed (${deviceAllocationClaimPath(serial)} not written)` };
  }
  return { release: () => ownership.release(serial) };
}

/**
 * Daemon claims are handed to the run's private daemon before Claude starts, so a second
 * benchmark could otherwise reserve the device during that run. This benchmark-only lock,
 * held for the whole run, keeps other benchmarks off the device (a dead holder's lock is
 * reclaimed).
 */
function benchmarkLockPath(serial: string): string {
  return `${deviceAllocationClaimPath(serial)}.agent-benchmark`;
}

const realDeviceClaims: DeviceClaims = {
  async reserve(serial) {
    const lockPath = benchmarkLockPath(serial);
    mkdirSync(dirname(lockPath), { recursive: true });
    if (!tryAcquireExclusiveLock(lockPath)) {
      const pid = readExclusiveLockContent(lockPath)?.pid;
      return { refused: `is in use by another agent benchmark (pid ${pid ?? "unknown"})` };
    }
    const releaseLock = () => releaseExclusiveLock(lockPath);
    try {
      const first = await claimForBenchmark(serial);
      if ("refused" in first) {
        releaseLock();
        return first;
      }
      let claim: { release(): void } = first;
      return {
        handOff: () => claim.release(),
        reclaim: async () => {
          const again = await claimForBenchmark(serial);
          if ("refused" in again) {
            return again.refused;
          }
          claim = again;
          return undefined;
        },
        release: () => {
          claim.release();
          releaseLock();
        },
      };
    } catch (error) {
      releaseLock();
      throw error;
    }
  },
};

/**
 * What a run would launch. `env` is the inherited environment the real run passes to the
 * MCP config, so the adb endpoint and claim-root routing it will use are visible here.
 */
export function dryRunReport(
  suite: LoadedSuite,
  options: CliOptions,
  env: Record<string, string | undefined> = process.env,
): string {
  const placeholders = {
    deviceSerial: options.device ?? "<serial>",
    packageName: suite.definition.app.packageName,
    runDirectory: "<run-dir>",
  };
  const paths = {
    runtime: process.execPath,
    serverEntry: join(REPO_ROOT, "dist", "src", "index.js"),
    auxSocketDir: "<tmp>/amb-XXXXXX",
    dbDir: "<run-dir>/db",
    logDir: "<run-dir>/logs",
  };
  const args = buildClaudeArgs(
    suite.definition,
    "<run-dir>/mcp-config.json",
    systemPromptFor(suite.definition, placeholders),
    options.model,
  );
  return [
    `suite ${suite.definition.name} (${suite.suitePath}) is valid`,
    `prompt ${suite.promptPath}`,
    `claude ${JSON.stringify([options.claude, ...args])}`,
    `mcp-config ${JSON.stringify(buildMcpConfig(paths, env))}`,
  ].join("\n");
}

function emit(results: BenchmarkResult[], json: boolean): void {
  if (json) {
    console.log(JSON.stringify(results.length === 1 ? results[0] : results, null, 2));
    return;
  }
  console.log(results.map(renderReport).join("\n\n"));
  if (results.length > 1) {
    console.log(`\n${renderSummary(results)}`);
  }
}

/**
 * `sha256=<prefix>` over every file the built server can load: the bundle and the sidecars
 * the build copies beside it (schemas, vendor tools). Source maps are skipped; they change
 * with paths, not behavior. Paths are hashed with `/` so the digest is the same on Windows.
 */
export function bundleDigest(files: Array<{ path: string; read: () => Uint8Array }>): string {
  const hash = createHash("sha256");
  const ordered = files
    .map((file) => ({ ...file, path: file.path.replaceAll("\\", "/") }))
    .filter((file) => !file.path.endsWith(".map"))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const file of ordered) {
    hash.update(file.path);
    hash.update("\0");
    hash.update(file.read());
    hash.update("\0");
  }
  return `sha256=${hash.digest("hex").slice(0, 16)}`;
}

/**
 * Every repository source file reachable from `entries` through runtime imports: the
 * harness imports `src/` helpers directly (device ownership, locks, launch-failure
 * detection), and those run unbundled, so their edits change behavior without a rebuild.
 * Type-only imports are erased and never scanned; packages under node_modules are left to
 * `bun.lock`.
 */
export function importClosure(
  entries: string[],
  scan: (path: string) => string[],
  resolve: (specifier: string, fromDir: string) => string | undefined,
  inRepo: (path: string) => boolean,
): string[] {
  const seen = new Set<string>();
  const pending = [...entries];
  while (pending.length > 0) {
    const path = pending.pop() as string;
    if (seen.has(path)) {
      continue;
    }
    seen.add(path);
    pending.push(
      ...scan(path)
        .map((specifier) => resolve(specifier, dirname(path)))
        .filter((next): next is string => next !== undefined && inRepo(next)),
    );
  }
  return [...seen].sort();
}

function scanModuleImports(transpiler: Bun.Transpiler, path: string): string[] {
  // scanImports rejects a leading shebang, which entry-point scripts carry.
  const code = readFileSync(path, "utf8").replace(/^#!.*/, "");
  try {
    return transpiler.scanImports(code).map((entry) => entry.path);
  } catch {
    // An unparseable file is still hashed; only its imports go unfollowed.
    return [];
  }
}

function harnessSources(): string[] {
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  const harnessDir = join(REPO_ROOT, "scripts", "agent-benchmark");
  return importClosure(
    readdirSync(harnessDir)
      .filter((name) => name.endsWith(".ts"))
      .map((name) => join(harnessDir, name)),
    // Imported JSON and other data files are hashed but have no imports to follow.
    (path) => (/\.[cm]?[jt]sx?$/.test(path) ? scanModuleImports(transpiler, path) : []),
    (specifier, fromDir) => {
      try {
        return Bun.resolveSync(specifier, fromDir);
      } catch {
        // Builtins (node:fs) and absent optional packages have no repository file to hash.
        return undefined;
      }
    },
    (path) => path.startsWith(REPO_ROOT) && !path.includes(`${sep}node_modules${sep}`),
  );
}

/**
 * Everything that executes or scores a run: the built `dist/`; `bun.lock`, since the build
 * leaves sharp and jimp external and the lockfile pins which versions load at runtime;
 * `package.json`, which the server reads for its version; this harness's sources and every
 * repository module they import, which run unbundled and decide preflight, verdicts, and
 * metrics; the Bun runtime version; and the host platform and architecture, which pick the
 * native image build that loads. The git commit is left out: it
 * changes with every unrelated commit, which would flag every baseline as mismatched.
 */
/**
 * A `--claude` wrapper script can inject flags or prompts while the stream still reports
 * the same CLI version, so a small file-backed command is hashed by content. A large
 * binary (the CLI itself) is identified by its resolved path; its version is fingerprinted
 * separately from the stream.
 */
function claudeCommandIdentity(command: string): Uint8Array {
  const path = Bun.which(command) ?? command;
  const encode = (text: string) => new TextEncoder().encode(text);
  try {
    return statSync(path).size <= 1024 * 1024 ? readFileSync(path) : encode(`binary:${path}`);
  } catch {
    // An unresolvable command fails at launch; record its name so the digest still differs.
    return encode(`unresolved:${command}`);
  }
}

/**
 * The adb client the measured server will run, resolved the way AdbClient.getAdbPath does: the
 * SDK's platform-tools/adb (ANDROID_HOME / ANDROID_SDK_ROOT) when it answers `adb version`, else
 * the adb on PATH. Platform-tools releases differ in command behavior and latency, and the
 * version output names both the release and the install path.
 */
export function adbClientIdentity(
  env: Record<string, string | undefined>,
  version: (adb: string) => string | undefined = (adb) => {
    const result = spawnSync(adb, ["version"], { encoding: "utf8", timeout: 5_000 });
    return result.status === 0 ? result.stdout : undefined;
  },
  onPath: (command: string) => string | null = (command) => Bun.which(command, { PATH: env.PATH }),
): string {
  const sdk = resolveAndroidSdkRoot(env);
  const candidates = [...(sdk ? [`${sdk}/platform-tools/adb`] : []), onPath("adb") ?? "adb"];
  for (const adb of candidates) {
    const output = version(adb)?.trim();
    if (output) {
      return output;
    }
  }
  return `unavailable:${candidates.join(",")}`;
}

function serverDigest(claudeCommand: string): string {
  const tree = (dir: string) =>
    readdirSync(join(REPO_ROOT, dir), { recursive: true, encoding: "utf8" })
      .filter((path) => statSync(join(REPO_ROOT, dir, path)).isFile())
      .map((path) => ({
        path: `${dir}/${path}`,
        read: () => readFileSync(join(REPO_ROOT, dir, path)),
      }));
  const file = (path: string) => ({ path, read: () => readFileSync(join(REPO_ROOT, path)) });
  return bundleDigest([
    ...tree("dist"),
    ...harnessSources().map((path) => file(relative(REPO_ROOT, path))),
    file("bun.lock"),
    file("package.json"),
    { path: "bun-version", read: () => new TextEncoder().encode(process.versions.bun ?? "") },
    // bun.lock lists every platform's native sharp build; the host decides which one loads.
    {
      path: "host-platform",
      // glibc and musl hosts load different native sharp builds for the same platform/arch.
      read: () =>
        new TextEncoder().encode(`${process.platform}-${process.arch}-${familySync() ?? "none"}`),
    },
    { path: "claude-command", read: () => claudeCommandIdentity(claudeCommand) },
    // Provider and routing settings reach Claude unscrubbed; record which backend served it.
    { path: "provider", read: () => new TextEncoder().encode(providerIdentity(process.env)) },
    { path: "adb", read: () => new TextEncoder().encode(adbClientIdentity(process.env)) },
  ]);
}

async function runSuites(options: CliOptions, deps: HarnessDeps): Promise<BenchmarkResult[]> {
  const serverEntry = join(REPO_ROOT, "dist", "src", "index.js");
  if (!existsSync(serverEntry)) {
    throw new Error(`${serverEntry} is missing; run \`bun run build\` first.`);
  }
  const serverBuild = serverDigest(options.claude);
  const suites = suitePaths(options).map((path) => loadSuite(path, REPO_ROOT));
  const results: BenchmarkResult[] = [];
  for (const suite of suites) {
    results.push(
      await runSuite(
        suite,
        {
          outputRoot: options.output,
          runtime: process.execPath,
          serverEntry,
          serverBuild,
          claudeCommand: options.claude,
          deviceSerial: options.device,
          modelOverride: options.model,
        },
        deps,
      ),
    );
  }
  return results;
}

async function main(argv: string[]): Promise<number> {
  let options: CliOptions;
  try {
    options = parseCliArgs(argv);
  } catch (error) {
    console.error(`${errorMessage(error)}\nRun with --help for usage.`);
    return 2;
  }
  if (options.help) {
    console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("*/")[0]);
    return 0;
  }
  if (options.fromResults.length > 0) {
    const results = options.fromResults.map(
      (path) => JSON.parse(readFileSync(resultPath(path), "utf8")) as BenchmarkResult,
    );
    emit(results, options.json);
    return results.every((result) => result.comparison.verdict === "passed") ? 0 : 1;
  }
  if (options.dryRun) {
    const suites = suitePaths(options).map((path) => loadSuite(path, REPO_ROOT));
    console.log(suites.map((suite) => dryRunReport(suite, options)).join("\n\n"));
    return 0;
  }
  const results = await runSuites(options, {
    runner: realRunner,
    launcher: createLauncher(defaultTimer),
    timer: defaultTimer,
    idGenerator: defaultIdGenerator,
    deviceClaims: realDeviceClaims,
    fs: realFs,
    log: (line) => console.error(line),
    env: process.env,
    platform: process.platform,
    physicalIosDevices: async () => {
      // Never throws: non-macOS hosts list nothing, and a failed sweep is complete: false.
      const discovery = await getSharedDevicectlDeviceLister().listConnectedDevices();
      return {
        names: discovery.devices.map((device) => device.name),
        complete: discovery.complete,
      };
    },
  });
  emit(results, options.json);
  return results.every((result) => result.comparison.verdict === "passed") ? 0 : 1;
}

if (import.meta.main) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(errorMessage(error));
      process.exitCode = 1;
    });
}
