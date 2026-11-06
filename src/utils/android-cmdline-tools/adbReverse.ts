import { shellQuote } from "../shellQuote";
import {
  DEVICE_LISTENERS_SCRIPT,
  packageForUid,
  parseDeviceListeners,
  type DeviceListenerTable,
} from "./deviceTcpListeners";
import type { AdbExecutor } from "./interfaces/AdbExecutor";
import {
  parsePortHttpProbeOutput,
  portHttpProbeScript,
  type PortHttpProbeOutcome,
  type PortHttpProbeRequest,
} from "./portHttpProbe";

/** One `adb reverse --list` row: the device-side TCP port and the host-side target. */
export interface AdbReverseEntry {
  /** Device-side port (`tcp:<port>`). */
  devicePort: number;
  /** Host-side spec as adb printed it, e.g. `tcp:8080` or `localabstract:foo`. */
  host: string;
  /** Host TCP port when `host` is `tcp:<port>`; undefined for any other host spec. */
  hostPort?: number;
}

/**
 * What one device-side connect to `127.0.0.1:<devicePort>` showed. A reverse listener accepts
 * the device-side connect before the host is asked, so a plain connect succeeds even when nothing
 * listens on the host: only a connection that stays open tells the host accepted it.
 */
export type PortProbeOutcome =
  /** Connected and the peer kept the connection open for the whole window. */
  | { kind: "held" }
  /** Connected, then the peer closed at once: the reverse is there but the host side is not listening. */
  | { kind: "closed" }
  /** Nothing listens on the device port (no reverse). */
  | { kind: "refused" }
  /** The shell has no usable `timeout` or `nc`, or printed something unrecognised. */
  | { kind: "unsupported"; detail: string };

/** The adb reverse operations on one device. Every port is TCP on loopback. */
export interface AdbReverseCommands {
  /** One bounded device-side connect to `127.0.0.1:<devicePort>`. */
  probe(devicePort: number): Promise<PortProbeOutcome>;
  /** One bounded device-side HTTP GET to `127.0.0.1:<devicePort>`. */
  httpProbe(devicePort: number, request: PortHttpProbeRequest): Promise<PortHttpProbeOutcome>;
  /** `adb reverse --list`. */
  list(): Promise<AdbReverseEntry[]>;
  /** `adb reverse [--no-rebind] tcp:<devicePort> tcp:<hostPort>`. */
  add(devicePort: number, hostPort: number, options?: { noRebind?: boolean }): Promise<void>;
  /** `adb reverse --remove tcp:<devicePort>`. Never `--remove-all`. */
  remove(devicePort: number): Promise<void>;
  /** LISTEN sockets on device loopback or wildcard addresses, by port. */
  listeners(): Promise<DeviceListenerTable>;
  /** The one package installed with `uid`, or undefined (none, or a shared uid). */
  packageForUid(uid: number): Promise<string | undefined>;
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

const PROBE_EXIT_MARKER = "automobile-probe-exit=";
/** `timeout(1)` exit status when it had to kill the command: the connection stayed open. */
const TIMEOUT_KILLED_EXIT = 124;
/** How long the device-side connect is held open, in seconds. */
export const PORT_PROBE_HOLD_SECONDS = 1;
/** Host-side bound on one probe command: the hold plus slack for adb and process start. */
export const PORT_PROBE_COMMAND_TIMEOUT_MS = 4000;

/**
 * The device shell script for one probe. `nc` needs an open stdin (it quits at EOF), which the
 * `sleep` pipe supplies a little past the `timeout`; `2>&1` and the exit marker put everything in
 * stdout so a refused connect does not surface as an adb failure.
 */
export function portProbeScript(devicePort: number): string {
  const stdinHold = PORT_PROBE_HOLD_SECONDS + 0.1;
  return (
    `sleep ${stdinHold} | timeout ${PORT_PROBE_HOLD_SECONDS} nc -w ${PORT_PROBE_HOLD_SECONDS} ` +
    // The leading newline keeps the marker off a banner line the peer sent without a newline.
    `127.0.0.1 ${devicePort} 2>&1; printf "\\n${PROBE_EXIT_MARKER}%s\\n" $?`
  );
}

/**
 * Parses the output of {@link portProbeScript}. Captures: an open connection ends with exit 124
 * (`timeout` killed `nc`), a peer close with exit 0, a refused connect with exit 1 and
 * `nc: connect: Connection refused`, and a missing binary with exit 126/127. Anything else is
 * `unsupported` rather than a guess.
 */
export function parsePortProbeOutput(stdout: string): PortProbeOutcome {
  const toDetail = (text: string) =>
    text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .join(" ");
  // The marker is the last occurrence anywhere: a banner without a trailing newline sits on its line.
  const markerAt = stdout.lastIndexOf(PROBE_EXIT_MARKER);
  if (markerAt < 0) {
    return { kind: "unsupported", detail: toDetail(stdout) || "no output" };
  }
  const exitText = (stdout.slice(markerAt + PROBE_EXIT_MARKER.length).split("\n")[0] ?? "").trim();
  const exit = /^\d+$/.test(exitText) ? Number(exitText) : NaN;
  const detail = toDetail(stdout.slice(0, markerAt));
  if (exit === TIMEOUT_KILLED_EXIT) {
    return { kind: "held" };
  }
  if (exit === 0 && detail === "") {
    return { kind: "closed" };
  }
  if (exit === 1 && /connection refused/i.test(detail)) {
    return { kind: "refused" };
  }
  return { kind: "unsupported", detail: detail || `exit ${exitText}` };
}

/** Host-side slack on an HTTP probe command beyond the device-side timeout: adb and process start. */
export const PORT_HTTP_PROBE_COMMAND_SLACK_MS = 3000;
/** Response bytes kept from an HTTP probe; a larger body fails the command, not the device. */
const PORT_HTTP_PROBE_MAX_BUFFER = 256 * 1024;

/** The adb reverse commands over a device's executor, each bounded by {@link ADB_REVERSE_TIMEOUT_MS}. */
export function createAdbReverseCommands(
  adb: Pick<AdbExecutor, "executeCommand">,
): AdbReverseCommands {
  const options = { timeoutMs: ADB_REVERSE_TIMEOUT_MS };
  return {
    async probe(devicePort) {
      const result = await adb.executeCommand(
        `shell sh -c ${shellQuote(portProbeScript(devicePort))}`,
        {
          timeoutMs: PORT_PROBE_COMMAND_TIMEOUT_MS,
          noRetry: true,
        },
      );
      return parsePortProbeOutput(result.stdout);
    },
    async httpProbe(devicePort, request) {
      const result = await adb.executeCommand(
        `shell sh -c ${shellQuote(portHttpProbeScript(devicePort, request))}`,
        {
          timeoutMs: request.timeoutSeconds * 1000 + PORT_HTTP_PROBE_COMMAND_SLACK_MS,
          maxBuffer: PORT_HTTP_PROBE_MAX_BUFFER,
          noRetry: true,
        },
      );
      return parsePortHttpProbeOutput(result.stdout);
    },
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
    async listeners() {
      const result = await adb.executeCommand(
        `shell sh -c ${shellQuote(DEVICE_LISTENERS_SCRIPT)}`,
        { ...options, noRetry: true },
      );
      return parseDeviceListeners(result.stdout);
    },
    async packageForUid(uid) {
      const result = await adb.executeCommand("shell pm list packages -U", {
        ...options,
        noRetry: true,
      });
      return packageForUid(result.stdout, uid);
    },
  };
}
