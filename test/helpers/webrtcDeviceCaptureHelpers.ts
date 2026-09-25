import { defaultTimer, type Timer } from "../../src/utils/SystemTimer";

const IOS_SIMULATOR_BOOT_DISCOVERY_TIMEOUT_MS = 10_000;
const IOS_SIMULATOR_BOOT_DISCOVERY_POLL_MS = 250;
const IOS_SIMULATOR_UDID_PATTERN =
  /^[A-Fa-f0-9]{8}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{12}$/;

export interface SimulatorAppearanceClient {
  getBootedSimulatorsChecked(timeoutMs?: number): Promise<Array<{ deviceId: string }>>;
  getDeviceInfo(deviceId: string): Promise<{ state: string } | null>;
}

export interface BoundedRetryOptions {
  attempts?: number;
}

/**
 * Retries `operation` up to `attempts` times (default 2), returning the
 * first success and re-throwing the last failure only once every attempt is
 * spent. Callers own their own per-attempt timeout (e.g. execFile's
 * `timeout` option) — this wrapper only bounds how many attempts run, not
 * how long each one takes (#7605: a wedged `simctl ui appearance` call on the
 * macOS 26 runner needs a short per-call timeout plus a small retry, not one
 * long attempt).
 */
export async function runWithBoundedRetry<T>(
  operation: (attempt: number) => Promise<T>,
  { attempts = 2 }: BoundedRetryOptions = {},
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

export function shouldRetryWebRtcDaemonStart({
  startError,
  readyError,
}: {
  startError: Error | null;
  readyError: Error | null;
}): boolean {
  return startError !== null || readyError !== null;
}

/**
 * True when `error` is the catalogued keyframe-recovery timeout thrown by
 * `waitFor` (test/helpers/abortableWaitFor.ts) for `recoveryMessage` —
 * either the bare deadline-exhausted message, or the per-iteration
 * "did not complete within...ms total" wrap of it. False for any other
 * error (e.g. a thrown fixture/CDP failure from the polled predicate),
 * which must be treated as a distinct regression, not the catalogued flake.
 */
export function isKeyframeRecoveryTimeout(error: unknown, recoveryMessage: string): boolean {
  return (
    error instanceof Error &&
    (error.message === recoveryMessage ||
      error.message.startsWith(`${recoveryMessage} did not complete within`))
  );
}

export function configuredIosSimulatorUdid(
  environment: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const value = environment.AUTOMOBILE_IOS_SIMULATOR_UDID?.trim();
  if (!value) {
    return undefined;
  }
  if (!IOS_SIMULATOR_UDID_PATTERN.test(value)) {
    throw new Error("AUTOMOBILE_IOS_SIMULATOR_UDID must be a simulator UDID");
  }
  return value;
}

function isBootedSimulatorState(device: { state: string } | null): boolean {
  return device?.state === "Booted";
}

export async function waitForBootedSimulatorUdid(
  simctl: SimulatorAppearanceClient,
  {
    timeoutMs = IOS_SIMULATOR_BOOT_DISCOVERY_TIMEOUT_MS,
    pollIntervalMs = IOS_SIMULATOR_BOOT_DISCOVERY_POLL_MS,
    timer = defaultTimer,
  }: {
    timeoutMs?: number;
    pollIntervalMs?: number;
    timer?: Timer;
  } = {},
): Promise<string | undefined> {
  const deadline = timer.now() + timeoutMs;
  while (true) {
    const remainingMs = deadline - timer.now();
    const simulator = (await simctl.getBootedSimulatorsChecked(Math.max(1, remainingMs)))[0];
    if (simulator) {
      const device = await simctl.getDeviceInfo(simulator.deviceId);
      if (isBootedSimulatorState(device)) {
        return simulator.deviceId;
      }
    }

    if (timer.now() >= deadline) {
      return undefined;
    }
    await timer.sleep(Math.min(pollIntervalMs, deadline - timer.now()));
  }
}
