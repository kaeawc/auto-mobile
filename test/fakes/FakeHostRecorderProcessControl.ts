import type { HostRecorderProcessControl } from "../../src/features/video/hostRecorderTeardown";

export class FakeHostRecorderProcessControl implements HostRecorderProcessControl {
  running = true;
  token: string | undefined = "generation-a";
  tokenReads = 0;
  signals: Array<[number, "SIGINT" | "SIGKILL"]> = [];
  onSignal?: (sig: "SIGINT" | "SIGKILL") => void;
  readStartToken(_pid: number): string | undefined {
    this.tokenReads++;
    return this.token;
  }
  isRunning(_pid: number): boolean {
    return this.running;
  }
  signal(pid: number, sig: "SIGINT" | "SIGKILL"): void {
    this.signals.push([pid, sig]);
    this.onSignal?.(sig);
  }
}
