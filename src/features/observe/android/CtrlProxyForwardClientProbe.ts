import {
  DefaultHostCommandExecutor,
  type HostCommandExecutor,
} from "../../../utils/HostCommandExecutor";

/**
 * Finds the host processes connected to an ADB forward's local port (#10690).
 *
 * A CtrlProxy forward with no ownership record may belong to a live daemon this
 * process cannot coordinate with: an older release without records, or a
 * daemon using a different `AUTOMOBILE_COORDINATION_DIR`. Every such daemon
 * keeps a WebSocket open to `127.0.0.1:<localPort>`, so an established client
 * connection on the host is the one liveness signal all of them share.
 */
export interface ForwardClientConnectionProbe {
  /**
   * PIDs holding a client TCP connection to the loopback `localPort`. The
   * listening ADB server's accepted end of each connection is not a client.
   * Throws when the connections cannot be read, so callers can stay
   * conservative instead of mistaking "unknown" for "unused".
   */
  findClientPids(localPort: number, signal?: AbortSignal): Promise<number[]>;
}

/** A host TCP-table read must never stall forward setup. */
const PROBE_COMMAND_OPTIONS = { timeoutMs: 5_000, maxBuffer: 8 * 1024 * 1024 } as const;

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);

/** Split `host:port` (IPv4, `[v6]` or bare v6) into its host and port. */
function splitEndpoint(endpoint: string): { host: string; port: number } | null {
  const separator = endpoint.lastIndexOf(":");
  if (separator <= 0) {
    return null;
  }
  const port = Number.parseInt(endpoint.slice(separator + 1), 10);
  return Number.isInteger(port) ? { host: endpoint.slice(0, separator), port } : null;
}

function isLoopbackEndpoint(host: string): boolean {
  return LOOPBACK_HOSTS.has(host) || host.startsWith("127.");
}

/**
 * Parse `lsof -nP -iTCP:<port> -sTCP:ESTABLISHED -Fpn` output. Each connection
 * appears once per end: `n<local>-><remote>`. A client's remote end is the
 * forwarded port; the ADB server's accepted socket has it as its local end.
 */
export function parseLsofForwardClientPids(stdout: string, localPort: number): number[] {
  const pids = new Set<number>();
  let pid: number | undefined;
  for (const line of stdout.split(/\r?\n/)) {
    if (line.startsWith("p")) {
      const parsed = Number.parseInt(line.slice(1), 10);
      pid = Number.isInteger(parsed) ? parsed : undefined;
      continue;
    }
    if (!line.startsWith("n") || pid === undefined) {
      continue;
    }
    const [, remote] = line.slice(1).split("->");
    const endpoint = remote === undefined ? null : splitEndpoint(remote.trim());
    if (endpoint?.port === localPort && isLoopbackEndpoint(endpoint.host)) {
      pids.add(pid);
    }
  }
  return [...pids];
}

/**
 * Parse Windows `netstat -ano -p TCP` (and TCPv6) rows:
 * `TCP  <local>  <foreign>  <state>  <pid>`. State names are localized on some
 * Windows installs, so any row whose foreign end is the forwarded loopback port
 * and that names a real PID counts; TIME_WAIT rows carry PID 0 and drop out.
 */
export function parseNetstatForwardClientPids(stdout: string, localPort: number): number[] {
  const pids = new Set<number>();
  for (const line of stdout.split(/\r?\n/)) {
    const columns = line.trim().split(/\s+/);
    if (columns.length !== 5 || !/^TCP(v6)?$/i.test(columns[0])) {
      continue;
    }
    const foreign = splitEndpoint(columns[2]);
    const pid = Number.parseInt(columns[4], 10);
    if (foreign?.port === localPort && isLoopbackEndpoint(foreign.host) && pid > 0) {
      pids.add(pid);
    }
  }
  return [...pids];
}

/** lsof exits 1 with no output when nothing matches; that is "no clients", not a failure. */
function isLsofNoMatch(error: unknown): boolean {
  const cause = error instanceof Error ? error.cause : undefined;
  return (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    cause.code === 1 &&
    (!("stdout" in cause) || String(cause.stdout).trim() === "") &&
    (!("stderr" in cause) || String(cause.stderr).trim() === "")
  );
}

/** Reads the host's TCP table with lsof (macOS/Linux) or netstat (Windows). */
export class HostForwardClientConnectionProbe implements ForwardClientConnectionProbe {
  public constructor(
    private readonly host: HostCommandExecutor = new DefaultHostCommandExecutor(),
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}

  public async findClientPids(localPort: number, signal?: AbortSignal): Promise<number[]> {
    if (this.platform === "win32") {
      const ipv4 = await this.host.executeCommand("netstat", ["-ano", "-p", "TCP"], {
        ...PROBE_COMMAND_OPTIONS,
        signal,
      });
      const ipv6 = await this.host.executeCommand("netstat", ["-ano", "-p", "TCPv6"], {
        ...PROBE_COMMAND_OPTIONS,
        signal,
      });
      return [
        ...new Set([
          ...parseNetstatForwardClientPids(ipv4.stdout, localPort),
          ...parseNetstatForwardClientPids(ipv6.stdout, localPort),
        ]),
      ];
    }
    try {
      const { stdout } = await this.host.executeCommand(
        "lsof",
        ["-nP", `-iTCP:${localPort}`, "-sTCP:ESTABLISHED", "-Fpn"],
        { ...PROBE_COMMAND_OPTIONS, signal },
      );
      return parseLsofForwardClientPids(stdout, localPort);
    } catch (error) {
      if (isLsofNoMatch(error)) {
        return [];
      }
      throw error;
    }
  }
}

/**
 * Reports no client connections. The default for `createForTesting` clients
 * only, so unit tests never read the real host's TCP table.
 */
export class NoForwardClientConnectionProbe implements ForwardClientConnectionProbe {
  public async findClientPids(): Promise<number[]> {
    return [];
  }
}
