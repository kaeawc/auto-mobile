/** One row of the host process table (`ps -axo pid=,ppid=,rss=,pcpu=,command=`). */
export interface HostProcessRow {
  pid: number;
  ppid: number;
  /** Resident set size in bytes (ps reports KiB). Shared pages are counted per process. */
  rssBytes: number;
  /** ps `%cpu`: decayed cputime/realtime ratio, not an instantaneous sample. */
  cpuPercent: number;
  command: string;
}

export interface SimulatorProcessCost {
  processCount: number;
  rssBytes: number;
  cpuPercent: number;
}
