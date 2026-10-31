import { ActionableError } from "../../models";

/** What the shutdown wait last observed before giving up. */
export interface SimulatorShutdownWaitDetails {
  lastState: string | undefined;
  waitedMs: number;
  launchdSimPid?: number;
}

export class SimulatorStillShuttingDownError extends ActionableError {
  readonly udid: string;
  readonly deviceName: string;
  readonly lastState: string | undefined;
  readonly waitedMs: number;
  readonly launchdSimPid?: number;

  constructor(
    udid: string,
    deviceName: string,
    { lastState, waitedMs, launchdSimPid }: SimulatorShutdownWaitDetails,
  ) {
    super(
      `simctl shutdown returned but iOS simulator '${deviceName}' (${udid}) was still ${lastState ?? "unknown"} after ${waitedMs} ms.` +
        " The shutdown may still complete; check with xcrun simctl list devices. Retrying is safe." +
        (launchdSimPid === undefined
          ? ""
          : ` Its launchd_sim process is pid ${launchdSimPid}; this daemon did not signal it, CoreSimulator may respawn it.`) +
        " An application displaying the device can also keep it booted.",
    );
    this.udid = udid;
    this.deviceName = deviceName;
    this.lastState = lastState;
    this.waitedMs = waitedMs;
    this.launchdSimPid = launchdSimPid;
    this.name = "SimulatorStillShuttingDownError";
  }
}
