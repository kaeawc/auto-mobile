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

/**
 * Sums CPU over the runner tree from a `ps -axo pid=,ppid=,time=` table (no command
 * column, so the output stays small on a busy host). `deviceRootPids` are this device's
 * CtrlProxy host processes found separately by {@link ctrlProxyPidsFromArgsRows}.
 */
export function sumRunnerLaunchCpuMs(
  stdout: string,
  rootPid: number,
  deviceRootPids: readonly number[] = [],
): number | null {
  const cpuByPid = new Map<number, number>();
  const children = new Map<number, number[]>();
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(line);
    if (!match) {
      continue;
    }
    const cpu = parseProcessCpuTimeMs(match[3]);
    if (cpu === null) {
      return null;
    }
    const pid = Number(match[1]);
    const parent = Number(match[2]);
    cpuByPid.set(pid, cpu);
    const siblings = children.get(parent) ?? [];
    siblings.push(pid);
    children.set(parent, siblings);
  }
  if (!cpuByPid.has(rootPid)) {
    return null;
  }
  const included = descendantPids(children, [rootPid, ...deviceRootPids]);
  let total = 0;
  for (const pid of included) {
    total += cpuByPid.get(pid) ?? 0;
  }
  return total;
}

/**
 * The runner app lives under the device's data container, so its command line carries
 * both the udid and the CtrlProxy bundle name. The device's launchd_sim (udid only) is
 * deliberately excluded: an idle booted simulator burns CPU all the time and would make a
 * frozen runner look like it is progressing. `stdout` is `ps -o pid= -o args=` rows for the
 * processes whose command line already matched the udid.
 */
export function ctrlProxyPidsFromArgsRows(stdout: string): number[] {
  return stdout.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line);
    return match && match[2].includes("CtrlProxy") ? [Number(match[1])] : [];
  });
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
