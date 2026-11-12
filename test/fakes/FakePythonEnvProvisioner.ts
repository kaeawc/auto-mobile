import type { PythonEnvProvisioner } from "../../src/features/blePeripheral/PythonEnvProvisioner";

export class FakePythonEnvProvisioner implements PythonEnvProvisioner {
  calls = 0;
  gate?: Promise<void>;
  error?: Error;
  async ensure(): Promise<string> {
    this.calls++;
    await this.gate;
    if (this.error) {
      throw this.error;
    }
    return "/fake/ble/venv/python3";
  }
}
