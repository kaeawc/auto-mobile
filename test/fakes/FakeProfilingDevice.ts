import { createExecResult } from "../../src/utils/execResult";
import type { ExecResult } from "../../src/models";
import type { ProfilingArtifactStore } from "../../src/features/profiling/ProfilingArtifactStore";

/** The adb surface the profiling features use. */
type ProfilingAdbPort = {
  execute(args: string[], options?: { signal?: AbortSignal }): Promise<ExecResult>;
};

/**
 * A device that answers the shell commands `captureTrace` and `heapDump` issue, with the device
 * file system and the host pull target modelled as maps so tests assert end state, not scripts.
 */
export class FakeProfilingDevice implements ProfilingAdbPort {
  /** Every `shell ...` / `pull ...` argv, space-joined, in order. */
  readonly commands: string[] = [];
  /** Device path -> size in bytes. */
  readonly deviceFiles = new Map<string, number>();
  /** Host path -> size in bytes, filled by `pull`. */
  readonly hostFiles = new Map<string, number>();
  readonly runningPids = new Set<number>();
  private readonly tracePaths = new Map<number, string>();
  /** The last decoded Perfetto text config. */
  lastConfig = "";

  perfettoStartOutput = "Connected to the Perfetto traced service, TTL: 30s\n31337\n";
  traceBytes = 4096;
  heapBytes = 8192;
  packageDump = "    pkgFlags=[ DEBUGGABLE HAS_CODE ALLOW_CLEAR_USER_DATA ALLOW_BACKUP ]\n";
  /** Per `dumpheap` entry point, its output; `null` means it writes the file. */
  dumpheapOutput: Record<"am dumpheap" | "cmd activity dumpheap", string | null> = {
    "am dumpheap": null,
    "cmd activity dumpheap": null,
  };
  /** Commands (substring) that fail with this message. */
  readonly failing = new Map<string, string>();

  async execute(args: string[]): Promise<ExecResult> {
    const command = args.join(" ");
    this.commands.push(command);
    for (const [pattern, message] of this.failing) {
      if (command.includes(pattern)) {
        throw new Error(message);
      }
    }
    if (args[0] === "pull") {
      return this.pull(args[1], args[2]);
    }
    return this.shell(args.slice(1).join(" "));
  }

  private out(stdout: string, stderr = ""): ExecResult {
    return createExecResult(stdout, stderr);
  }

  private pull(from: string, to: string): ExecResult {
    const size = this.deviceFiles.get(from);
    if (size === undefined) {
      return this.out("", `adb: error: failed to stat remote object '${from}'`);
    }
    this.hostFiles.set(to, size);
    return this.out(`${from}: 1 file pulled\n`);
  }

  private shell(command: string): ExecResult {
    const perfetto = /perfetto --background --txt -c - -o (\S+)$/.exec(command);
    if (perfetto) {
      return this.startPerfetto(command, perfetto[1]);
    }
    const kill = /^kill -(TERM|0) (\d+)/.exec(command);
    if (kill) {
      return this.kill(kill[1], Number(kill[2]));
    }
    const size = /^wc -c < (\S+)/.exec(command);
    if (size) {
      return this.out(`${this.deviceFiles.get(size[1]) ?? 0}\n`);
    }
    const remove = /^rm -f (\S+)$/.exec(command);
    if (remove) {
      this.deviceFiles.delete(remove[1]);
      return this.out("");
    }
    if (command.startsWith("dumpsys package")) {
      return this.out(this.packageDump);
    }
    const heap = /^(am dumpheap|cmd activity dumpheap)(?: -n)? '?(\S+?)'? (\S+)$/.exec(command);
    if (heap) {
      return this.dumpHeap(heap[1] as keyof FakeProfilingDevice["dumpheapOutput"], heap[3]);
    }
    return this.out("");
  }

  private startPerfetto(command: string, remotePath: string): ExecResult {
    const encoded = /^echo (\S+) \|/.exec(command)?.[1] ?? "";
    this.lastConfig = Buffer.from(encoded, "base64").toString("utf8");
    const pid = Number(this.perfettoStartOutput.trim().split(/\s+/).at(-1));
    if (Number.isInteger(pid) && pid > 0) {
      this.runningPids.add(pid);
      this.tracePaths.set(pid, remotePath);
      this.deviceFiles.set(remotePath, 0);
    }
    return this.out(this.perfettoStartOutput);
  }

  private kill(signal: string, pid: number): ExecResult {
    if (signal === "TERM") {
      const tracePath = this.tracePaths.get(pid);
      if (this.runningPids.delete(pid) && tracePath && this.deviceFiles.has(tracePath)) {
        this.deviceFiles.set(tracePath, this.traceBytes);
      }
      return this.out("");
    }
    return this.out(this.runningPids.has(pid) ? "running\n" : "stopped\n");
  }

  private dumpHeap(
    entry: keyof FakeProfilingDevice["dumpheapOutput"],
    remotePath: string,
  ): ExecResult {
    const output = this.dumpheapOutput[entry];
    if (output === null) {
      this.deviceFiles.set(remotePath, this.heapBytes);
      return this.out(`File: ${remotePath}\nWaiting for dump to finish...\n`);
    }
    return this.out(output);
  }
}

/** Host-side artifact store backed by a {@link FakeProfilingDevice}'s pulled files. */
export class FakeProfilingStore implements ProfilingArtifactStore {
  readonly removed: string[] = [];
  private counter = 0;

  constructor(
    private readonly device: FakeProfilingDevice,
    private readonly directory = "/host/outputs",
  ) {}

  async allocatePath(kind: string, id: string, extension: string): Promise<string> {
    this.counter += 1;
    return `${this.directory}/${this.counter}-${kind}-${id}.${extension}`;
  }

  async sizeOf(path: string): Promise<number> {
    return this.device.hostFiles.get(path) ?? 0;
  }

  async remove(path: string): Promise<void> {
    this.removed.push(path);
    this.device.hostFiles.delete(path);
  }
}
