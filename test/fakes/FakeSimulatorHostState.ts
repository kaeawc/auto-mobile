import type { SimulatorHostState } from "../../src/utils/ios-cmdline-tools/SimulatorPrebootProfile";

export class FakeSimulatorHostState implements SimulatorHostState {
  readonly calls: unknown[][] = [];
  existing: Record<string, unknown> = {};
  written?: Record<string, unknown>;
  writeError?: Error;
  removeError?: Error;
  async mkdirPrivate(path: string): Promise<void> {
    this.calls.push(["mkdir", path]);
  }
  async readExisting(path: string): Promise<Record<string, unknown>> {
    this.calls.push(["read", path]);
    return this.existing;
  }
  async writeBinaryPlist(path: string, value: Record<string, unknown>): Promise<void> {
    this.calls.push(["write", path]);
    if (this.writeError) {
      throw this.writeError;
    }
    this.written = value;
  }
  async rmDir(path: string): Promise<void> {
    this.calls.push(["rm", path]);
    if (this.removeError) {
      throw this.removeError;
    }
  }
}
