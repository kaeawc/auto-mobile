import { describe, expect, test } from "bun:test";
import type {
  Session,
  SessionReleaseOperation,
  SessionReleaseSnapshot,
} from "../../src/daemon/sessionManager";
import type {
  PendingSessionCreation,
  ReleaseReasonState,
} from "../../src/daemon/sessionManager/internalContracts";
import {
  classifyOwnedRelease,
  classifyUnpublishedRelease,
  type OwnedReleaseReader,
  type OwnedReleaseVerdict,
  type ReleaseTarget,
  type UnpublishedReleaseReader,
} from "../../src/daemon/sessionManager/releaseTarget";

const ID = "release-target";
const DEVICE = "emulator-5554";
const session: Session = {
  sessionId: ID,
  assignedDevice: DEVICE,
  platform: "android",
  createdAt: 0,
  lastUsedAt: 0,
  activityGeneration: 0,
  expiresAt: 1000,
  cacheData: {},
  lastHeartbeat: 0,
  sessionTimeoutMs: 1000,
  heartbeatTimeoutMs: 1000,
  heartbeatTimeoutSource: "default",
  hasReceivedHeartbeat: false,
  ownership: "owned",
  livenessPolicy: "heartbeat",
};
const snapshot: SessionReleaseSnapshot = {
  sessionId: ID,
  deviceId: DEVICE,
  releaseReason: "device-killed",
  releasedAtMs: 0,
  terminal: true,
  heartbeat: { lastHeartbeatMs: 0, hasReceivedHeartbeat: false, timeoutMs: 1000, ageMs: 0 },
};
const rowSnapshot: SessionReleaseSnapshot = {
  ...snapshot,
  terminal: false,
  releaseReason: "device-restart",
};
const reasonState: ReleaseReasonState = { value: "device-killed", finalizedSnapshot: snapshot };
const release: SessionReleaseOperation = {
  session,
  reason: { value: "device-restart" },
  options: {},
  promise: Promise.resolve(DEVICE),
  stuckDeadlineMs: 1000,
};
const assignment = Promise.resolve(session);
const creation: PendingSessionCreation = { promise: Promise.resolve({ ...session }) };

interface UnpublishedState {
  inFlight?: SessionReleaseOperation;
  terminal?: SessionReleaseSnapshot;
  reason?: ReleaseReasonState;
  row?: SessionReleaseSnapshot;
  assignment?: Promise<Session>;
  creation?: PendingSessionCreation;
}

function unpublishedReader(state: UnpublishedState, reads: string[]): UnpublishedReleaseReader {
  const read = <T>(name: string, id: string, value: T): T => {
    expect(id).toBe(ID);
    reads.push(name);
    return value;
  };
  return {
    forcedStuckRelease: {
      inFlightReleaseStillOwning: (id) => read("in-flight", id, state.inFlight),
    },
    sessionSlots: {
      getTerminalSnapshot: (id) => read("terminal", id, state.terminal),
      getTerminalReasonState: (id) => read("reason", id, state.reason),
      getAssignment: (id) => read("assignment", id, state.assignment),
      getCreation: (id) => read("creation", id, state.creation),
    },
    rowWriter: {
      pendingNonTerminalReleases: () => {
        reads.push("pending-rows");
        return { get: (id) => read("row", id, state.row) };
      },
    },
  };
}

interface UnpublishedCase {
  name: string;
  state: UnpublishedState;
  reason?: string;
  target: ReleaseTarget;
  reads: string[];
}

const throughRow = ["in-flight", "terminal", "pending-rows", "row"];
const throughWork = [...throughRow, "assignment", "creation"];
const allUnpublished: UnpublishedState = {
  inFlight: release,
  terminal: snapshot,
  reason: reasonState,
  row: rowSnapshot,
  assignment,
  creation,
};
const unpublishedCases: UnpublishedCase[] = [
  {
    name: "in-flight wins over every later branch",
    state: allUnpublished,
    target: { kind: "forced-in-flight", release },
    reads: ["in-flight"],
  },
  {
    name: "finalized in-flight stays in the executor",
    state: { ...allUnpublished, inFlight: { ...release, reason: reasonState } },
    target: { kind: "forced-in-flight", release: { ...release, reason: reasonState } },
    reads: ["in-flight"],
  },
  {
    name: "in-flight also wins for a non-terminal reason",
    state: allUnpublished,
    reason: "device-restart",
    target: { kind: "forced-in-flight", release },
    reads: ["in-flight"],
  },
  {
    name: "terminal fence wins over row and work",
    state: { ...allUnpublished, inFlight: undefined },
    target: { kind: "terminal-fenced", snapshot, reasonState },
    reads: ["in-flight", "terminal", "reason"],
  },
  {
    name: "terminal fence without a reason state",
    state: { terminal: snapshot },
    target: { kind: "terminal-fenced", snapshot, reasonState: undefined },
    reads: ["in-flight", "terminal", "reason"],
  },
  {
    name: "row wins over assignment and creation",
    state: { row: rowSnapshot, assignment, creation },
    target: { kind: "row-pending", snapshot: rowSnapshot },
    reads: throughRow,
  },
  {
    name: "non-terminal request bypasses terminal fence for row",
    state: { terminal: snapshot, reason: reasonState, row: rowSnapshot, assignment, creation },
    reason: "device-restart",
    target: { kind: "row-pending", snapshot: rowSnapshot },
    reads: throughRow,
  },
  {
    name: "assignment wins over creation and still reads both",
    state: { assignment, creation },
    target: { kind: "pending-work", pendingSession: assignment },
    reads: throughWork,
  },
  {
    name: "creation supplies pending work",
    state: { creation },
    target: { kind: "pending-work", pendingSession: creation.promise },
    reads: throughWork,
  },
  {
    name: "non-terminal request bypasses terminal fence for work",
    state: { terminal: snapshot, reason: reasonState, assignment, creation },
    reason: "device-restart",
    target: { kind: "pending-work", pendingSession: assignment },
    reads: throughWork,
  },
  {
    name: "non-terminal request bypasses terminal fence for persisted row",
    state: { terminal: snapshot, reason: reasonState },
    reason: "device-restart",
    target: { kind: "persisted-only" },
    reads: throughWork,
  },
  {
    name: "missing session falls through to persisted row",
    state: {},
    target: { kind: "persisted-only" },
    reads: throughWork,
  },
];

