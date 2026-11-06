/**
 * Device-side TCP listeners, read from `/proc/net/tcp` and `/proc/net/tcp6` in one shell call.
 * Only sockets in LISTEN state on a loopback or wildcard address count: those are the ones that
 * stop adbd binding `127.0.0.1:<port>` for a reverse.
 */

/** What the device's listener table showed. */
export type DeviceListenerTable =
  /** Device port -> uids of the processes listening there. */
  | { kind: "ok"; listeners: ReadonlyMap<number, readonly number[]> }
  /** Neither file had a readable table (for example SELinux denied it). */
  | { kind: "unsupported"; detail: string };

const FILE_MARKER = "automobile-proc-file=";
/** `st` column value for TCP_LISTEN. */
const LISTEN_STATE = "0A";

/** The device shell script: each file is preceded by a marker so a missing file reads as empty. */
export const DEVICE_LISTENERS_SCRIPT = `for f in /proc/net/tcp /proc/net/tcp6; do echo "${FILE_MARKER}$f"; cat "$f" 2>&1; done`;

/**
 * Whether a `/proc/net/tcp{,6}` local address (hex, as the kernel prints it) is a wildcard or
 * loopback address: `00000000`, `xx00007F`-style 127/8, `::`, `::1`, or `::ffff:127.x.x.x`.
 */
function isLoopbackOrAny(hex: string): boolean {
  const address = hex.toUpperCase();
  if (address.length === 8) {
    // IPv4 is printed as a little-endian 32-bit word, so 127.x.x.x ends in 7F.
    return address === "00000000" || address.endsWith("7F");
  }
  if (address.length !== 32) {
    return false;
  }
  // IPv6 is printed as four little-endian 32-bit words.
  const words = address.match(/.{8}/g) ?? [];
  const [w0, w1, w2, w3] = words;
  if (w0 !== "00000000" || w1 !== "00000000") {
    return false;
  }
  if (w2 === "00000000") {
    return w3 === "00000000" || w3 === "01000000";
  }
  // ::ffff:127.x.x.x, an IPv4-mapped loopback address.
  return w2 === "FFFF0000" && (w3?.endsWith("7F") ?? false);
}

interface ListenRow {
  port: number;
  uid: number;
}

const parseHex = (text: string) =>
  /^[0-9A-Fa-f]{4}$/.test(text) ? Number.parseInt(text, 16) : NaN;
const parseDecimal = (text: string) => (/^\d+$/.test(text) ? Number(text) : NaN);

/** One table row (`sl local rem st ... uid ...`) as a LISTEN socket, or undefined. */
function parseRow(line: string): ListenRow | undefined {
  const [slot = "", local = "", , state, , , , uidText = ""] = line.trim().split(/\s+/);
  const [address = "", portHex = ""] = local.split(":");
  if (!/^\d+:$/.test(slot) || state !== LISTEN_STATE || !isLoopbackOrAny(address)) {
    return undefined;
  }
  const port = parseHex(portHex);
  const uid = parseDecimal(uidText);
  return Number.isInteger(port) && Number.isInteger(uid) ? { port, uid } : undefined;
}

/** Adds a section's LISTEN rows to `listeners`. */
function addRows(lines: readonly string[], listeners: Map<number, number[]>): void {
  for (const row of lines.map(parseRow)) {
    if (row === undefined) {
      continue;
    }
    const uids = listeners.get(row.port) ?? [];
    listeners.set(row.port, uids.includes(row.uid) ? uids : [...uids, row.uid]);
  }
}

/**
 * Parses the output of {@link DEVICE_LISTENERS_SCRIPT}. A file counts as read when its section
 * has the kernel's `local_address` header; when no section does, the table is `unsupported` and
 * the device's own text is kept as the detail.
 */
export function parseDeviceListeners(stdout: string): DeviceListenerTable {
  const listeners = new Map<number, number[]>();
  let readable = false;
  const unreadable: string[] = [];
  for (const section of stdout.split(FILE_MARKER).slice(1)) {
    const lines = section.split("\n");
    const header = lines.findIndex((line) => line.includes("local_address"));
    if (header < 0) {
      unreadable.push(lines.slice(1).join(" ").trim() || `${lines[0]?.trim() ?? ""}: no output`);
      continue;
    }
    readable = true;
    addRows(lines.slice(header + 1), listeners);
  }
  if (!readable) {
    return { kind: "unsupported", detail: unreadable.join("; ") || "no output" };
  }
  return { kind: "ok", listeners };
}

/**
 * The one package `pm list packages -U` shows for `uid`, or undefined when none or several (a
 * shared uid) do. Rows are `package:<name> uid:<uid>`.
 */
export function packageForUid(stdout: string, uid: number): string | undefined {
  const matches = stdout.split("\n").flatMap((line) => {
    const match = /^package:(\S+)\s+uid:(\d+)/.exec(line.trim());
    return match?.[1] !== undefined && Number(match[2]) === uid ? [match[1]] : [];
  });
  return matches.length === 1 ? matches[0] : undefined;
}
