import { expect, spyOn, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  livenessHandoverNotificationPayloads,
  managedEndedPayload,
  managedSlotsResourceView,
  noActiveDeviceSessionResult,
} from "../../src/server/proxyServer";
import {
  sessionOwnershipLostPayload,
  sessionReleasedDuringCallPayload,
} from "../../src/server/deviceSessionResult";
import { DaemonConnectionSessionReleasedError } from "../../src/daemon/daemonMcpProxy";
import { DaemonState } from "../../src/daemon/daemonState";
import { TerminalSessionError, type SessionReleaseSnapshot } from "../../src/daemon/sessionManager";
import { SessionReleasedDuringCallError } from "../../src/daemon/sessionReleasedDuringCall";
import { isIdleReleaseReason, type SessionReleaseReason } from "../../src/daemon/releaseReasons";
import {
  BOUND_SESSION_LOSS_CODE,
  releasedSessionNotFoundFields,
  sanitizeBoundSessionLoss,
  type DaemonNotification,
} from "../../src/daemon/types";
import { UnixSocketServer, mcpRequestFailureDetails } from "../../src/daemon/socketServer";
import { planBaseEndFields } from "../../src/server/planExecutionOrchestrator";
import {
  readyManagedSlotsResult,
  REFUSAL_FIXTURES_DIR,
  REFUSAL_SURFACES_DIR,
} from "../helpers/refusalWireFixtures";

const SESSION = "11111111-2222-4333-8444-555555555555";
const slots = readyManagedSlotsResult(SESSION);
type Holder = { reason?: unknown; releaseReason?: unknown; idle?: unknown };
const snapshot = (reason: string): SessionReleaseSnapshot => ({
  sessionId: SESSION,
  deviceId: "emulator-5554",
  releaseReason: reason,
  terminal: true,
  releasedAtMs: 1,
  heartbeat: { lastHeartbeatMs: 0, hasReceivedHeartbeat: true, timeoutMs: 1, ageMs: 1 },
});

interface ReleaseSocketHarness {
  admitReleasedBoundSession(sessionUuid: string): Promise<void>;
  broadcastSessionReleased(sessionUuid: string, reason: string): void;
}

// Drive the real private payload methods on a narrow fake receiver: the full socket harness
// also owns transport lifecycle, which these serialization checks do not need.
function socketHarness(reason: string, capture?: (frame: DaemonNotification) => void) {
  return Object.assign(Object.create(UnixSocketServer.prototype), {
    daemonState: {
      getSessionManager: () => ({ getTerminalReleaseSnapshot: () => snapshot(reason) }),
    },
    notificationSubscribers: new Set(["subscriber"]),
    clientSockets: new Map([["subscriber", {}]]),
    pendingSessionReleaseWrites: new Set<Promise<void>>(),
    writeFrame: (
      _socket: unknown,
      _session: string,
      frame: DaemonNotification,
      flushed: () => void,
    ) => {
      capture?.(JSON.parse(JSON.stringify(frame)));
      flushed();
    },
  }) as ReleaseSocketHarness;
}

async function boundLoss(reason: string): Promise<Holder> {
  try {
    await socketHarness(reason).admitReleasedBoundSession(SESSION);
  } catch (error) {
    if (error instanceof Error && "failure" in error) {
      return error.failure as Holder;
    }
    throw error;
  }
  throw new Error("Expected released bound-session refusal");
}

