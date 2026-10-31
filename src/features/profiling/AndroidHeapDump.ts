import { ActionableError } from "../../models/ActionableError";
import { adbFailureOutput } from "../../utils/android-cmdline-tools/adbFailureOutput";
import { DUMPSYS_MAX_BUFFER } from "../../utils/android-cmdline-tools/dumpsysLimits";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { shellQuote } from "../../utils/shellQuote";
import type { IdGenerator } from "../../utils/IdGenerator";
import type { Timer } from "../../utils/SystemTimer";
import { deviceFileSize, removeDeviceFile } from "../performanceTrace/perfettoDevice";
import { HeapDumpRefusedError } from "./HeapDumpRefusedError";

export { HeapDumpRefusedError } from "./HeapDumpRefusedError";
import type { ProfilingArtifactStore } from "./ProfilingArtifactStore";
import type { ProfilingRegistry } from "./ProfilingRegistry";

export type HeapDumpAdb = Pick<AdbExecutor, "execute">;

export interface HeapDumpDependencies {
  adb: HeapDumpAdb;
  timer: Pick<Timer, "sleep">;
  idGenerator: IdGenerator;
  registry: ProfilingRegistry;
  store: ProfilingArtifactStore;
  /** Polls of the device file size while the app writes the dump. */
  sizePollAttempts?: number;
  sizePollIntervalMs?: number;
}

export interface HeapDumpRequest {
  appId: string;
  deviceId: string;
  native?: boolean;
  sessionId?: string;
  signal?: AbortSignal;
}

/** One command tried and what read-back found, reported so API-level quirks stay visible. */
export interface HeapDumpAttempt {
  command: string;
  outcome: "dumped" | "empty";
  output?: string;
}

export interface HeapDumpResult {
  path: string;
  sizeBytes: number;
  native: boolean;
  attempts: HeapDumpAttempt[];
}

/** Device directory the shell user can write; the app writes the dump through a descriptor `am` opens. */
const DEVICE_DUMP_DIR = "/data/local/tmp";
const ADB_TIMEOUT_MS = 15_000;
/** `am dumpheap` blocks until the app finishes on current releases; a big heap takes a while. */
const DUMP_TIMEOUT_MS = 180_000;
const PULL_TIMEOUT_MS = 300_000;

/** The `am` entry points that dump a heap, in the order they are tried. */
const DUMP_COMMANDS = ["am dumpheap", "cmd activity dumpheap"] as const;

/** `pkgFlags=[ ... ]` and `privateFlags=[ ... ]` tokens from `dumpsys package`. */
function packageFlagTokens(output: string): { parsed: boolean; tokens: Set<string> } {
  const flagLines = output
    .split("\n")
    .map((line) => /^(pkgFlags|privateFlags)=\[(.*)\]$/.exec(line.trim()))
    .filter((match): match is RegExpExecArray => match !== null);
  return {
    parsed: flagLines.some((match) => match[1] === "pkgFlags"),
    tokens: new Set(flagLines.flatMap((match) => match[2].trim().split(/\s+/).filter(Boolean))),
  };
}

/**
 * Whether the package can be heap-dumped: `true` when it is debuggable or flags itself
 * profileable, `false` when its flags parse and show neither, `undefined` when the output has no
 * flags line to judge (let `am dumpheap` decide).
 */
export function classifyHeapDumpEligibility(output: string): boolean | undefined {
  const { parsed, tokens } = packageFlagTokens(output);
  if (!parsed) {
    return undefined;
  }
  return tokens.has("DEBUGGABLE") || [...tokens].some((token) => /PROFILEABLE/i.test(token));
}

const NOT_DEBUGGABLE_OUTPUT = /not debuggable|not profileable|SecurityException/i;
const NOT_RUNNING_OUTPUT = /unknown process|process .*not found|no such process|not running/i;

/**
 * Dump an Android app's heap (#14113): check the app is debuggable or profileable, run
 * `am dumpheap [-n] <pkg> <device path>`, read the file's size back to know the dump finished,
 * pull it to the host and delete the device copy. The device path is registered first, so a
 * session released mid-dump still has its file removed.
 */
export class AndroidHeapDump {
  constructor(private readonly deps: HeapDumpDependencies) {}

