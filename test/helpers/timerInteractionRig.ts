import type { Daemon } from "../../src/daemon/daemon";
import type { BootedDevice } from "../../src/models";
import type { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { DaemonRequestFailed, LivenessScenario, ToolCallRefused } from "./livenessScenarioHarness";

// Shared rig for the lifecycle timer-interaction scenarios (heartbeat lease x idle window x disconnect
// monitor x in-flight veto). It adds only what LivenessScenario leaves out: the daemon's real
// device disconnect monitor (the harness's start host skips the maintenance monitors), driven
// over the scenario's fake discovery, and one reader for "what does every wire say about this
// session now".

export const DEVICE_A = "emulator-5554";
export const DEVICE_B = "emulator-5556";
export const DISCONNECT_POLL_MS = 5_000;

/** `adb devices` state of one serial; `absent` is not listed at all. */
export type AdbState = "device" | "offline" | "unauthorized" | "absent";

export interface DeviceListing {
  /** Set a serial's `adb devices` state from now on. */
  set(deviceId: string, state: AdbState): void;
  /** The monitor's transitional-episode bookkeeping, by device id. */
  episodes(): string[];
  /** Devices the monitor is counting absent misses for. */
  misses(): Map<string, number>;
}

interface DisconnectMonitorSurface {
  startDeviceDisconnectMonitor(
    manager: unknown,
    listRecordings: () => Promise<[]>,
    transportRestarts: { isRestarting(deviceId: string): boolean },
  ): void;
  offlineEpisodes: Map<string, unknown>;
  deviceDisconnectMisses: Map<string, number>;
}

/**
 * Start the daemon's real disconnect monitor (`Daemon.startDeviceDisconnectMonitor`, the 5 s
 * poll) on the scenario's daemon clock. Discovery is the scenario's own fake; a serial's
 * `adb devices` state is this rig's map: `device` rows are discovery's booted devices, `offline`
 * and `unauthorized` rows are the listed non-`device` states, `absent` rows are in neither.
 */
export function startDisconnectMonitor(scenario: LivenessScenario): DeviceListing {
  const discovery = Reflect.get(scenario, "discovery") as FakeDeviceUtils;
  const states = new Map<string, AdbState>(scenario.deviceIds.map((id) => [id, "device"]));
  const booted = (): BootedDevice[] =>
    scenario.deviceIds
      .filter((id) => states.get(id) === "device")
      .map((deviceId) => ({ deviceId, name: `Pixel_${deviceId}`, platform: "android" as const }));
  const listed = async (ids: Iterable<string>) =>
    new Map(
      [...ids].flatMap((id): Array<[string, string]> => {
        const state = states.get(id);
        return state === "offline" || state === "unauthorized" ? [[id, state]] : [];
      }),
    );
  // The pool's inventory reads the same device manager: give the fake the adb state probes it
  // lacks, so the monitor and the inventory surfaces see one listing.
  const manager = Object.assign(discovery, {
    getAndroidListedDeviceStates: listed,
    getAndroidOfflineDeviceIds: async (ids: Iterable<string>) =>
      new Set([...(await listed(ids))].flatMap(([id, state]) => (state === "offline" ? [id] : []))),
    recoverAndroidOfflineDevices: async () => {},
  });
  const daemon = scenario.daemon.daemon as unknown as Daemon & DisconnectMonitorSurface;
  daemon.startDeviceDisconnectMonitor(manager, async () => [], { isRestarting: () => false });
  return {
    set(deviceId, state) {
      states.set(deviceId, state);
      discovery.setBootedDevices("android", booted());
    },
    episodes: () => [...daemon.offlineEpisodes.keys()],
    misses: () => new Map(daemon.deviceDisconnectMisses),
  };
}

/** What one wire says about a session: the refusal code, its reason and the next action. */
export interface WireVerdict {
  code?: string;
  reason?: string;
  nextAction?: string;
  ok?: true;
}

function verdictFromResultText(text: string): WireVerdict {
  try {
    const body = JSON.parse(text) as {
      error?: { code?: string; reason?: string; nextAction?: string };
    };
    return {
      code: body.error?.code,
      reason: body.error?.reason,
      nextAction: body.error?.nextAction,
    };
  } catch {
    return { code: "unparsed", reason: text };
  }
}

/** A control call through the stdio proxy: what the agent's MCP client is answered with. */
export async function mcpVerdict(
  scenario: LivenessScenario,
  sessionId: string,
): Promise<WireVerdict> {
  try {
    await scenario.toolCall(sessionId);
    return { ok: true };
  } catch (error) {
    if (error instanceof ToolCallRefused) {
      return verdictFromResultText(error.message);
    }
    // The proxy throws its typed binding error; `proxyServer` shapes it as session_ownership_lost.
    const typed = error as { name?: string; reason?: string };
    return { code: typed.name, reason: typed.reason };
  }
}

/** A control call straight over the daemon socket (no proxy in front): the daemon's own answer. */
export async function socketVerdict(
  scenario: LivenessScenario,
  sessionId: string,
): Promise<WireVerdict> {
  try {
    await scenario.daemonToolCall(sessionId);
    return { ok: true };
  } catch (error) {
    if (error instanceof ToolCallRefused) {
      return verdictFromResultText(error.message);
    }
    if (error instanceof DaemonRequestFailed) {
      return { code: String(error.envelope.code ?? "failed"), reason: error.envelope.error };
    }
    throw error;
  }
}

/** `daemon/sessionInfo` for the session: the socket frame a status client reads. */
export async function sessionInfo(
  scenario: LivenessScenario,
  sessionId: string,
): Promise<Record<string, unknown>> {
  const envelope = await scenario.daemonMethod("daemon/sessionInfo", { sessionId });
  return envelope.success
    ? (envelope.result as Record<string, unknown>)
    : (envelope as unknown as Record<string, unknown>);
}

/** The persisted row's status and reason. */
export async function persistedRow(
  scenario: LivenessScenario,
  sessionId: string,
): Promise<{ status?: string; reason?: string | null; releasedAtMs?: number | null }> {
  const row = await scenario.repository.getSession(sessionId);
  return { status: row?.status, reason: row?.release_reason, releasedAtMs: row?.released_at_ms };
}

/** Every release notification the daemon emitted for the session. */
export function releasesOf(scenario: LivenessScenario, sessionId: string) {
  return scenario.releases.filter((release) => release.sessionId === sessionId);
}

/** The inventory row `daemon/availableDevices` serves, with the pool counters beside it. */
export async function inventory(scenario: LivenessScenario): Promise<{
  available: number;
  total: number;
  assigned: number;
  deviceIds: string[];
}> {
  const envelope = await scenario.daemonMethod("daemon/availableDevices", {});
  const result = envelope.result as {
    availableDevices: number;
    totalDevices: number;
    assignedDevices: number;
    devices: Array<{ deviceId: string }>;
  };
  return {
    available: result.availableDevices,
    total: result.totalDevices,
    assigned: result.assignedDevices,
    deviceIds: result.devices.map((device) => device.deviceId).sort(),
  };
}

/** Timers armed on the scenario clock: [timeouts, intervals]. */
export function armedTimers(scenario: LivenessScenario): [number, number] {
  return [scenario.timer.getPendingTimeoutCount(), scenario.timer.getPendingIntervalCount()];
}
