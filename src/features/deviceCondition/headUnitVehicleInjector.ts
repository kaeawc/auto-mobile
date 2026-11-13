import type { DesktopHeadUnitConsole } from "../androidAuto/DesktopHeadUnit";
import { ActionableError } from "../../models/ActionableError";
import { logger } from "../../utils/logger";
import type { DeviceConditionInjector } from "./DeviceConditionController";
import { createSerializer } from "./injectorSupport";

/**
 * `deviceCondition.vehicle` on a phone projecting to a Desktop Head Unit (#17842). The DHU console
 * takes `day`/`night` and `restrict all`/`restrict none` but reports neither back, so the applied
 * value is what this injector last sent, and reset sends the DHU's start state: day, unrestricted.
 */

export type HeadUnitVehicleKey = "vehicle.motion" | "vehicle.nightMode";

/** The daemon's running DHU for a phone, or undefined when it runs none. */
export type HeadUnitConsoleLookup = (
  deviceId: string,
) => Pick<DesktopHeadUnitConsole, "sendCommand" | "isRunning" | "panel"> | undefined;

interface HeadUnitVehicleCommands {
  values: Readonly<Record<string, string>>;
  /** What the DHU starts in, sent on reset. */
  restore: string;
}

export const HEAD_UNIT_VEHICLE_COMMANDS: Readonly<
  Record<HeadUnitVehicleKey, HeadUnitVehicleCommands>
> = {
  "vehicle.nightMode": { values: { on: "night", off: "day" }, restore: "day" },
  "vehicle.motion": {
    values: { driving: "restrict all", parked: "restrict none" },
    restore: "restrict none",
  },
};

/** The phone's running DHU, or undefined when there is none to send to. */
export function runningHeadUnit(lookup: HeadUnitConsoleLookup, deviceId: string) {
  const dhuConsole = lookup(deviceId);
  return dhuConsole?.isRunning() ? dhuConsole : undefined;
}

/**
 * One vehicle key on one phone's head unit. The caller validates `value` against the key's allowed
 * values before apply.
 */
export function createHeadUnitVehicleInjector(
  key: HeadUnitVehicleKey,
  deviceId: string,
  lookup: HeadUnitConsoleLookup,
): DeviceConditionInjector {
  const { values, restore: restoreCommand } = HEAD_UNIT_VEHICLE_COMMANDS[key];
  const serial = createSerializer();
  /** The command last sent for a value, until reset sends the start state. */
  let applied: string | undefined;
  /** The DHU it was sent to: a restarted DHU starts day and unrestricted, so it needs it again. */
  let appliedTo: string | undefined;
  const restore = (): Promise<void> =>
    serial(async () => {
      if (applied === undefined) {
        return;
      }
      const dhuConsole = runningHeadUnit(lookup, deviceId);
      if (dhuConsole) {
        dhuConsole.sendCommand(restoreCommand);
      } else {
        // A DHU that exited takes none of this state with it: the next one starts day, unrestricted.
        logger.debug(`[AndroidAuto] ${key} reset skipped: no running head unit for ${deviceId}`);
      }
      applied = undefined;
      appliedTo = undefined;
    });
  return {
    key,
    apply: (value) =>
      serial(async () => {
        const command = values[value];
        const dhuConsole = runningHeadUnit(lookup, deviceId);
        if (!dhuConsole) {
          throw new ActionableError(`No Desktop Head Unit is running for ${deviceId}`);
        }
        const instance = dhuConsole.panel?.instance;
        // Without a panel the DHU process is unknown, so the command is sent again.
        if (applied === command && instance !== undefined && appliedTo === instance) {
          return {
            status: "unchanged",
            detail: `head unit already sent ${command}`,
            reset: restore,
          };
        }
        dhuConsole.sendCommand(command);
        applied = command;
        appliedTo = instance;
        return {
          status: "applied",
          detail: `head unit console: ${command} (the DHU does not report it back)`,
          reset: restore,
        };
      }),
    isClean: async () => applied === undefined,
  };
}
