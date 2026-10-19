import { ActionableError } from "../../models";

export class SimulatorStillShuttingDownError extends ActionableError {
  constructor(
    readonly udid: string,
    readonly deviceName: string,
    readonly lastState: string | undefined,
    readonly waitedMs: number,
    readonly launchdSimPid?: number,
  ) {
    super(
      `simctl shutdown returned but iOS simulator '${deviceName}' (${udid}) was still ${lastState ?? "unknown"} after ${waitedMs} ms.` +
        " The shutdown may still complete; check with xcrun simctl list devices. Retrying is safe." +
        (launchdSimPid === undefined
          ? ""
          : ` Its launchd_sim process is pid ${launchdSimPid}; this daemon did not signal it, CoreSimulator may respawn it.`) +
        " An application displaying the device can also keep it booted.",
    );
    this.name = "SimulatorStillShuttingDownError";
  }
}
