import type { CheckResult, DoctorProbeOptions } from "../types";
import {
  DefaultHostCommandExecutor,
  type HostCommandExecutor,
} from "../../utils/HostCommandExecutor";
import { logger as sharedLogger } from "../../utils/logger";
import { errorMessage } from "../../utils/describeUnknownError";
import { PYTHON_INSTALL_FIX } from "../../features/blePeripheral/PythonEnvProvisioner";

/** Python is optional for other tools; absence disables blePeripheral and produces a warning. */
export async function checkPython3(
  probe: DoctorProbeOptions = {},
  deps: { commands: HostCommandExecutor; log: Pick<typeof sharedLogger, "warn"> } = {
    commands: new DefaultHostCommandExecutor(),
    log: sharedLogger,
  },
): Promise<CheckResult> {
  const logger = deps.log;
  try {
    const result = await deps.commands.executeCommand("python3", ["--version"], {
      timeoutMs: probe.timeoutMs ?? 5_000,
      signal: probe.signal,
    });
    return {
      name: "python3 (BLE peripheral)",
      status: "pass",
      message: result.stdout.trim() || result.stderr.trim(),
      value: "python3",
    };
  } catch (error) {
    logger.warn(`python3 check failed: ${errorMessage(error)}`, error);
    return {
      name: "python3 (BLE peripheral)",
      status: "warn",
      message: "python3 is unavailable; blePeripheral cannot start",
      recommendation: PYTHON_INSTALL_FIX,
    };
  }
}
