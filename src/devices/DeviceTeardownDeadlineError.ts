import { ActionableError } from "../models";

export class DeviceTeardownDeadlineError extends ActionableError {
  constructor() {
    super("Device teardown deadline exceeded");
  }
}
