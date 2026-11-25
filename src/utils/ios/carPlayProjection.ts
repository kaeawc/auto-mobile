import { z } from "zod/v3";
import { ENV, readEnvRaw } from "../../config/env";
import { ActionableError, toActionableError } from "../../models/ActionableError";
import { execFileAsync, type ExecFileAsync } from "../HostCommandExecutor";
import { runExecSeam } from "../ExecSeam";
import { type CarPlayRuntimeReader, requireCarPlayRuntime } from "./carPlayRuntime";
import { boundedHelperTimeoutMs, type CarPlayHelperCallOptions } from "./carPlayScreenPower";

export const carPlayProjectionStateSchema = z.discriminatedUnion("found", [
  z
    .object({
      found: z.literal(true),
      tag: z.number().int(),
      displayId: z.number().int(),
      displayType: z.number().int(),
      identity: z.string().min(1),
      name: z.string(),
      deviceName: z.string(),
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
      name: z.null(),
      deviceName: z.null(),
      isCarDisplay: z.literal(false),
      isCarInstrumentsDisplay: z.literal(false),
    })
    .strict(),
]);

export type CarPlayProjectionState = z.infer<typeof carPlayProjectionStateSchema>;
export type CarPlayProjectingState = Extract<CarPlayProjectionState, { found: true }> &
  ({ isCarDisplay: true } | { isCarInstrumentsDisplay: true });

export interface CarPlayProjectionProbe {
  probe(udid: string, options?: CarPlayHelperCallOptions): Promise<CarPlayProjectionState>;
}

const PROBE_TIMEOUT_MS = 15000;

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

  async probe(udid: string, options?: CarPlayHelperCallOptions): Promise<CarPlayProjectionState> {
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
        {
          timeoutMs: boundedHelperTimeoutMs(PROBE_TIMEOUT_MS, options),
          maxBuffer: 1024 * 1024,
          signal: options?.signal,
        },
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

/** What a refused action says it skipped: capture by default. */
const CAPTURE_SKIPPED = "Capture was skipped because the frame would be black.";

export function assertCarPlayProjecting(
  state: CarPlayProjectionState,
  skipped: string = CAPTURE_SKIPPED,
): asserts state is CarPlayProjectingState {
  if (state.found && (state.isCarDisplay || state.isCarInstrumentsDisplay)) {
    return;
  }
  const status = state.found
    ? `CarPlay screen ${state.name} is attached but not projecting (${state.identity}).`
    : "No CarPlay screen (TVOut or AirPlay display) was found; it is not projecting.";
  throw new ActionableError(
    `${status} ${skipped} Run carplay-power-helper power-on (ios/carplay-power) after every boot of an iOS 26.x simulator, then retry; the iOS 27 Simulator does not support CarPlay.`,
  );
}

/** The projection probe and the runtime check every CarPlay action runs first. */
export interface CarPlayProjectionCheck {
  probe: CarPlayProjectionProbe;
  runtime: CarPlayRuntimeReader;
}

/** Refuses an iOS 27+ simulator, then a CarPlay screen that is not projecting. */
export async function requireCarPlayProjection(
  udid: string,
  deps: CarPlayProjectionCheck,
  options?: { signal?: AbortSignal; skipped?: string },
): Promise<CarPlayProjectingState> {
  await requireCarPlayRuntime(udid, deps.runtime, options?.signal);
  const state = await deps.probe.probe(
    udid,
    options?.signal ? { signal: options.signal } : undefined,
  );
  assertCarPlayProjecting(state, options?.skipped);
  return state;
}
