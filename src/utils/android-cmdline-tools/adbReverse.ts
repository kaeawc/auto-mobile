import type { AdbExecutor } from "./interfaces/AdbExecutor";

/** One `adb reverse --list` row: the device-side TCP port and the host-side target. */
export interface AdbReverseEntry {
  /** Device-side port (`tcp:<port>`). */
  devicePort: number;
  /** Host-side spec as adb printed it, e.g. `tcp:8080` or `localabstract:foo`. */
  host: string;
  /** Host TCP port when `host` is `tcp:<port>`; undefined for any other host spec. */
  hostPort?: number;
}

/** The adb reverse operations on one device. Every port is TCP on loopback. */
export interface AdbReverseCommands {
  /** `adb reverse --list`. */
  list(): Promise<AdbReverseEntry[]>;
  /** `adb reverse [--no-rebind] tcp:<devicePort> tcp:<hostPort>`. */
  add(devicePort: number, hostPort: number, options?: { noRebind?: boolean }): Promise<void>;
  /** `adb reverse --remove tcp:<devicePort>`. Never `--remove-all`. */
  remove(devicePort: number): Promise<void>;
}

export const ADB_REVERSE_TIMEOUT_MS = 5000;
const TCP_PREFIX = "tcp:";

function tcpPort(spec: string | undefined): number | undefined {
  if (spec === undefined || !spec.startsWith(TCP_PREFIX)) {
    return undefined;
  }
  const raw = spec.slice(TCP_PREFIX.length);
  const port = /^\d+$/.test(raw) ? Number(raw) : NaN;
  return Number.isInteger(port) ? port : undefined;
}

/**
 * Parses `adb reverse --list`. Each row is `<transport> <device-spec> <host-spec>`, whitespace
 * separated (e.g. `UsbFfs tcp:8081 tcp:8081`, or `host-19 tcp:8081 tcp:8081` on an emulator).
 * The last two tokens are the device side then the host side; rows whose device side is not a TCP
 * port (a `localabstract:` socket, a blank line) are skipped.
 */
export function parseAdbReverseList(stdout: string): AdbReverseEntry[] {
  const entries: AdbReverseEntry[] = [];
  for (const line of stdout.split("\n")) {
    const tokens = line.trim().split(/\s+/);
    const devicePort = tokens.length >= 3 ? tcpPort(tokens.at(-2)) : undefined;
    if (devicePort === undefined) {
      continue;
    }
    const host = tokens.at(-1) ?? "";
    const hostPort = tcpPort(host);
    entries.push(hostPort === undefined ? { devicePort, host } : { devicePort, host, hostPort });
  }
  return entries;
}

/** The adb reverse commands over a device's executor, each bounded by {@link ADB_REVERSE_TIMEOUT_MS}. */
export function createAdbReverseCommands(
  adb: Pick<AdbExecutor, "executeCommand">,
): AdbReverseCommands {
  const options = { timeoutMs: ADB_REVERSE_TIMEOUT_MS };
  return {
    async list() {
      const result = await adb.executeCommand("reverse --list", options);
      return parseAdbReverseList(result.stdout);
    },
    async add(devicePort, hostPort, addOptions) {
      const noRebind = addOptions?.noRebind ? "--no-rebind " : "";
      await adb.executeCommand(`reverse ${noRebind}tcp:${devicePort} tcp:${hostPort}`, options);
    },
    async remove(devicePort) {
      await adb.executeCommand(`reverse --remove tcp:${devicePort}`, options);
    },
  };
}
