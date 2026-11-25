import { z } from "zod/v3";
import { toActionableError } from "../../models/ActionableError";
import { execFileAsync, type ExecFileAsync } from "../HostCommandExecutor";
import {
  type CarPlayProjectingState,
  type CarPlayProjectionProbe,
  requireCarPlayProjection,
} from "./carPlayProjection";
import type { CarPlayRuntimeReader } from "./carPlayRuntime";
import { runCarPlayPowerHelper } from "./carPlayScreenPower";

const tapResultSchema = z
  .object({
    tapped: z
      .object({
        x: z.number().finite(),
        y: z.number().finite(),
        screenID: z.number().int().nonnegative(),
        screenType: z.number().int().nonnegative(),
        target: z.number().int().nonnegative(),
        width: z.number().finite().positive(),
        height: z.number().finite().positive(),
      })
      .strict(),
  })
  .strict();
export type CarPlayTapResult = z.infer<typeof tapResultSchema>;

/** Creating the HID service, two touches and an 80 ms hold; the helper bounds each at 5 s. */
const TAP_HELPER_TIMEOUT_MS = 30000;

export interface CarPlayTapper {
  /** Taps the powered CarPlay screen at x, y in car-screen pixels. */
  tap(udid: string, x: number, y: number, signal?: AbortSignal): Promise<CarPlayTapResult>;
}

export function parseCarPlayTapResult(json: string): CarPlayTapResult {
  try {
    return tapResultSchema.parse(JSON.parse(json));
  } catch (error) {
    throw toActionableError(
      error,
      "Invalid carplay-power-helper tap JSON; rebuild the helper from ios/carplay-power",
    );
  }
}

export class DefaultCarPlayTapper implements CarPlayTapper {
  constructor(
    private readonly exec: ExecFileAsync = execFileAsync,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  async tap(udid: string, x: number, y: number, signal?: AbortSignal): Promise<CarPlayTapResult> {
    const stdout = await runCarPlayPowerHelper(
      { exec: this.exec, env: this.env },
      [udid, "tap", String(x), String(y)],
      TAP_HELPER_TIMEOUT_MS,
      signal,
    );
    return parseCarPlayTapResult(stdout);
  }
}

export interface CarPlayTapDependencies {
  probe: CarPlayProjectionProbe;
  runtime: CarPlayRuntimeReader;
  tapper: CarPlayTapper;
}

/**
 * Taps the CarPlay screen once the probe reports it as the car display; a screen that is not
 * projecting is refused before any touch is sent. The helper then refuses anything but a powered
 * TVOut or Wireless screen on iOS 26.x, and a point outside it.
 */
export async function tapCarPlayScreen(
  udid: string,
  point: { x: number; y: number },
  deps: CarPlayTapDependencies,
  signal?: AbortSignal,
): Promise<{ display: CarPlayProjectingState; tap: CarPlayTapResult["tapped"] }> {
  const display = await requireCarPlayProjection(udid, deps, {
    signal,
    skipped: "No touch was sent.",
  });
  const { tapped } = await deps.tapper.tap(udid, point.x, point.y, signal);
  return { display, tap: tapped };
}
