import type { SimCtl } from "../../utils/ios-cmdline-tools/SimCtlClient";
import {
  OsascriptSimulatorBacklight,
  type SimulatorBacklight,
} from "../../utils/ios-cmdline-tools/SimulatorBacklight";
import { parseNotifyutilState } from "../../utils/ios-cmdline-tools/notifyutil";
import { looksLikeMissingIosDefault } from "../preferences/preferenceValues";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";

/**
 * The SpringBoard default that hides the Dynamic Island. `-[SimDevice
 * setDynamicIslandSuppressed:error:]` only writes this key through CoreSimulatorBridge, and
 * SpringBoard observes it, so a `defaults` write has the same effect and can be read back (#19018).
 */
export const DYNAMIC_ISLAND_DEFAULTS_DOMAIN = "com.apple.springboard";
export const DYNAMIC_ISLAND_SUPPRESSED_KEY = "SBSuppressDynamicIslandCompletely";
/** SpringBoard posts 1 once the display is off and 0 while it is lit. */
export const BACKLIGHT_BLANKED_NOTIFY_KEY = "com.apple.springboard.hasBlankedScreen";

/** The journal key of the Dynamic Island default, in the `domain:key` preference form. */
export const DYNAMIC_ISLAND_PREFERENCE_KEY = `${DYNAMIC_ISLAND_DEFAULTS_DOMAIN}:${DYNAMIC_ISLAND_SUPPRESSED_KEY}`;

export const DYNAMIC_ISLAND_STATES = ["hidden", "visible"] as const;
export type DynamicIslandState = (typeof DYNAMIC_ISLAND_STATES)[number];

export const SCREEN_CONTROL_FIELDS = ["dynamicIsland", "backlight"] as const;

export interface IosSimulatorScreenValues {
  dynamicIsland?: DynamicIslandState;
  /** True while the display is lit; false once the backlight is off. */
  backlight?: boolean;
}

export interface IosSimulatorScreenChange {
  previous: IosSimulatorScreenValues;
  applied: IosSimulatorScreenValues;
  errors: string[];
}

/** True when a request names a Dynamic Island or backlight value. */
export function hasScreenControlField(input: IosSimulatorScreenValues): boolean {
  return input.dynamicIsland !== undefined || input.backlight !== undefined;
}

/** Turning the backlight off animates for about a second before SpringBoard reports it. */
const BACKLIGHT_SETTLE_POLL_MS = 250;
const BACKLIGHT_SETTLE_ATTEMPTS = 12;

export interface IosSimulatorScreenControlsDependencies {
  backlight?: SimulatorBacklight;
  timer?: Timer;
}

type SimctlRunner = Pick<SimCtl, "executeCommandArgs">;

/** Dynamic Island visibility and display backlight of one iOS Simulator (#19018). */
export class IosSimulatorScreenControls {
  private readonly backlight: SimulatorBacklight;
  private readonly timer: Timer;

  constructor(
    private readonly udid: string,
    private readonly simctl: SimctlRunner,
    dependencies: IosSimulatorScreenControlsDependencies = {},
  ) {
    this.backlight = dependencies.backlight ?? new OsascriptSimulatorBacklight();
    this.timer = dependencies.timer ?? defaultTimer;
  }

  async read(): Promise<IosSimulatorScreenValues> {
    const [dynamicIsland, backlight] = await Promise.all([
      this.readDynamicIsland(),
      this.readBacklight(),
    ]);
    return {
      ...(dynamicIsland !== undefined ? { dynamicIsland } : {}),
      ...(backlight !== undefined ? { backlight } : {}),
    };
  }

  /** The Dynamic Island default as `defaults` stores it: true, false, or null when unset. */
  async readIslandSuppressedDefault(): Promise<boolean | null> {
    try {
      const result = await this.simctl.executeCommandArgs([
        "spawn",
        this.udid,
        "defaults",
        "read",
        DYNAMIC_ISLAND_DEFAULTS_DOMAIN,
        DYNAMIC_ISLAND_SUPPRESSED_KEY,
      ]);
      return result.stdout.trim() === "1";
    } catch (error) {
      if (looksLikeMissingIosDefault(error)) {
        // An unset key is the pristine state: the island is shown.
        logger.debug(`[DisplayConfig] ${DYNAMIC_ISLAND_SUPPRESSED_KEY} is unset on ${this.udid}`);
        return null;
      }
      throw error;
    }
  }

  /** Display lit (true) or off (false), from SpringBoard's blanked-screen notify state. */
  async readBacklightOrThrow(): Promise<boolean> {
    const result = await this.simctl.executeCommandArgs([
      "spawn",
      this.udid,
      "notifyutil",
      "-g",
      BACKLIGHT_BLANKED_NOTIFY_KEY,
    ]);
    const blanked = parseNotifyutilState(result.stdout);
    if (blanked === null) {
      throw new Error(`notifyutil reported no ${BACKLIGHT_BLANKED_NOTIFY_KEY} state`);
    }
    return !blanked;
  }

