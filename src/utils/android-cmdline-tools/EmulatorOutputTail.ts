import type { HostChildProcess } from "../HostCommandExecutor";
import { classifyHostMicrophoneFailure } from "./emulatorGrpc/classifyHostMicrophoneFailure";
import type { AndroidCommandOutputStreamRedactor } from "./redactAndroidCommandOutput";

/** Only output captured for this exact emulator incarnation; external launches have none. */
export interface EmulatorOutputTail {
  tailFor(deviceId: string, pid: number): string | undefined;
  hostMicrophoneFailed(deviceId: string, pid: number): boolean;
}

export const MAX_EMULATOR_OUTPUT_SOURCES = 64;
export const MAX_EMULATOR_OUTPUT_TAIL_BYTES = 16 * 1024;

interface OutputSource {
  deviceId(): string | undefined;
  snapshot(): string;
  /** False once the emulator process has exited; its entry is then dropped on lookup. */
  alive?(): boolean;
}

interface IndexedOutputSource {
  source: OutputSource;
  hostMicrophoneFailed: boolean;
}

/**
 * Indexes the launcher's existing redacted, bounded live tails without copying a second log.
 * At most 64 sources (oldest evicted); each existing source retains at most 50 lines / 16,384
 * characters, and a lookup returns at most 16 KiB of UTF-8. Exit removes the source.
 * No timers, files or process probes are needed.
 */
export class EmulatorOutputTailRegistry implements EmulatorOutputTail {
  private readonly sources = new Map<number, IndexedOutputSource>();

  register(pid: number, source: OutputSource): () => void {
    const indexed = { source, hostMicrophoneFailed: false };
    this.sources.delete(pid);
    this.sources.set(pid, indexed);
    while (this.sources.size > MAX_EMULATOR_OUTPUT_SOURCES) {
      const oldest = this.sources.keys().next().value;
      if (oldest !== undefined) {
        this.sources.delete(oldest);
      }
    }
    return () => {
      if (this.sources.get(pid) === indexed) {
        this.sources.delete(pid);
      }
    };
  }

  /** Observe redacted chunks before tail trimming; log churn cannot undo a host failure (#15902). */
  observe(pid: number, chunk: string): void {
    const indexed = this.liveSource(pid);
    if (indexed && !indexed.hostMicrophoneFailed) {
      indexed.hostMicrophoneFailed = classifyHostMicrophoneFailure(chunk);
    }
  }

  hostMicrophoneFailed(deviceId: string, pid: number): boolean {
    const indexed = this.liveSource(pid);
    return indexed?.source.deviceId() === deviceId && indexed.hostMicrophoneFailed;
  }

  private liveSource(pid: number): IndexedOutputSource | undefined {
    const indexed = this.sources.get(pid);
    if (indexed?.source.alive?.() === false) {
      this.sources.delete(pid);
      return undefined;
    }
    return indexed;
  }

  tailFor(deviceId: string, pid: number): string | undefined {
    const source = this.liveSource(pid)?.source;
    if (!source || source.deviceId() !== deviceId) {
      return undefined;
    }
    const bytes = Buffer.from(source.snapshot(), "utf8");
    let start = Math.max(0, bytes.length - MAX_EMULATOR_OUTPUT_TAIL_BYTES);
    // Do not split a UTF-8 character at the byte cap.
    while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) {
      start++;
    }
    return bytes.subarray(start).toString("utf8");
  }
}

export const defaultEmulatorOutputTail = new EmulatorOutputTailRegistry();
const removals = new WeakMap<HostChildProcess, () => void>();

/** Wraps the shared stdout/stderr append path without adding child listeners. */
export function observeEmulatorOutput(
  child: HostChildProcess,
  append: (output: string) => void,
  redactors: readonly AndroidCommandOutputStreamRedactor[],
): (output: string) => void {
  return (output) => {
    if (child.pid !== undefined && removals.has(child)) {
      // Include each safe pending suffix without inserting the other stream into a split failure.
      for (const redactor of redactors) {
        defaultEmulatorOutputTail.observe(child.pid, output + redactor.snapshot());
      }
    }
    append(output);
  };
}

/** Called by the launcher's existing exit/close handlers; stale cleanup cannot remove a new PID. */
export function removeEmulatorOutputTail(child: HostChildProcess): void {
  removals.get(child)?.();
  removals.delete(child);
}

/**
 * Registers a launched emulator's live output for lookups by PID and serial, removed on exit or
 * close. The device is the reserved or expected serial, or the launch target when neither is known.
 */
export function indexEmulatorOutputTail(
  child: HostChildProcess,
  context: { reservedEmulator?: { deviceId: string }; expectedDeviceId?: string },
  snapshot: () => string,
  host: { launchTargetDeviceIds(): WeakMap<HostChildProcess, string> },
): void {
  if (child.pid === undefined) {
    return;
  }
  // Existing exit/close handlers remove this source; lookups also prune exited processes.
  const remove = defaultEmulatorOutputTail.register(child.pid, {
    deviceId: () =>
      context.reservedEmulator?.deviceId ??
      context.expectedDeviceId ??
      host.launchTargetDeviceIds().get(child),
    snapshot,
    alive: () => (child.exitCode ?? null) === null && (child.signalCode ?? null) === null,
  });
  removals.set(child, remove);
}