  async dump(request: HeapDumpRequest): Promise<HeapDumpResult> {
    const { adb, registry, store, idGenerator } = this.deps;
    await this.assertEligible(request);
    const dumpId = idGenerator.next();
    const remotePath = `${DEVICE_DUMP_DIR}/automobile-heap-${dumpId}.hprof`;
    const hostPath = await store.allocatePath("heapDump", dumpId, "hprof");
    registry.addDeviceFile({
      deviceId: request.deviceId,
      sessionId: request.sessionId,
      remotePath,
    });
    try {
      const attempts = await this.runDump(request, remotePath);
      await adb.execute(["pull", remotePath, hostPath], {
        timeoutMs: PULL_TIMEOUT_MS,
        noRetry: true,
        signal: request.signal,
      });
      const sizeBytes = await store.sizeOf(hostPath);
      if (sizeBytes === 0) {
        throw new ActionableError(`The pulled heap dump ${hostPath} is empty.`);
      }
      return { path: hostPath, sizeBytes, native: request.native === true, attempts };
    } catch (error) {
      await store.remove(hostPath);
      throw error;
    } finally {
      // A file that could not be removed stays registered so session release retries it.
      if (await removeDeviceFile(adb, remotePath, "heapDump")) {
        registry.removeDeviceFile(request.deviceId, remotePath);
      }
    }
  }

  private async assertEligible(request: HeapDumpRequest): Promise<void> {
    const result = await this.deps.adb.execute(
      ["shell", `dumpsys package ${shellQuote(request.appId)}`],
      {
        timeoutMs: ADB_TIMEOUT_MS,
        maxBuffer: DUMPSYS_MAX_BUFFER,
        noRetry: true,
        signal: request.signal,
      },
    );
    if (/Unable to find package|Package \[.*\] .*not found/i.test(result.stdout)) {
      throw new ActionableError(`${request.appId} is not installed on ${request.deviceId}.`);
    }
    if (classifyHeapDumpEligibility(result.stdout) === false) {
      throw new HeapDumpRefusedError(request.appId, "its package flags show neither");
    }
  }

  private async runDump(request: HeapDumpRequest, remotePath: string): Promise<HeapDumpAttempt[]> {
    const attempts: HeapDumpAttempt[] = [];
    for (const base of DUMP_COMMANDS) {
      const command = `${base}${request.native ? " -n" : ""} ${shellQuote(request.appId)} ${remotePath}`;
      const output = await this.runDumpCommand(request, command);
      const size = await this.awaitDumpWritten(remotePath, request.signal);
      attempts.push({ command, outcome: size > 0 ? "dumped" : "empty", output });
      if (size > 0) {
        return attempts;
      }
    }
    throw new ActionableError(
      `No heap dump was written for ${request.appId}; tried ${attempts.map((a) => a.command).join(", ")}. Last output: ${attempts.at(-1)?.output ?? ""}`,
    );
  }

  /**
   * Run one dump command and return its output. `adb shell` propagates the remote exit status, so
   * a refusal usually arrives as a rejected call, not a resolved result: classify the output a
   * rejection carries too, and rethrow anything unrecognized unchanged.
   */
  private async runDumpCommand(request: HeapDumpRequest, command: string): Promise<string> {
    let output: string;
    try {
      const run = await this.deps.adb.execute(["shell", command], {
        timeoutMs: DUMP_TIMEOUT_MS,
        noRetry: true,
        signal: request.signal,
      });
      output = `${run.stdout}\n${run.stderr}`.trim();
    } catch (error) {
      const failure = adbFailureOutput(error);
      this.classifyDumpOutput(request, `${failure.stdout}\n${failure.stderr}`.trim());
      throw error;
    }
    this.classifyDumpOutput(request, output);
    return output;
  }

  private classifyDumpOutput(request: HeapDumpRequest, output: string): void {
    if (NOT_DEBUGGABLE_OUTPUT.test(output)) {
      throw new HeapDumpRefusedError(request.appId, output.split("\n")[0]);
    }
    if (NOT_RUNNING_OUTPUT.test(output)) {
      throw new ActionableError(
        `${request.appId} is not running on ${request.deviceId}; launch it before dumping its heap. ${output}`,
      );
    }
  }

  /**
   * `am dumpheap` returns before the app finishes on older releases: wait for a stable size.
   * Returns 0 when no file appeared. A file that is still growing when the budget ends is an
   * unfinished dump, never a result, so it throws instead of returning its last size.
   */
  private async awaitDumpWritten(remotePath: string, signal?: AbortSignal): Promise<number> {
    const attempts = this.deps.sizePollAttempts ?? 60;
    let previous = 0;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const size = await deviceFileSize(this.deps.adb, remotePath, signal);
      if (size > 0 && size === previous) {
        return size;
      }
      previous = size;
      await this.deps.timer.sleep(this.deps.sizePollIntervalMs ?? 500);
    }
    if (previous > 0) {
      throw new ActionableError(
        `heap_dump_incomplete: ${remotePath} was still growing (${previous} bytes) when the wait ended, so the dump is unfinished and was not pulled. The device copy is removed; retry, or dump a smaller heap.`,
      );
    }
    return 0;
  }
}
