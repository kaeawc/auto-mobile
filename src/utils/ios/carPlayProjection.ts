import { z } from "zod/v3";
import { ENV, readEnvRaw } from "../../config/env";
import { ActionableError, toActionableError } from "../../models/ActionableError";
import { execFileAsync, type ExecFileAsync } from "../HostCommandExecutor";
import { runExecSeam } from "../ExecSeam";

export const carPlayProjectionStateSchema = z.discriminatedUnion("found", [
  z
    .object({
      found: z.literal(true),
      tag: z.number().int(),
      displayId: z.number().int(),
      displayType: z.number().int(),
      identity: z.string().min(1),
      isCarDisplay: z.boolean(),
      isCarInstrumentsDisplay: z.boolean(),
    })
    .strict(),
  z
    .object({
      found: z.literal(false),
      tag: z.null(),
      displayId: z.null(),
      displayType: z.null(),
      identity: z.null(),
      isCarDisplay: z.literal(false),
      isCarInstrumentsDisplay: z.literal(false),
    })
    .strict(),
]);

export type CarPlayProjectionState = z.infer<typeof carPlayProjectionStateSchema>;

export interface CarPlayProjectionProbe {
  probe(udid: string): Promise<CarPlayProjectionState>;
}

export function parseCarPlayProjectionState(json: string): CarPlayProjectionState {
  try {
    return carPlayProjectionStateSchema.parse(JSON.parse(json));
  } catch (error) {
    throw toActionableError(
      error,
      "Invalid CarPlay projection probe JSON; rebuild ios/carplay-projection-probe",
    );
  }
}

export class DefaultCarPlayProjectionProbe implements CarPlayProjectionProbe {
  constructor(
    private readonly exec: ExecFileAsync = execFileAsync,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  async probe(udid: string): Promise<CarPlayProjectionState> {
    const path = readEnvRaw(ENV.CARPLAY_PROJECTION_PROBE_PATH, this.env);
    if (!path?.trim()) {
      throw new ActionableError(
        "Build ios/carplay-projection-probe and set AUTOMOBILE_CARPLAY_PROJECTION_PROBE_PATH to its executable's absolute path.",
      );
    }
    const args = ["simctl", "spawn", udid, path];
    try {
      const result = await runExecSeam(
        (options) => this.exec("xcrun", args, options),
        { timeoutMs: 15000, maxBuffer: 1024 * 1024 },
        { command: "xcrun", args },
      );
      return parseCarPlayProjectionState(result.stdout);
    } catch (error) {
      throw toActionableError(
        error,
        `Cannot run CarPlay projection probe at ${path}; rebuild ios/carplay-projection-probe, check AUTOMOBILE_CARPLAY_PROJECTION_PROBE_PATH and ensure the simulator is booted`,
      );
    }
  }
}

export function assertCarPlayProjecting(state: CarPlayProjectionState): void {
  if (state.isCarDisplay || state.isCarInstrumentsDisplay) {
    return;
  }
  const status = state.found
    ? `CarPlay screen is attached but not projecting (${state.identity}).`
    : "CarPlay screen was not found (wireless0); it is not projecting.";
  const power =
    !state.found || state.tag === 0
      ? "Enable CarPlay and power the screen on first via ios/carplay-power. "
      : "";
  throw new ActionableError(
    `${status} Capture was skipped because the frame would be black. ${power}Open the Simulator.app CarPlay window or wait for [#17561](https://github.com/kaeawc/auto-mobile/issues/17561).`,
  );
}

export async function requireCarPlayProjection(
  udid: string,
  probe: CarPlayProjectionProbe,
): Promise<void> {
  assertCarPlayProjecting(await probe.probe(udid));
}
