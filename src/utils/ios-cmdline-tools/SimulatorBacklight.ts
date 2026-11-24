import { z } from "zod/v4";
import { ActionableError } from "../../models/ActionableError";
import { execFileAsync, type ExecFileAsync } from "../HostCommandExecutor";
import {
  coreSimulatorJxaScript,
  resolveDeveloperDirectory,
  runCoreSimulatorJxa,
  type CoreSimulatorJxaFailure,
} from "./CoreSimulatorJxa";

/** Turns an iOS Simulator's display backlight on or off (#19018). */
export interface SimulatorBacklight {
  setActive(udid: string, active: boolean, signal?: AbortSignal): Promise<void>;
}

/** Whether a Simulator's device type has a Dynamic Island (#19018). */
export interface SimulatorDynamicIslandSupport {
  supportsDynamicIsland(udid: string, signal?: AbortSignal): Promise<boolean>;
}

const CALL_TIMEOUT_MS = 15_000;

/** Runs after the shared prelude on a booted device: argv[3] is "1" for on. */
const BACKLIGHT_BODY = `
  return JSON.stringify({ ok: device.setDisplayBacklightActiveError(argv[3] === "1", null) === true });
`;

/** Reads the device type's `DeviceSupportsDynamicIsland` capability; the device may be shut down. */
const ISLAND_SUPPORT_BODY = `
  const profile = device.deviceType.capabilities;
  const capabilities = profile.isNil() ? profile : profile.objectForKey("capabilities");
  const island = capabilities.isNil() ? capabilities : capabilities.objectForKey("DeviceSupportsDynamicIsland");
  return JSON.stringify({ ok: !island.isNil() && ObjC.unwrap(island) === true });
`;

/**
 * The `osascript` script that calls `-[SimDevice setDisplayBacklightActive:error:]` on the booted
 * device, which simctl does not expose.
 */
export const SIMULATOR_DEVICE_JXA = coreSimulatorJxaScript(BACKLIGHT_BODY, true);

const resultSchema = z.object({ ok: z.boolean() }).strict();

export { resolveDeveloperDirectory };

function failureMessage(code: CoreSimulatorJxaFailure, udid: string): string {
  switch (code) {
    case "device-not-found":
      return `Simulator ${udid} is not in the default CoreSimulator device set.`;
    case "device-not-booted":
      return `Simulator ${udid} is not booted; boot it before changing its backlight.`;
    default:
      return "CoreSimulator's SimDevice API is unavailable; check that DEVELOPER_DIR or xcode-select points at a supported Xcode.";
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
    const islandSupport = args[0] === "island-support";
    const result = await runCoreSimulatorJxa(
      {
        udid,
        body: islandSupport ? ISLAND_SUPPORT_BODY : BACKLIGHT_BODY,
        args,
        requireBooted: !islandSupport,
        timeoutMs: CALL_TIMEOUT_MS,
        ...(signal ? { signal } : {}),
        resultSchema,
        label: args[0] ?? "device",
        scriptPlaceholder: "<simulator device>",
        describeFailure: (code) => failureMessage(code, udid),
      },
      { exec: this.exec, developerDirectory: this.developerDirectory },
    );
    return result.ok;
  }
}
