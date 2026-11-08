import { toActionableError } from "../../models/ActionableError";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { errorMessage } from "../../models/describeUnknownError";
import { logger } from "../../utils/logger";
import { AdbPowerClient } from "../utility/power/AndroidPowerClient";
import {
  parseWatchFaceState,
  readWearServiceDumpsys,
  type WatchFaceState,
} from "./wearServiceDumpsys";

export type AmbientAction = "enter" | "exit";
type Wakefulness = NonNullable<Awaited<ReturnType<AdbExecutor["getWakefulness"]>>>;

export interface AmbientResult {
  success: boolean;
  action: AmbientAction;
  /** `inAmbient` from `dumpsys wear_service`; `"unknown"` when that line could not be read. */
  ambient: boolean | "unknown";
  watchFaceVisible?: boolean;
  wakefulness?: Wakefulness;
  message: string;
  reason?: string;
}

export interface Ambient {
  change(action: AmbientAction, signal?: AbortSignal): Promise<AmbientResult>;
}

export type AmbientAdb = Pick<AdbExecutor, "execute" | "isScreenOn" | "getWakefulness">;

const STAY_AWAKE_HINT =
  " A stay-awake setting (svc power stayon true) keeps the display on; turn it off and retry.";

function wakefulnessSuccess(action: AmbientAction, wakefulness: Wakefulness | null): boolean {
  return action === "enter"
    ? wakefulness === "Dozing" || wakefulness === "Asleep"
    : wakefulness === "Awake";
}

function isSuccess(
  action: AmbientAction,
  state: WatchFaceState | null,
  wakefulness: Wakefulness | null,
): boolean {
  if (!state) {
    return wakefulnessSuccess(action, wakefulness);
  }
  return action === "enter" ? state.inAmbient : !state.inAmbient && wakefulness === "Awake";
}

function failureReason(
  action: AmbientAction,
  state: WatchFaceState | null,
  wakefulness: Wakefulness | null,
): string {
  const observed = wakefulness
    ? `Observed wakefulness ${wakefulness} after ${action}.`
    : "Wakefulness could not be read after the power-state change.";
  const ambient = state
    ? ` dumpsys wear_service reports inAmbient=${state.inAmbient}.${state.watchFaceVisible ? "" : " The watch face is not on screen (watchFaceVisible=false)."}`
    : "";
  const hint = action === "enter" && wakefulness === "Awake" ? STAY_AWAKE_HINT : "";
  return `${observed}${ambient}${hint}`;
}

function summary(state: WatchFaceState | null): string {
  return state
    ? `Ambient read from dumpsys wear_service (inAmbient=${state.inAmbient}, watchFaceVisible=${state.watchFaceVisible}). A screenshot shows the dimmed ambient render.`
    : "dumpsys wear_service reported no watch-face state, so success is judged from wakefulness only and does not prove ambient mode.";
}

/** KEYCODE_SLEEP/WAKEUP, then wakefulness plus the watch face's `inAmbient` from `dumpsys wear_service`. */
export class AdbAmbient implements Ambient {
  constructor(private readonly adb: AmbientAdb) {}

  async change(action: AmbientAction, signal?: AbortSignal): Promise<AmbientResult> {
    try {
      signal?.throwIfAborted();
      const power = new AdbPowerClient(this.adb);
      if (action === "enter") {
        await power.sleepScreen();
      } else {
        await power.wakeScreen();
      }
      signal?.throwIfAborted();
      const wakefulness = await this.adb.getWakefulness(signal);
      signal?.throwIfAborted();
      const state = await this.readWatchFaceState(signal);
      signal?.throwIfAborted();
      const success = isSuccess(action, state, wakefulness);
      return {
        success,
        action,
        ambient: state ? state.inAmbient : "unknown",
        ...(state ? { watchFaceVisible: state.watchFaceVisible } : {}),
        ...(wakefulness ? { wakefulness } : {}),
        message: summary(state),
        ...(!success ? { reason: failureReason(action, state, wakefulness) } : {}),
      };
    } catch (error) {
      throw toActionableError(error, `Failed to ${action} ambient power state`);
    }
  }

  private async readWatchFaceState(signal?: AbortSignal): Promise<WatchFaceState | null> {
    try {
      return parseWatchFaceState(await readWearServiceDumpsys(this.adb, signal));
    } catch (error) {
      signal?.throwIfAborted();
      logger.warn(`[ambient] dumpsys wear_service read failed: ${errorMessage(error)}`, error);
      return null;
    }
  }
}
