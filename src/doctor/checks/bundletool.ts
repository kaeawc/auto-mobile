import type { CheckResult, DoctorProbeOptions } from "../types";
import { errorMessage } from "../../utils/describeUnknownError";
import {
  DefaultHostCommandExecutor,
  type HostCommandExecutor,
} from "../../utils/HostCommandExecutor";
import {
  BUNDLETOOL_INSTALL_STEPS,
  DefaultBundletoolLocator,
  type BundletoolLocator,
} from "../../utils/android-cmdline-tools/BundletoolLocator";
import { logger } from "../../utils/logger";

export interface BundletoolCheckDependencies {
  locator: BundletoolLocator;
  hostExecutor: HostCommandExecutor;
}

const NAME = "bundletool";

/**
 * bundletool is optional: only installApp's `.aab` and `.apks` routes need it, so a missing one
 * warns. A located bundletool must also run (`bundletool version`) to pass; its location is the
 * check value.
 */
export async function checkBundletool(
  probe: DoctorProbeOptions = {},
  dependencies: BundletoolCheckDependencies = {
    locator: new DefaultBundletoolLocator(),
    hostExecutor: new DefaultHostCommandExecutor(),
  },
): Promise<CheckResult> {
  const lookup = await dependencies.locator.locate();
  if (!lookup.found) {
    return {
      name: NAME,
      status: "warn",
      message: `bundletool not found (${lookup.reason}); installApp cannot install .aab or .apks artifacts`,
      recommendation: BUNDLETOOL_INSTALL_STEPS.join("; "),
    };
  }
  const { command } = lookup;
  try {
    const result = await dependencies.hostExecutor.executeCommand(
      command.file,
      [...command.args, "version"],
      { timeoutMs: probe.timeoutMs, signal: probe.signal },
    );
    return {
      name: NAME,
      status: "pass",
      message: `bundletool ${result.stdout.trim() || "(version unknown)"}`,
      value: command.location,
    };
  } catch (error) {
    logger.warn(`[doctor] bundletool version check failed: ${errorMessage(error)}`, error);
    return {
      name: NAME,
      status: "fail",
      message: `bundletool at ${command.location} did not run: ${errorMessage(error)}`,
      recommendation: BUNDLETOOL_INSTALL_STEPS.join("; "),
    };
  }
}
