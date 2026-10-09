import type { HostProcessRow, SimulatorProcessCost } from "./types";

const KIB = 1024;
const PS_ROW = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+(?:\.\d+)?)\s+(\S.*)$/;

/** Read-only argv for the host process table snapshot. */
export const PS_SNAPSHOT_ARGS = ["-axo", "pid=,ppid=,rss=,pcpu=,command="];

/**
 * Parses `ps -axo pid=,ppid=,rss=,pcpu=,command=` output. Malformed rows are
 * skipped and counted so callers can report a degraded measurement.
 */
export function parsePsSnapshot(stdout: string): { rows: HostProcessRow[]; skipped: number } {
  const rows: HostProcessRow[] = [];
  let skipped = 0;
  for (const line of stdout.split("\n")) {
    if (line.trim() === "") {
      continue;
    }
    const match = PS_ROW.exec(line);
    if (match) {
      rows.push({
        pid: Number(match[1]),
        ppid: Number(match[2]),
        rssBytes: Number(match[3]) * KIB,
        cpuPercent: Number(match[4]),
        command: match[5],
      });
    } else {
      skipped += 1;
    }
  }
  return { rows, skipped };
}

/** `/CoreSimulator/Devices/<UDID>/` is the path component every simulator root process carries. */
function devicePathMarker(udid: string): string {
  return `/CoreSimulator/Devices/${udid}/`;
}

/**
 * Attributes each process tree to a simulator in one pass over the table.
 *
 * A root is any process whose command line names the simulator's device data
 * directory (the `launchd_sim` bootstrap). Descendants follow `ppid`. A process
 * claimed by two simulators is ambiguous and attributed to neither, so one
 * simulator's cost is never inflated by another's.
 */
export function attributeSimulatorProcesses(
  rows: readonly HostProcessRow[],
  udids: readonly string[],
): Map<string, SimulatorProcessCost> {
  const children = new Map<number, HostProcessRow[]>();
  for (const row of rows) {
    children.set(row.ppid, [...(children.get(row.ppid) ?? []), row]);
  }
  const owner = new Map<number, string | null>();
  for (const udid of udids) {
    const marker = devicePathMarker(udid);
    const claimed = new Set<number>();
    for (const root of rows.filter((row) => row.command.includes(marker))) {
      collectTree(root, children, claimed);
    }
    for (const pid of claimed) {
      owner.set(pid, owner.has(pid) ? null : udid);
    }
  }
  return sumByOwner(rows, owner);
}

function collectTree(
  root: HostProcessRow,
  children: Map<number, HostProcessRow[]>,
  claimed: Set<number>,
): void {
  const stack = [root];
  while (stack.length > 0) {
    const row = stack.pop() as HostProcessRow;
    if (claimed.has(row.pid)) {
      continue; // also breaks ppid cycles
    }
    claimed.add(row.pid);
    stack.push(...(children.get(row.pid) ?? []));
  }
}

function sumByOwner(
  rows: readonly HostProcessRow[],
  owner: Map<number, string | null>,
): Map<string, SimulatorProcessCost> {
  const totals = new Map<string, SimulatorProcessCost>();
  for (const row of rows) {
    const udid = owner.get(row.pid);
    if (!udid) {
      continue;
    }
    const current = totals.get(udid) ?? { processCount: 0, rssBytes: 0, cpuPercent: 0 };
    totals.set(udid, {
      processCount: current.processCount + 1,
      rssBytes: current.rssBytes + row.rssBytes,
      cpuPercent: current.cpuPercent + row.cpuPercent,
    });
  }
  return totals;
}
