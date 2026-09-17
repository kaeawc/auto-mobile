import { defaultTimer, type Timer } from "../../src/utils/SystemTimer";

const IOS_SIMULATOR_BOOT_DISCOVERY_TIMEOUT_MS = 10_000;
const IOS_SIMULATOR_BOOT_DISCOVERY_POLL_MS = 250;
const IOS_SIMULATOR_UDID_PATTERN =
  /^[A-Fa-f0-9]{8}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{12}$/;

export interface SimulatorAppearanceClient {
  getBootedSimulatorsChecked(timeoutMs?: number): Promise<Array<{ deviceId: string }>>;
  getDeviceInfo(deviceId: string): Promise<{ state: string } | null>;
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
