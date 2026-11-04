import { sessionOwnershipLostPayload } from "../../../src/daemon/deviceSessionResult";
import { TerminalSessionError } from "../../../src/daemon/sessionManager";
import { shapeToolCallError } from "../../../src/daemon/shapeToolCallError";
import type { DaemonResponse } from "../../../src/daemon/types";
import type { BootedDevice } from "../../../src/models";

/**
 * The desktop wire fixture format (#10669) and the pieces its recorder
 * (`desktopWireHarness.ts`) and its replay (`LivenessScenario.replayDesktopFixture`) share. Both
 * drive a real `Daemon` started through `startOn()`, so this module imports neither.
 */

export const DESKTOP_HEARTBEAT_MS = 2_000; // DesktopDaemonSessionComposition.kt HEARTBEAT_INTERVAL_MS
export const DESKTOP_CLIENT_NAME = "AutoMobile Desktop"; // DesktopDaemonSession.kt

export const PIXEL: BootedDevice = {
  deviceId: "emulator-5554",
  name: "Pixel",
  platform: "android",
};
export const PIXEL_FOLD: BootedDevice = {
  deviceId: "emulator-5556",
  name: "Pixel Fold",
  platform: "android",
};

export type WireActor = "desktop" | "agent" | "probe";

export interface WireExchange {
  /** Fake-clock time of the request, relative to the scenario start. */
  atMs: number;
  actor: WireActor;
  /** Step name a consumer looks responses up by. */
  label: string;
  /**
   * Present on the first frame after a daemon restart: the daemon process died after the previous
   * frame and a new one started over the same database this long later. The replay restarts its
   * daemon the same way before driving this frame.
   */
  daemonRestartDowntimeMs?: number;
  /** Present when one exchange stands for this many identical consecutive requests. */
  repeat?: number;
  everyMs?: number;
  request: { method: string; params: Record<string, unknown> };
  response: Omit<DaemonResponse, "id" | "type">;
}

export interface WireFixture {
  $comment: string;
  scenario: string;
  description: string;
  sessions: Record<string, string>;
  exchanges: WireExchange[];
}

/** The socket connection an actor's frames ride on, for both the recorder and the replay. */
export function wireConnection(actor: WireActor): string {
  return `scenario-${actor}`;
}

/** The connection the agent's unrecorded keep-alive heartbeats ride on. */
export const AGENT_KEEPER_CONNECTION = "scenario-agent-keeper";

/** Absolute fake-clock fields a daemon answer carries, including sessionInfo and activeSessions. */
const CLOCK_FIELDS = [
  "expiresAtMs",
  "createdAt",
  "lastUsedAt",
  "expiresAt",
  "lastToolActivityAt",
  "lastOwnerHeartbeatAt",
  "idleReleaseAt",
];

/**
 * A daemon answer as a fixture records it: a JSON copy with its absolute clock readings made
 * relative to `startedAt`, the scenario start. The fixture clock starts at zero; the daemon's may not.
 */
export function relativeEnvelope(
  envelope: Omit<DaemonResponse, "id" | "type">,
  startedAt: number,
): Omit<DaemonResponse, "id" | "type"> {
  const copy = JSON.parse(JSON.stringify(envelope)) as Omit<DaemonResponse, "id" | "type">;
  const result = copy.result as Record<string, unknown> | undefined;
  const rebase = (value: Record<string, unknown>) => {
    for (const key of CLOCK_FIELDS) {
      if (typeof value[key] === "number") {
        value[key] -= startedAt;
      }
    }
  };
  if (result && typeof result === "object") {
    rebase(result);
    if (Array.isArray(result.sessions)) {
      for (const session of result.sessions) {
        rebase(session);
      }
    }
  }
  return copy;
}

/** src/server/index.ts tool-call catch block, for the errors a device tool can raise. */
export function toolErrorResult(error: unknown, toolName = "setActiveDevice"): unknown {
  if (error instanceof TerminalSessionError) {
    const payload = sessionOwnershipLostPayload({
      message: error.message,
      sessionUuid: error.sessionUuid,
      reason: error.release.releaseReason,
      release: error.release,
    });
    return { content: [{ type: "text", text: JSON.stringify(payload) }], isError: true };
  }
  return shapeToolCallError(error, { toolName, source: "MCP" });
}
