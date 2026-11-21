import type { RunnerPorts } from "../../src/features/shared/RunnerPortRetry";

/** Hands out the lowest port that is neither allocated nor quarantined, like PortManager. */
export class FakeRunnerPorts implements RunnerPorts {
  readonly allocations = new Map<string, number>();
  readonly quarantined: number[] = [];
  readonly events: string[] = [];
  allocate(deviceId: string): number {
    const existing = this.allocations.get(deviceId);
    if (existing !== undefined) {
      return existing;
    }
    let port = 8765;
    while (
      port === 8766 ||
      this.quarantined.includes(port) ||
      [...this.allocations.values()].includes(port)
    ) {
      port++;
    }
    this.allocations.set(deviceId, port);
    this.events.push(`allocate ${port}`);
    return port;
  }
  release(deviceId: string, port: number): void {
    if (this.allocations.get(deviceId) === port) {
      this.allocations.delete(deviceId);
      this.events.push(`release ${port}`);
    }
  }
  quarantine(port: number): void {
    this.quarantined.push(port);
    this.events.push(`quarantine ${port}`);
  }
}
