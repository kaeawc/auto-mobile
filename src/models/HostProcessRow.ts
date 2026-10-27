/** One row of the host process table (`ps -axo pid=,ppid=,rss=,pcpu=,command=`). */
export interface HostProcessRow {
  pid: number;
  ppid: number;
  /** Resident set size in bytes (ps reports KiB). Shared pages are counted per process. */
  rssBytes: number;
  /**
   * Physical memory footprint in bytes (macOS `phys_footprint`, from `top`), absent when it was
   * not read. Unlike `rssBytes` it does not count shared pages once per process.
   */
  footprintBytes?: number;
  /** ps `%cpu`: decayed cputime/realtime ratio, not an instantaneous sample. */
  cpuPercent: number;
  command: string;
}

export interface SimulatorProcessCost {
  processCount: number;
  rssBytes: number;
  /** Sum of the tree's per-process footprints; absent when none was read (never zero). */
  footprintBytes?: number;
  cpuPercent: number;
}
