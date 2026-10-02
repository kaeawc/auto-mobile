import {
  DAEMON_SOCKET_PATH_FLAG,
  type DaemonProcessFinder,
  type DaemonProcessLivenessChecker,
  type DaemonProcessRecord,
} from "../../src/daemon/processTable";

/** Scripted process discovery and liveness, without inspecting the host. */
export class FakeDaemonProcessTable implements DaemonProcessFinder, DaemonProcessLivenessChecker {
  scanCalls = 0;
  readonly scanTimeouts: Array<number | undefined> = [];
  readonly livePids = new Set<number>();
  records: DaemonProcessRecord[] = [];

  constructor(public script: (callNumber: number) => DaemonProcessRecord[] = () => []) {}

  findDaemonProcesses(timeoutMs?: number): DaemonProcessRecord[] {
    this.scanTimeouts.push(timeoutMs);
    this.records = this.script(++this.scanCalls);
    return this.records;
  }

  isProcessRunning(pid: number): boolean {
    return pid === process.pid || this.livePids.has(pid) || this.records.some((r) => r.pid === pid);
  }
}

export function unmarkedDaemonProcess(pid: number): DaemonProcessRecord {
  return { pid, ppid: 1, command: "auto-mobile --daemon-mode" };
}

export function namespaceDaemonProcess(pid: number, socketPath: string): DaemonProcessRecord {
  return {
    ...unmarkedDaemonProcess(pid),
    command: `auto-mobile --daemon-mode ${DAEMON_SOCKET_PATH_FLAG}=${encodeURIComponent(socketPath)}`,
  };
}