  /**
   * Apply the requested values, or with `reset` restore the defaults. Every failure is returned
   * in `errors` beside the values read before the change.
   */
  async set(input: IosSimulatorScreenValues, reset = false): Promise<IosSimulatorScreenChange> {
    const previous = await this.read();
    const target = reset ? resetTarget(previous) : input;
    const errors: string[] = [];
    if (target.dynamicIsland !== undefined) {
      errors.push(...(await this.writeDynamicIsland(target.dynamicIsland)));
    }
    if (target.backlight !== undefined) {
      errors.push(...(await this.writeBacklight(target.backlight)));
    }
    const applied = await this.read();
    errors.push(...verify(target, applied));
    return { previous, applied, errors };
  }

  private async readDynamicIsland(): Promise<DynamicIslandState | undefined> {
    try {
      return (await this.readIslandSuppressedDefault()) === true ? "hidden" : "visible";
    } catch (error) {
      logger.warn(
        `[DisplayConfig] Dynamic Island read failed on ${this.udid}: ${errorMessage(error)}`,
        error,
      );
      return undefined;
    }
  }

  private async readBacklight(): Promise<boolean | undefined> {
    try {
      return await this.readBacklightOrThrow();
    } catch (error) {
      logger.warn(
        `[DisplayConfig] backlight read failed on ${this.udid}: ${errorMessage(error)}`,
        error,
      );
      return undefined;
    }
  }

  /** `hidden` writes the default; `visible` deletes it, the state a fresh Simulator has. */
  private async writeDynamicIsland(state: DynamicIslandState): Promise<string[]> {
    const args =
      state === "hidden"
        ? ["write", DYNAMIC_ISLAND_DEFAULTS_DOMAIN, DYNAMIC_ISLAND_SUPPRESSED_KEY, "-bool", "YES"]
        : ["delete", DYNAMIC_ISLAND_DEFAULTS_DOMAIN, DYNAMIC_ISLAND_SUPPRESSED_KEY];
    try {
      await this.simctl.executeCommandArgs(["spawn", this.udid, "defaults", ...args]);
      return [];
    } catch (error) {
      if (state === "visible" && looksLikeMissingIosDefault(error)) {
        // Deleting an unset key leaves the island shown, which is the requested state.
        logger.debug(`[DisplayConfig] ${DYNAMIC_ISLAND_SUPPRESSED_KEY} was already unset`);
        return [];
      }
      logger.warn(`[DisplayConfig] Dynamic Island write failed: ${errorMessage(error)}`, error);
      return [`Setting the Dynamic Island ${state} failed: ${errorMessage(error)}`];
    }
  }

  private async writeBacklight(active: boolean): Promise<string[]> {
    try {
      await this.backlight.setActive(this.udid, active);
    } catch (error) {
      logger.warn(`[DisplayConfig] backlight write failed: ${errorMessage(error)}`, error);
      return [errorMessage(error)];
    }
    await this.awaitBacklight(active);
    return [];
  }

  /** Poll until SpringBoard reports the requested backlight, so the post-read sees it. */
  private async awaitBacklight(active: boolean): Promise<void> {
    for (let attempt = 0; attempt < BACKLIGHT_SETTLE_ATTEMPTS; attempt++) {
      if ((await this.readBacklight()) === active) {
        return;
      }
      await this.timer.sleep(BACKLIGHT_SETTLE_POLL_MS);
    }
  }
}

/**
 * A reset shows a hidden island and lights a dark display. It changes only what it read as
 * changed, so a Simulator already in the default state (or one it cannot read) is left alone.
 */
function resetTarget(previous: IosSimulatorScreenValues): IosSimulatorScreenValues {
  return {
    ...(previous.dynamicIsland === "hidden" ? { dynamicIsland: "visible" as const } : {}),
    ...(previous.backlight === false ? { backlight: true } : {}),
  };
}

function verify(target: IosSimulatorScreenValues, applied: IosSimulatorScreenValues): string[] {
  return [
    ...(target.dynamicIsland !== undefined && applied.dynamicIsland !== target.dynamicIsland
      ? [
          `Dynamic Island remained ${String(applied.dynamicIsland)} after requesting ${target.dynamicIsland}`,
        ]
      : []),
    ...(target.backlight !== undefined && applied.backlight !== target.backlight
      ? [
          `Simulator backlight remained ${describeBacklight(applied.backlight)} after requesting ${describeBacklight(target.backlight)}`,
        ]
      : []),
  ];
}

function describeBacklight(value: boolean | undefined): string {
  return value === undefined ? "unreadable" : value ? "on" : "off";
}