describe("classifyUnpublishedRelease", () => {
  test.each(unpublishedCases)("$name", ({ state, reason, target, reads: expectedReads }) => {
    const reads: string[] = [];
    const actual = classifyUnpublishedRelease(
      unpublishedReader(state, reads),
      ID,
      reason ?? "device-killed",
    );
    expect(actual).toEqual(target);
    // These are borrowed objects: classification must not copy a promise, snapshot or reason.
    switch (actual.kind) {
      case "forced-in-flight":
        expect(state.inFlight).toBe(actual.release);
        break;
      case "terminal-fenced":
        expect(state.terminal).toBe(actual.snapshot);
        expect(actual.reasonState).toBe(state.reason);
        break;
      case "row-pending":
        expect(state.row).toBe(actual.snapshot);
        break;
      case "pending-work":
        expect(state.assignment ?? state.creation?.promise).toBe(actual.pendingSession);
        break;
      case "persisted-only":
        break;
    }
    expect(reads).toEqual(expectedReads);
  });
});

interface OwnedCase {
  name: string;
  published?: Session;
  assignment?: boolean;
  creation?: boolean;
  inFlight?: SessionReleaseOperation;
  expectedDeviceId?: string;
  verdict: OwnedReleaseVerdict;
  reads: string[];
}

const throughOwnedWork = ["published", "assignment", "creation"];
const throughOwnedRelease = [...throughOwnedWork, "release-op"];
const ownedCases: OwnedCase[] = [
  {
    name: "published match wins over pending work and other release",
    published: session,
    assignment: true,
    creation: true,
    inFlight: { ...release, session: { ...session } },
    verdict: "release",
    reads: ["published"],
  },
  {
    name: "published other incarnation declines before work",
    published: { ...session },
    inFlight: release,
    verdict: "decline",
    reads: ["published"],
  },
  {
    name: "published other device declines",
    published: session,
    expectedDeviceId: "other",
    verdict: "decline",
    reads: ["published"],
  },
  {
    name: "assignment wins over matching in-flight and short-circuits creation",
    assignment: true,
    creation: true,
    inFlight: release,
    verdict: "decline",
    reads: ["published", "assignment"],
  },
  {
    name: "creation wins over matching in-flight",
    creation: true,
    inFlight: release,
    verdict: "decline",
    reads: throughOwnedWork,
  },
  {
    name: "matching in-flight releases",
    inFlight: release,
    verdict: "release",
    reads: throughOwnedRelease,
  },
  {
    name: "in-flight other incarnation declines",
    inFlight: { ...release, session: { ...session } },
    verdict: "decline",
    reads: throughOwnedRelease,
  },
  {
    name: "in-flight other device declines",
    inFlight: release,
    expectedDeviceId: "other",
    verdict: "decline",
    reads: throughOwnedRelease,
  },
  {
    name: "no current work delegates finalized ownership check",
    verdict: "finalized",
    reads: throughOwnedRelease,
  },
  {
    name: "finalized device check stays in executor",
    expectedDeviceId: "other",
    verdict: "finalized",
    reads: throughOwnedRelease,
  },
];

describe("classifyOwnedRelease", () => {
  test.each(ownedCases)("$name", (entry) => {
    const reads: string[] = [];
    const read = <T>(name: string, id: string, value: T): T => {
      expect(id).toBe(ID);
      reads.push(name);
      return value;
    };
    const reader: OwnedReleaseReader = {
      sessions: { get: (id) => read("published", id, entry.published) },
      sessionSlots: {
        hasAssignment: (id) => read("assignment", id, entry.assignment ?? false),
        hasCreation: (id) => read("creation", id, entry.creation ?? false),
        getReleaseOp: (id) => read("release-op", id, entry.inFlight),
      },
    };
    expect(classifyOwnedRelease(reader, ID, session, entry.expectedDeviceId ?? DEVICE)).toBe(
      entry.verdict,
    );
    expect(reads).toEqual(entry.reads);
  });
});
