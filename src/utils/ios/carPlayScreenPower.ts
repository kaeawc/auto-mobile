import { z } from "zod/v3";
import { ENV, readEnvRaw } from "../../config/env";
import { ActionableError, toActionableError } from "../../models/ActionableError";
import { execFileAsync, type ExecFileAsync } from "../HostCommandExecutor";
import { runExecSeam } from "../ExecSeam";

const screen = z
  .object({
    id: z.number().int().nonnegative(),
    name: z.string(),
    screenType: z.number().int().nonnegative(),
    powerState: z.number().int(),
    width: z.number().finite().nonnegative(),
    height: z.number().finite().nonnegative(),
  })
  .strict();
const stateSchema = z
  .object({
    screens: z.array(screen),
    carPlay: z
      .object({
        found: z.boolean(),
        screenID: z.number().int().nonnegative().nullable(),
        powerState: z.number().int().nullable(),
      })
      .strict(),
  })
  .strict();
const failureSchema = z
  .object({
    error: z
      .object({
        code: z.enum([
          "device-not-found",
          "device-not-booted",
          "private-api-unavailable",
          "unsupported-runtime",
          "no-carplay-screen",
          "power-on-failed",
          "usage",
        ]),
        message: z.string().min(1),
      })
      .strict(),
  })
  .strict();
export type CarPlayPowerState = z.infer<typeof stateSchema>;

/** Bounds a caller puts on one CarPlay helper run: the child is killed on abort or timeout. */
export interface CarPlayHelperCallOptions {
  signal?: AbortSignal;
  /** Caps the helper's own exec timeout; the smaller of the two applies. */
  timeoutMs?: number;
}

/** The smaller of the helper's default exec timeout and the caller's remaining budget. */
export function boundedHelperTimeoutMs(defaultMs: number, options?: CarPlayHelperCallOptions) {
  return options?.timeoutMs === undefined ? defaultMs : Math.min(defaultMs, options.timeoutMs);
}

const POWER_HELPER_TIMEOUT_MS = 135000;

export interface CarPlayScreenPowerer {
  status(udid: string): Promise<CarPlayPowerState>;
  /** Makes TVOut the CarPlay car display; repeat after every simulator boot. */
  powerOn(udid: string, options?: CarPlayHelperCallOptions): Promise<CarPlayPowerState>;
}

export function parseCarPlayPowerState(json: string): CarPlayPowerState {
  try {
    return stateSchema.parse(JSON.parse(json));
  } catch (error) {
    throw toActionableError(
      error,
      "Invalid carplay-power-helper state JSON; rebuild the helper from ios/carplay-power",
    );
  }
}

export class DefaultCarPlayScreenPowerer implements CarPlayScreenPowerer {
  constructor(
    private readonly exec: ExecFileAsync = execFileAsync,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  status(udid: string): Promise<CarPlayPowerState> {
    return this.run(udid, "status");
  }
  powerOn(udid: string, options?: CarPlayHelperCallOptions): Promise<CarPlayPowerState> {
    return this.run(udid, "power-on", options);
  }

  private async run(
    udid: string,
    action: string,
    options?: CarPlayHelperCallOptions,
  ): Promise<CarPlayPowerState> {
    const path = readEnvRaw(ENV.CARPLAY_POWER_HELPER_PATH, this.env);
    if (!path?.trim()) {
      throw new ActionableError(
        "Build ios/carplay-power and set AUTOMOBILE_CARPLAY_POWER_HELPER_PATH to its carplay-power-helper executable.",
      );
    }
    const args = [udid, action];
    try {
      const result = await runExecSeam(
        (options) => this.exec(path, args, options),
        {
          timeoutMs: boundedHelperTimeoutMs(POWER_HELPER_TIMEOUT_MS, options),
          maxBuffer: 1024 * 1024,
          signal: options?.signal,
        },
        { command: path, args },
        { preserveError: true },
      );
      return parseCarPlayPowerState(result.stdout);
    } catch (error) {
      if (typeof error === "object" && error !== null && "stderr" in error) {
        const stderr = Buffer.isBuffer(error.stderr) ? error.stderr.toString() : error.stderr;
        if (typeof stderr === "string" && stderr.trim()) {
          throw this.helperFailure(stderr);
        }
      }
      throw toActionableError(
        error,
        `Cannot run carplay-power-helper at ${path}; build ios/carplay-power and check AUTOMOBILE_CARPLAY_POWER_HELPER_PATH`,
      );
    }
  }

  private helperFailure(stderr: string): ActionableError {
    try {
      const { error } = failureSchema.parse(JSON.parse(stderr));
      return new ActionableError(`[${error.code}] ${error.message}`);
    } catch (error) {
      throw toActionableError(
        error,
        "Invalid carplay-power-helper error JSON; rebuild ios/carplay-power",
      );
    }
  }
}