interface Surface {
  name: string;
  reasonKey: "reason" | "releaseReason";
  holder(reason: string): Holder | Promise<Holder>;
}
const surfaces: Surface[] = [
  {
    name: "default proxy tool result",
    reasonKey: "reason",
    holder: (reason) => {
      const content = noActiveDeviceSessionResult(new DaemonConnectionSessionReleasedError(reason))
        .content[0];
      if (content.type !== "text") {
        throw new Error("Expected refusal text");
      }
      return JSON.parse(content.text).error;
    },
  },
  {
    name: "managed tool result",
    reasonKey: "reason",
    holder: (reason) => managedEndedPayload(slots, SESSION, reason)!.error,
  },
  {
    name: "managed liveness logging notification",
    reasonKey: "reason",
    holder: (reason) =>
      livenessHandoverNotificationPayloads(
        {
          code: "proxy_stalled",
          sessions: [
            { sessionUuid: SESSION, deviceId: "emulator-5554", lastAcknowledgedHeartbeatAt: 0 },
          ],
          attempts: 1,
          lastAcknowledgedHeartbeatAt: 0,
          action: "reacquire_lost_sessions",
          releaseReasons: { [SESSION]: reason },
        },
        slots,
      )[0].error as Holder,
  },
  {
    name: "managed slots resource",
    reasonKey: "reason",
    holder: (reason) =>
      managedSlotsResourceView(slots, { sessionUuid: SESSION, reason }).slots[0].executionEnded!,
  },
  {
    name: "ownership lost",
    reasonKey: "reason",
    holder: (reason) =>
      sessionOwnershipLostPayload({ message: "Released", sessionUuid: SESSION, reason }).error,
  },
  {
    name: "released during call MCP",
    reasonKey: "reason",
    holder: (reason) =>
      sessionReleasedDuringCallPayload(
        new SessionReleasedDuringCallError(SESSION, reason as SessionReleaseReason),
      )!.error,
  },
  {
    name: "released during call socket details",
    reasonKey: "reason",
    holder: (reason) =>
      new SessionReleasedDuringCallError(SESSION, reason as SessionReleaseReason).details,
  },
  // Registration and heartbeat/sessionInfo not-found handlers share this exported builder.
  {
    name: "session not found fields",
    reasonKey: "releaseReason",
    holder: releasedSessionNotFoundFields,
  },
  { name: "bound session loss construction", reasonKey: "reason", holder: boundLoss },
  {
    name: "bound session loss sanitizer round trip",
    reasonKey: "reason",
    holder: async (reason) =>
      sanitizeBoundSessionLoss(
        JSON.parse(
          JSON.stringify({
            code: BOUND_SESSION_LOSS_CODE,
            sessionUuid: SESSION,
            ...(await boundLoss(reason)),
            idle: !isIdleReleaseReason(reason),
          }),
        ),
      )!,
  },
  {
    name: "session released push",
    reasonKey: "reason",
    holder: (reason) => {
      let frame: DaemonNotification | undefined;
      socketHarness(reason, (notification) => {
        frame = notification;
      }).broadcastSessionReleased(SESSION, reason);
      if (!frame) {
        throw new Error("Missing session release push");
      }
      return frame;
    },
  },
  {
    name: "typed socket admission refusal",
    reasonKey: "reason",
    holder: (reason) =>
      mcpRequestFailureDetails(new TerminalSessionError(SESSION, snapshot(reason)), undefined)
        .details as Holder,
  },
  {
    name: "plan base end fields",
    reasonKey: "reason",
    holder: (reason) => {
      const ended = new TerminalSessionError(SESSION, snapshot(reason));
      const state = spyOn(DaemonState, "getInstance").mockReturnValue({
        isInitialized: () => true,
        getSessionManager: () => ({ peekTerminalAnswerForEndedSession: () => ended }),
      } as unknown as DaemonState);
      try {
        return planBaseEndFields(SESSION, false, {
          error: String(ended),
          stepIndex: 0,
          tool: "homeScreen",
        }).details as Holder;
      } finally {
        state.mockRestore();
      }
    },
  },
];
const ends: string[] = [
  "cleanup-expired",
  "cli-idle-timeout",
  "lazy-expiry",
  "expired",
  "heartbeat-timeout",
  "restart-recovery-timeout",
  "explicit-release",
  "daemon-shutdown",
  "owner-disconnected",
  "session-not-found",
  "unknown",
];
const rows = surfaces
  .flatMap((surface) => ends.map((reason) => ({ ...surface, reason })))
  .concat([{ ...surfaces[0], reason: "device_not_held" }]);

test.each(rows)("$name / $reason", async ({ holder, reasonKey, reason }) => {
  const fields = await holder(reason);
  expect(fields[reasonKey]).toBe(reason);
  if (isIdleReleaseReason(reason)) {
    expect(fields.idle).toBe(true);
    const keys = Object.keys(fields);
    expect(keys[keys.indexOf(reasonKey) + 1]).toBe("idle");
  } else {
    expect("idle" in fields).toBe(false);
  }
});

// Shared immutable corpus: read once, including JSON embedded in MCP content[].text below.
const corpus: unknown[] = [REFUSAL_FIXTURES_DIR, REFUSAL_SURFACES_DIR].flatMap((directory) =>
  readdirSync(directory)
    .filter((name) => name.endsWith(".json") && name !== "expectations.json")
    .map((name) => JSON.parse(readFileSync(join(directory, name), "utf8"))),
);

test("every refusal fixture qualifies each idle reason beside that reason", () => {
  let idleObjects = 0;
  function visit(value: unknown, key?: string): void {
    if (key === "text" && typeof value === "string" && value.trimStart().startsWith("{")) {
      visit(JSON.parse(value));
      return;
    }
    if (value === null || typeof value !== "object") {
      return;
    }
    const fields = Object.fromEntries(Object.entries(value));
    // Exactly the nested `release` snapshot is exempt; its flag sits one level up.
    if (key !== "release") {
      const idleReason = [fields.reason, fields.releaseReason].some(
        (reason) => typeof reason === "string" && isIdleReleaseReason(reason),
      );
      if (idleReason) {
        idleObjects++;
        expect(fields.idle).toBe(true);
      }
      if ("idle" in fields) {
        expect(fields.idle).toBe(true);
        expect(idleReason).toBe(true);
      }
    }
    for (const [childKey, child] of Object.entries(value)) {
      visit(child, childKey);
    }
  }
  for (const fixture of corpus) {
    visit(fixture);
  }
  expect(idleObjects).toBeGreaterThan(0);
});
