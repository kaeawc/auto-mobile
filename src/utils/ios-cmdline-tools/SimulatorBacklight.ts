import { realpath } from "node:fs/promises";
import path from "node:path";
import { z } from "zod/v4";
import { AMBIENT_ENV, readEnvTrimmed } from "../../config/env";
import { ActionableError, toActionableError } from "../../models/ActionableError";
import { runExecSeam } from "../ExecSeam";
import { execFileAsync, type ExecFileAsync } from "../HostCommandExecutor";

/** Turns an iOS Simulator's display backlight on or off (#19018). */
export interface SimulatorBacklight {
  setActive(udid: string, active: boolean, signal?: AbortSignal): Promise<void>;
}

/** Whether a Simulator's device type has a Dynamic Island (#19018). */
export interface SimulatorDynamicIslandSupport {
  supportsDynamicIsland(udid: string, signal?: AbortSignal): Promise<boolean>;
}

const CALL_TIMEOUT_MS = 15_000;

/**
 * JavaScript for Automation run by `osascript`: it loads the system CoreSimulator framework and
 * either calls `-[SimDevice setDisplayBacklightActive:error:]` on the booted device, which simctl
 * does not expose, or reads the device type's `DeviceSupportsDynamicIsland` capability. Error
 * out-parameters are passed as null: boxing the NSError a failed call returns crashes the JXA
 * bridge (osascript dies on SIGSEGV). A separate process keeps the private framework out of the
 * daemon.
 */
export const SIMULATOR_DEVICE_JXA = `
ObjC.import("Foundation");
function run(argv) {
  const developerDir = argv[0], udid = argv[1], action = argv[2];
  const bundle = $.NSBundle.bundleWithPath("/Library/Developer/PrivateFrameworks/CoreSimulator.framework");
  if (bundle.isNil() || !bundle.load) return JSON.stringify({ error: "private-api-unavailable" });
  const contextClass = $.NSClassFromString("SimServiceContext");
  if (contextClass.isNil()) return JSON.stringify({ error: "private-api-unavailable" });
  const context = contextClass.sharedServiceContextForDeveloperDirError($(developerDir), null);
  if (context.isNil()) return JSON.stringify({ error: "private-api-unavailable" });
  const set = context.defaultDeviceSetWithError(null);
  if (set.isNil()) return JSON.stringify({ error: "private-api-unavailable" });
  const id = $.NSUUID.alloc.initWithUUIDString($(udid));
  const device = id.isNil() ? id : set.devicesByUDID.objectForKey(id);
  if (device.isNil()) return JSON.stringify({ error: "device-not-found" });
  if (action === "island-support") {
    const profile = device.deviceType.capabilities;
    const capabilities = profile.isNil() ? profile : profile.objectForKey("capabilities");
    const island = capabilities.isNil() ? capabilities : capabilities.objectForKey("DeviceSupportsDynamicIsland");
    return JSON.stringify({ ok: !island.isNil() && ObjC.unwrap(island) === true });
  }
  if (Number(device.state) !== 3) return JSON.stringify({ error: "device-not-booted" });
  return JSON.stringify({ ok: device.setDisplayBacklightActiveError(argv[3] === "1", null) === true });
}
`;

const outputSchema = z.union([
  z.object({ ok: z.boolean() }).strict(),
  z
    .object({ error: z.enum(["private-api-unavailable", "device-not-found", "device-not-booted"]) })
    .strict(),
]);

/**
 * The active Xcode developer directory, as CoreSimulator wants it: `DEVELOPER_DIR` (an `.app`
 * path means its `Contents/Developer`), else the `xcode-select` link.
 */
export async function resolveDeveloperDirectory(
  env: NodeJS.ProcessEnv = process.env,
  resolve: (target: string) => Promise<string> = realpath,
): Promise<string> {
  const selected = await resolve(
    readEnvTrimmed(AMBIENT_ENV.DEVELOPER_DIR, env) || "/var/db/xcode_select_link",
  );
  return selected.endsWith(".app") ? path.join(selected, "Contents/Developer") : selected;
}

function failureMessage(code: string, udid: string): string {
  switch (code) {
    case "device-not-found":
      return `Simulator ${udid} is not in the default CoreSimulator device set.`;
    case "device-not-booted":
      return `Simulator ${udid} is not booted; boot it before changing its backlight.`;
    default:
      return "CoreSimulator's SimDevice API is unavailable; check that DEVELOPER_DIR or xcode-select points at a supported Xcode.";
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text.trim());
  } catch (error) {
    // Unparseable output falls through to the schema failure, which reports the text.
    return { unparseable: String(error) };
  }
}

export class OsascriptSimulatorBacklight
  implements SimulatorBacklight, SimulatorDynamicIslandSupport
{
  constructor(
    private readonly exec: ExecFileAsync = execFileAsync,
    private readonly developerDirectory: () => Promise<string> = () => resolveDeveloperDirectory(),
  ) {}

  async setActive(udid: string, active: boolean, signal?: AbortSignal): Promise<void> {
    const ok = await this.call(udid, ["backlight", active ? "1" : "0"], signal);
    if (!ok) {
      throw new ActionableError(
        `CoreSimulator refused to turn the Simulator ${udid} backlight ${active ? "on" : "off"}.`,
      );
    }
  }

  async supportsDynamicIsland(udid: string, signal?: AbortSignal): Promise<boolean> {
    return this.call(udid, ["island-support"], signal);
  }

  private async call(udid: string, args: string[], signal?: AbortSignal): Promise<boolean> {
    const argv = [
      "-l",
      "JavaScript",
      "-e",
      SIMULATOR_DEVICE_JXA,
      await this.developerDirectory(),
      udid,
      ...args,
    ];
    let stdout: string;
    try {
      const result = await runExecSeam(
        (execOptions) => this.exec("osascript", argv, execOptions),
        { timeoutMs: CALL_TIMEOUT_MS, ...(signal ? { signal } : {}) },
        { command: "osascript", args: ["-l", "JavaScript", "<simulator device>", udid, ...args] },
      );
      stdout = result.stdout;
    } catch (error) {
      throw toActionableError(error, `Simulator ${args[0]} call failed on ${udid}`);
    }
    const parsed = outputSchema.safeParse(parseJson(stdout));
    if (!parsed.success) {
      throw new ActionableError(
        `Simulator ${args[0]} call on ${udid} printed unexpected output: ${stdout.trim().slice(0, 200)}`,
      );
    }
    if ("error" in parsed.data) {
      throw new ActionableError(failureMessage(parsed.data.error, udid));
    }
    return parsed.data.ok;
  }
}
