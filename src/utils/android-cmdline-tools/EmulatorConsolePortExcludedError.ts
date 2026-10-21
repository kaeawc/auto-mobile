import { ENV } from "../../config/env";
import { ActionableError } from "../../models/ActionableError";

export class EmulatorConsolePortExcludedError extends ActionableError {
  readonly code = "emulator_console_port_excluded";

  constructor(readonly consolePort: number) {
    super(
      `Cannot launch an Android emulator: console port ${consolePort} is excluded by ` +
        `${ENV.EMULATOR_EXCLUDED_CONSOLE_PORTS.name}; choose another console port or update that variable.`,
    );
  }
}
