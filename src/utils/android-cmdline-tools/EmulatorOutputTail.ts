import type { HostChildProcess } from "../HostCommandExecutor";

/** Only output captured for this exact emulator incarnation; external launches have none. */
export interface EmulatorOutputTail {
  tailFor(deviceId: string, pid: number): string | undefined;
}

export const MAX_EMULATOR_OUTPUT_SOURCES = 64;
export const MAX_EMULATOR_OUTPUT_TAIL_BYTES = 16 * 1024;

interface OutputSource {
  deviceId(): string | undefined;
  snapshot(): string;
  /** False once the emulator process has exited; its entry is then dropped on lookup. */
  alive?(): boolean;
}

/**
 * Indexes the launcher's existing redacted, bounded live tails without copying a second log.
 * At most 64 sources (oldest evicted); each existing source retains at most 50 lines / 16,384
 * characters, and a lookup returns at most 16 KiB of UTF-8. Exit removes the source.
 * No timers, files or process probes are needed.
 */
export class EmulatorOutputTailRegistry implements EmulatorOutputTail {
  private readonly sources = new Map<number, OutputSource>();

  register(pid: number, source: OutputSource): () => void {
    this.sources.delete(pid);
    this.sources.set(pid, source);
    while (this.sources.size > MAX_EMULATOR_OUTPUT_SOURCES) {
      const oldest = this.sources.keys().next().value;
      if (oldest !== undefined) {
        this.sources.delete(oldest);
      }
    }
    return () => {
      if (this.sources.get(pid) === source) {
        this.sources.delete(pid);
      }
    };
  }

  tailFor(deviceId: string, pid: number): string | undefined {
    const source = this.sources.get(pid);
    if (source?.alive?.() === false) {
      this.sources.delete(pid);
      return undefined;
    }
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
  // No exit listeners on the child: lookups prune a source whose process has exited.
  defaultEmulatorOutputTail.register(child.pid, {
    deviceId: () =>
      context.reservedEmulator?.deviceId ??
      context.expectedDeviceId ??
      host.launchTargetDeviceIds().get(child),
    snapshot,
    alive: () => (child.exitCode ?? null) === null && (child.signalCode ?? null) === null,
  });
}
