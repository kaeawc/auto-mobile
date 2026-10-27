import { ActionableError } from "../../models/ActionableError";

export class SimulatorContainerUnresolvedError extends ActionableError {
  readonly reason = "empty";
  constructor(
    readonly deviceId: string,
    readonly bundleId: string,
  ) {
    super(
      `No simulator container path returned for ${bundleId} on ${deviceId}. Confirm the app is installed and retry.`,
    );
  }
}
