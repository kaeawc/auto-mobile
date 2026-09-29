import type { PortAvailabilityChecker } from "../../src/utils/PortManager";

export class FakePortAvailabilityChecker implements PortAvailabilityChecker {
  public readonly checkedPorts: number[] = [];

  public constructor(private readonly unavailablePorts: Set<number> = new Set()) {}

  public isPortAvailable(port: number): boolean {
    this.checkedPorts.push(port);
    return !this.unavailablePorts.has(port);
  }
}
