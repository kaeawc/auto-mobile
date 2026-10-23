/** Cumulative CPU milliseconds for the runner tree and this device's host processes. */
export interface RunnerLaunchProgressProbe {
  sample(pid: number, deviceId: string): Promise<number | null>;
}

/** macOS ps TIME: [dd-]hh:mm:ss or mm:ss.ss (including large minute counts). */
export function parseProcessCpuTimeMs(value: string): number | null {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(value);
  if (!match) {
    return null;
  }
  const [, days, hours, minutes, seconds] = match;
  if (
    (days !== undefined && hours === undefined) ||
    Number(seconds) >= 60 ||
    (hours !== undefined && Number(minutes) >= 60)
  ) {
    return null;
  }
  const result =
    ((Number(days ?? 0) * 24 + Number(hours ?? 0)) * 3600 +
      Number(minutes) * 60 +
      Number(seconds)) *
    1000;
  return Number.isSafeInteger(Math.round(result)) ? Math.round(result) : null;
}

export function sumRunnerLaunchCpuMs(
  stdout: string,
  rootPid: number,
  deviceId: string,
): number | null {
  const processes = new Map<number, { parent: number; cpu: number; command: string }>();
  const children = new Map<number, number[]>();
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/.exec(line);
    if (!match) {
      continue;
    }
    const cpu = parseProcessCpuTimeMs(match[3]);
    if (cpu === null) {
      return null;
    }
    const pid = Number(match[1]);
    const parent = Number(match[2]);
    processes.set(pid, { parent, cpu, command: match[4] });
    const siblings = children.get(parent) ?? [];
    siblings.push(pid);
    children.set(parent, siblings);
  }
  if (!processes.has(rootPid)) {
    return null;
  }
  // Simulator-side runner processes are children of the device's launchd_sim,
  // whose command line carries the udid; most of them do not carry it themselves.
  const roots = [rootPid];
  if (deviceId.length > 0) {
    for (const [pid, row] of processes) {
      if (row.command.includes(deviceId)) {
        roots.push(pid);
      }
    }
  }
  const included = descendantPids(children, roots);
  let total = 0;
  for (const pid of included) {
    total += processes.get(pid)?.cpu ?? 0;
  }
  return total;
}

function descendantPids(children: Map<number, number[]>, rootPids: number[]): Set<number> {
  const included = new Set<number>();
  const queue = [...rootPids];
  for (let index = 0; index < queue.length; index++) {
    const pid = queue[index]!;
    if (included.has(pid)) {
      continue;
    }
    included.add(pid);
    queue.push(...(children.get(pid) ?? []));
  }
  return included;
}
