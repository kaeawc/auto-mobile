import { toActionableError } from "../../models/ActionableError";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { AdbPowerClient } from "../utility/power/AndroidPowerClient";

export type AmbientAction = "enter" | "exit";
type Wakefulness = NonNullable<Awaited<ReturnType<AdbExecutor["getWakefulness"]>>>;

export interface AmbientResult {
  success: boolean;
  action: AmbientAction;
  wakefulness?: Wakefulness;
  message: string;
  reason?: string;
}

export interface Ambient {
  change(action: AmbientAction, signal?: AbortSignal): Promise<AmbientResult>;
}

export type AmbientAdb = Pick<AdbExecutor, "execute" | "isScreenOn" | "getWakefulness">;

/** Power-state control only: Wear does not expose a usable ambient readback. */
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
      const success =
        action === "enter"
          ? wakefulness === "Dozing" || wakefulness === "Asleep"
          : wakefulness === "Awake";
      return {
        success,
        action,
        ...(wakefulness ? { wakefulness } : {}),
        message:
          "This is a power-state change. Wear exposes no ambient readback, so the result does not prove ambient mode.",
        ...(!success
          ? {
              reason: wakefulness
                ? `Observed wakefulness ${wakefulness} after ${action}.`
                : "Wakefulness could not be read after the power-state change.",
            }
          : {}),
      };
    } catch (error) {
      throw toActionableError(error, `Failed to ${action} ambient power state`);
    }
  }
}
