import { z } from "zod";
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
        powerState: z.number().int().nullable(),
        enabled: z.boolean().nullable(),
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
export interface CarPlayScreenPowerer {
  status(udid: string): Promise<CarPlayPowerState>;
  powerOn(udid: string, options: { enable: boolean }): Promise<CarPlayPowerState>;
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
    return this.run(udid, "status", false);
  }
  powerOn(udid: string, options: { enable: boolean }): Promise<CarPlayPowerState> {
    return this.run(udid, "power-on", options.enable);
  }

  private async run(udid: string, action: string, enable: boolean): Promise<CarPlayPowerState> {
    const path = this.env.AUTOMOBILE_CARPLAY_POWER_HELPER_PATH;
    if (!path?.trim()) {
      throw new ActionableError(
        "Build ios/carplay-power and set AUTOMOBILE_CARPLAY_POWER_HELPER_PATH to its carplay-power-helper executable.",
      );
    }
    const args = [udid, action, ...(enable ? ["--enable"] : [])];
    try {
      const result = await runExecSeam(
        (options) => this.exec(path, args, options),
        { timeoutMs: 135000, maxBuffer: 1024 * 1024 },
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
