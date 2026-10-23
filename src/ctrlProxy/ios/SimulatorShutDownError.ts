import { ActionableError } from "../../models/ActionableError";

export class SimulatorShutDownError extends ActionableError {
  constructor(deviceId: string) {
    super(
      `Simulator ${deviceId} was shut down externally and is not auto-booted by the runner. Start the simulator explicitly before retrying.`,
    );
    this.name = "SimulatorShutDownError";
  }
}
