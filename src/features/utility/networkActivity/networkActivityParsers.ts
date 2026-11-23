import type { NetworkActivitySocket } from "./NetworkActivityTypes";

/** Internet sockets of one process from `lsof -F pcPnT`. */
export interface LsofProcessSockets {
  pid: number;
  command: string;
  sockets: NetworkActivitySocket[];
}

interface PendingSocket {
  protocol?: string;
  name?: string;
  state?: string;
}

function toSocket(pending: PendingSocket): NetworkActivitySocket | undefined {
  if (!pending.protocol || !pending.name) {
    return undefined;
  }
  const arrow = pending.name.indexOf("->");
  return {
    protocol: pending.protocol,
    local: arrow === -1 ? pending.name : pending.name.slice(0, arrow),
    ...(arrow === -1 ? {} : { remote: pending.name.slice(arrow + 2) }),
    ...(pending.state ? { state: pending.state } : {}),
  };
}

/** `P` (protocol), `n` (`local->remote`) and `T` (`ST=` TCP state; queue sizes are ignored). */
function applySocketField(pending: PendingSocket, field: string, value: string): void {
  if (field === "P") {
    pending.protocol = value;
  } else if (field === "n") {
    pending.name = value;
  } else if (field === "T" && value.startsWith("ST=")) {
    pending.state = value.slice(3);
  }
}

/**
 * Parses `lsof -nP -a -i -p <pids> -F pcPnT`: a `p` line starts a process, `c` names it, and each
 * `f` line starts one of its sockets, followed by `P` (protocol), `n` (`local->remote`) and `T`
 * lines (`ST=` is the TCP state; queue sizes are ignored).
 */
export function parseLsofInternetSockets(stdout: string): LsofProcessSockets[] {
  const processes: LsofProcessSockets[] = [];
  let current: LsofProcessSockets | undefined;
  let pending: PendingSocket | undefined;
  const flush = () => {
    const socket = pending ? toSocket(pending) : undefined;
    if (current && socket) {
      current.sockets.push(socket);
    }
    pending = undefined;
  };
  for (const line of stdout.split("\n")) {
    const field = line.charAt(0);
    const value = line.slice(1).trimEnd();
    if (field === "p") {
      flush();
      current = { pid: Number(value), command: "", sockets: [] };
      processes.push(current);
    } else if (field === "c" && current) {
      current.command = value;
    } else if (field === "f") {
      flush();
      pending = {};
    } else if (pending) {
      applySocketField(pending, field, value);
    }
  }
  flush();
  return processes.filter((process) => Number.isInteger(process.pid) && process.pid > 0);
}

/** Byte totals of one process from `nettop -P -x -J bytes_in,bytes_out`. */
export interface NettopProcessBytes {
  pid: number;
  name: string;
  bytesIn: number;
  bytesOut: number;
}

const NETTOP_ROW = /^(.+)\.(\d+),(\d+),(\d+),?$/;

/**
 * Parses `nettop -P -L <n> -x -J bytes_in,bytes_out` CSV: `<name>.<pid>,<in>,<out>,` rows under a
 * `,bytes_in,bytes_out,` header that repeats per sample. A later sample replaces an earlier one.
 */
export function parseNettopProcessBytes(stdout: string): Map<number, NettopProcessBytes> {
  const byPid = new Map<number, NettopProcessBytes>();
  for (const line of stdout.split("\n")) {
    const match = NETTOP_ROW.exec(line.trim());
    if (!match) {
      continue;
    }
    const pid = Number(match[2]);
    byPid.set(pid, {
      pid,
      name: match[1],
      bytesIn: Number(match[3]),
      bytesOut: Number(match[4]),
    });
  }
  return byPid;
}
