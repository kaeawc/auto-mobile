import { describe, expect, test } from "bun:test";
import {
  handleDaemonRequest,
  type DaemonStateAccess,
} from "../../src/daemon/daemonRequestHandlers";
import { handleHttpHeartbeat, parseHttpHeartbeatBody } from "../../src/daemon/httpHeartbeat";
import { DAEMON_HEARTBEAT_METHOD } from "../../src/daemon/wire/constants";

/**
 * #11819: the socket heartbeat and `POST /heartbeat` share one rule for sessions the daemon no
 * longer holds and for tokenless heartbeats on token-owned sessions. One session-state matrix runs
 * through both surfaces and must produce the same outcome and the same manager effects.
 */

interface FakeSession {
  livenessOwnerToken?: string;
  livenessOwnershipClaims?: { size: number };
}

type State =
  | { kind: "live"; session: FakeSession }
  | { kind: "releasing"; session: FakeSession }
  | { kind: "unknown" };

class FakeManager {
  readonly effects: string[] = [];
  constructor(
    private readonly sessionId: string,
    private readonly state: State,
    private readonly releaseReason?: string,
  ) {}
  getSession(id: string) {
    return id === this.sessionId && this.state.kind === "live" ? this.state.session : null;
  }
  getReleasingSession(id: string) {
    return id === this.sessionId && this.state.kind === "releasing" ? this.state.session : null;
  }
  hasLivenessOwnership(_id: string, token: string) {
    return this.getSession(this.sessionId)?.livenessOwnerToken === token;
  }
  claimUnownedLivenessOwnership() {
    return false;
  }
  recordHeartbeat(id: string) {
    this.effects.push(`record:${id}`);
  }
  creditOwnerHeartbeatDuringRelease(id: string, token: string) {
    this.effects.push(`credit:${id}:${token}`);
  }
  async getReleasedSessionReason() {
    return this.releaseReason;
  }
  // Socket-only lookups the shared rule does not use for these states.
  heartbeatTimeoutMs = 10_000;
}

const SESSION = "session-1";

interface Case {
  label: string;
  state: State;
  observer: boolean;
  token?: string;
  releaseReason?: string;
  expected: string;
  effects: string[];
}

const CASES: Case[] = [
  {
    label: "live tokenless session, tokenless heartbeat",
    state: { kind: "live", session: {} },
    observer: false,
    expected: "ok",
    effects: [`record:${SESSION}`],
  },
  {
    label: "token-owned session, tokenless heartbeat is a no-op",
    state: { kind: "live", session: { livenessOwnerToken: "owner" } },
    observer: false,
    expected: "ok",
    effects: [],
  },
  {
    label: "claim-pending session, tokenless heartbeat is a no-op",
    state: { kind: "live", session: { livenessOwnershipClaims: { size: 1 } } },
    observer: false,
    expected: "ok",
    effects: [],
  },
  {
    label: "unknown session",
    state: { kind: "unknown" },
    observer: false,
    expected: "notFound:-",
    effects: [],
  },
  {
    label: "unknown session with an owner token is credited to nothing and not found",
    state: { kind: "unknown" },
    observer: false,
    token: "owner",
    expected: "notFound:-",
    effects: [`credit:${SESSION}:owner`],
  },
  {
    label: "released session names its release reason",
    state: { kind: "unknown" },
    observer: false,
    releaseReason: "idle-timeout",
    expected: "notFound:idle-timeout",
    effects: [],
  },
  {
    label: "releasing session is not found",
    state: { kind: "releasing", session: {} },
    observer: false,
    expected: "notFound:-",
    effects: [],
  },
  {
    label: "releasing session credits its owner's heartbeat",
    state: { kind: "releasing", session: { livenessOwnerToken: "owner" } },
    observer: false,
    token: "owner",
    expected: "notFound:-",
    effects: [`credit:${SESSION}:owner`],
  },
  {
    label: "a live observer session id is acknowledged",
    state: { kind: "unknown" },
    observer: true,
    expected: "ok",
    effects: [],
  },
];

async function viaSocket(testCase: Case, manager: FakeManager): Promise<string> {
  const state: Pick<
    DaemonStateAccess,
    "isInitialized" | "getSessionManager" | "getObserverSessionRegistry"
  > = {
    isInitialized: () => true,
    getSessionManager: () => manager as never,
    getObserverSessionRegistry: () => ({ heartbeat: () => testCase.observer }) as never,
  };
  const response = await handleDaemonRequest(
    {
      id: "1",
      type: "daemon_request",
      method: DAEMON_HEARTBEAT_METHOD,
      params: {
        sessionId: SESSION,
        ...(testCase.token ? { livenessOwnerToken: testCase.token } : {}),
      },
    },
    state as DaemonStateAccess,
  );
  return response.success ? "ok" : `notFound:${response.releaseReason ?? "-"}`;
}

async function viaHttp(testCase: Case, manager: FakeManager): Promise<string> {
  const response = await handleHttpHeartbeat(
    manager,
    { heartbeat: () => testCase.observer },
    SESSION,
    testCase.token,
  );
  if (response.status === 200) {
    return "ok";
  }
  expect(response.status).toBe(404);
  return `notFound:${(response.body.releaseReason as string | undefined) ?? "-"}`;
}

describe("socket and HTTP heartbeat parity", () => {
  test.each(CASES)("$label", async (testCase) => {
    const socketManager = new FakeManager(SESSION, testCase.state, testCase.releaseReason);
    const httpManager = new FakeManager(SESSION, testCase.state, testCase.releaseReason);
    expect(await viaSocket(testCase, socketManager)).toBe(testCase.expected);
    expect(await viaHttp(testCase, httpManager)).toBe(testCase.expected);
    expect(socketManager.effects).toEqual(testCase.effects);
    expect(httpManager.effects).toEqual(testCase.effects);
  });

  test("the HTTP body is validated, not trusted", () => {
    const bad = (raw: string) => {
      const parsed = parseHttpHeartbeatBody(raw);
      return parsed.ok ? undefined : [parsed.response.status, parsed.response.body];
    };
    expect(bad("{")).toEqual([400, { error: "Invalid JSON" }]);
    for (const raw of ["null", "[]", "5", "{}", '{"sessionId":""}', '{"sessionId":5}']) {
      expect(bad(raw)).toEqual([400, { error: "Missing sessionId" }]);
    }
    expect(parseHttpHeartbeatBody('{"sessionId":"s","livenessOwnerToken":"t"}')).toEqual({
      ok: true,
      sessionId: "s",
      livenessOwnerToken: "t",
    });
  });
});
