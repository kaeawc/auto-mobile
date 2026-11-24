import { z } from "zod/v3";
import { toActionableError } from "../../models/ActionableError";
import { execFileAsync, type ExecFileAsync } from "../HostCommandExecutor";
import {
  type CarPlayProjectingState,
  type CarPlayProjectionProbe,
  requireCarPlayProjection,
} from "./carPlayProjection";
import { runCarPlayPowerHelper } from "./carPlayScreenPower";

/** carplay-power-helper `input` names (#19059), in the helper's order. */
export const CARPLAY_INPUTS = [
  "back",
  "home",
  "siri",
  "knob-select",
  "knob-up",
  "knob-down",
  "knob-left",
  "knob-right",
  "knob-cw",
  "knob-ccw",
] as const;
export type CarPlayInput = (typeof CARPLAY_INPUTS)[number];

const inputResultSchema = z
  .object({
    sent: z
      .object({
        input: z.enum(CARPLAY_INPUTS),
        count: z.number().int().positive(),
        screenID: z.number().int().nonnegative(),
        screenType: z.number().int().nonnegative(),
        target: z.number().int().nonnegative(),
        usagePage: z.number().int().nonnegative().optional(),
        usage: z.number().int().nonnegative().optional(),
        scrollDelta: z.number().finite().optional(),
      })
      .strict(),
  })
  .strict();
export type CarPlayInputResult = z.infer<typeof inputResultSchema>;

/** Creating the HID service and up to 50 knob detents 50 ms apart; each send is bounded at 5 s. */
const INPUT_HELPER_TIMEOUT_MS = 30000;

export interface CarPlayInputSender {
  /** Sends one head-unit input to the powered CarPlay screen; count is knob detents. */
  send(
    udid: string,
    input: CarPlayInput,
    count: number,
    signal?: AbortSignal,
  ): Promise<CarPlayInputResult>;
}

export function parseCarPlayInputResult(json: string): CarPlayInputResult {
  try {
    return inputResultSchema.parse(JSON.parse(json));
  } catch (error) {
    throw toActionableError(
      error,
      "Invalid carplay-power-helper input JSON; rebuild the helper from ios/carplay-power",
    );
  }
}

export class DefaultCarPlayInputSender implements CarPlayInputSender {
  constructor(
    private readonly exec: ExecFileAsync = execFileAsync,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  async send(
    udid: string,
    input: CarPlayInput,
    count: number,
    signal?: AbortSignal,
  ): Promise<CarPlayInputResult> {
    const stdout = await runCarPlayPowerHelper(
      { exec: this.exec, env: this.env },
      [udid, "input", input, String(count)],
      INPUT_HELPER_TIMEOUT_MS,
      signal,
    );
    return parseCarPlayInputResult(stdout);
  }
}

export interface CarPlayInputDependencies {
  probe: CarPlayProjectionProbe;
  sender: CarPlayInputSender;
}

/**
 * Sends a head-unit input once the probe reports the car display; a screen that is not projecting
 * is refused before anything is sent. The helper then refuses anything but a powered TVOut or
 * Wireless screen on iOS 26.x whose StarkConfig declares the input's hardware.
 */
export async function sendCarPlayInput(
  udid: string,
  input: { name: CarPlayInput; count: number },
  deps: CarPlayInputDependencies,
  signal?: AbortSignal,
): Promise<{ display: CarPlayProjectingState; sent: CarPlayInputResult["sent"] }> {
  const display = await requireCarPlayProjection(udid, deps.probe, {
    signal,
    skipped: "No input was sent.",
  });
  const { sent } = await deps.sender.send(udid, input.name, input.count, signal);
  return { display, sent };
}
