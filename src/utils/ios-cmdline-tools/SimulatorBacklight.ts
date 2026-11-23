import { toActionableError } from "../../models/ActionableError";
import { runExecSeam } from "../ExecSeam";
import { execFileAsync, type ExecFileAsync } from "../HostCommandExecutor";

/** Turns an iOS Simulator's display backlight on or off (#19018). */
export interface SimulatorBacklight {
  setActive(udid: string, active: boolean, signal?: AbortSignal): Promise<void>;
}

const BACKLIGHT_TIMEOUT_MS = 15_000;

/**
 * `-[SimDevice setDisplayBacklightActive:error:]` from CoreSimulator, which simctl does not
 * expose. JavaScript for Automation reaches it through the Objective-C bridge in a short-lived
 * `osascript`, so the private framework never loads into the daemon and needs no build step.
 * The developer directory follows `DEVELOPER_DIR`, else the `xcode-select` link.
 */
export const SIMULATOR_BACKLIGHT_SCRIPT = `ObjC.import("Foundation");
function run(argv) {
  const udid = argv[0];
  const active = argv[1] === "true";
  const fromEnv = $.NSProcessInfo.processInfo.environment.objectForKey("DEVELOPER_DIR");
  const developerDir = fromEnv.isNil() || ObjC.unwrap(fromEnv) === ""
    ? ObjC.unwrap($.NSFileManager.defaultManager.destinationOfSymbolicLinkAtPathError("/var/db/xcode_select_link", null))
    : ObjC.unwrap(fromEnv);
  if (!$.NSBundle.bundleWithPath("/Library/Developer/PrivateFrameworks/CoreSimulator.framework").load) {
    throw new Error("CoreSimulator.framework could not be loaded");
  }
  const error = Ref();
  const context = $.NSClassFromString("SimServiceContext").sharedServiceContextForDeveloperDirError(developerDir, error);
  if (context.isNil()) throw new Error("No CoreSimulator service context for " + developerDir);
  const device = context.defaultDeviceSetWithError(error).devicesByUDID.objectForKey($.NSUUID.alloc.initWithUUIDString(udid));
  if (device.isNil()) throw new Error("Simulator " + udid + " is not in the default device set");
  if (!device.setDisplayBacklightActiveError(active, error)) {
    throw new Error(error[0].isNil() ? "setDisplayBacklightActive failed" : ObjC.unwrap(error[0].localizedDescription));
  }
  return "ok";
}`;

export class OsascriptSimulatorBacklight implements SimulatorBacklight {
  constructor(private readonly exec: ExecFileAsync = execFileAsync) {}

  async setActive(udid: string, active: boolean, signal?: AbortSignal): Promise<void> {
    const args = ["-l", "JavaScript", "-e", SIMULATOR_BACKLIGHT_SCRIPT, udid, String(active)];
    try {
      await runExecSeam(
        (options) => this.exec("osascript", args, options),
        { timeoutMs: BACKLIGHT_TIMEOUT_MS, signal },
        { command: "osascript", args: ["-l", "JavaScript", "<backlight script>", udid] },
      );
    } catch (error) {
      throw toActionableError(
        error,
        `Failed to turn the Simulator ${udid} backlight ${active ? "on" : "off"} through CoreSimulator`,
      );
    }
  }
}
