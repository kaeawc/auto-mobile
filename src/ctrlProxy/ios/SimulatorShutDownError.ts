import { ActionableError } from "../../models/ActionableError";

export class SimulatorShutDownError extends ActionableError {
  constructor(deviceId: string) {
    super(
      `Simulator ${deviceId} is shut down or no longer exists, and the runner does not auto-boot it. Start the simulator explicitly before retrying.`,
    );
    this.name = "SimulatorShutDownError";
  }
}
