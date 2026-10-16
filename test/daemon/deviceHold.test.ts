import { statusOf, type BindingFields } from "../../src/daemon/deviceBinding";
import { describe, expect, test } from "bun:test";
import {
  deviceHold,
  classifyPoolStatus,
  genericAvailabilityOf,
  holdAllowsHealthRecovery,
  holdAllowsObservationServiceStart,
  holdBlocksAssignment,
  poolBucketOf,
  type DeviceHold,
  type DeviceHoldFacts,
  type GenericAvailability,
  type PoolStatusBucket,
} from "../../src/daemon/deviceHold";

type Answers = readonly [boolean, GenericAvailability, PoolStatusBucket, boolean, boolean];
interface Row {
  facts: Partial<DeviceHoldFacts>;
  answers: Answers;
}

// Observation, generic availability, bucket, health recovery, assignment reservation.
// Record makes adding a kind require a new literal policy row here as well as in every switch.
const kinds = {
  free: { facts: {}, answers: [true, "free", "idle", true, false] },
  bound: { facts: { sessionId: "owner" }, answers: [false, "free", "idle", false, false] },
  readiness: {
    facts: { readinessById: true },
    answers: [false, "reserved", "assigned", true, true],
  },
  shutdown: { facts: { shutdown: true }, answers: [false, "reserved", "assigned", true, true] },
  rehydration: {
    facts: { rehydrationHolder: "restart-owner" },
    answers: [false, "reserved", "assigned", true, true],
  },
  recovery: {
    facts: { recoveryHandoff: true },
    answers: [false, "reserved", "assigned", true, true],
  },
  "adb-reset": {
    facts: { adbServerResetSessionId: "reset-owner" },
    answers: [false, "free", "idle", true, false],
  },
  identity: { facts: { identityUnresolved: true }, answers: [false, "free", "idle", true, false] },
  cleanup: { facts: { cleanupInProgress: true }, answers: [false, "free", "idle", false, false] },
  health: { facts: { healthMarker: true }, answers: [false, "free", "assigned", true, false] },
  "managed-slot": {
    facts: { managedSlot: true },
    answers: [true, "managed_slot", "assigned", true, false],
  },
  "foreign-daemon": {
    facts: { foreignDaemon: true },
    answers: [true, "foreign_daemon", "assigned", true, false],
  },
  error: { facts: { status: "error" }, answers: [false, "free", "error", false, false] },
  busy: { facts: { status: "busy" }, answers: [false, "free", "assigned", false, false] },
  "transport-alias": {
    facts: { transportAliasUnassignable: true },
    answers: [true, "free", "assigned", true, false],
  },
  assignment: {
    facts: { assignmentMutexLocked: true },
    answers: [false, "free", "idle", true, false],
  },
} satisfies Record<DeviceHold["kind"], Row>;

const variants: Array<Row & { name: string; kind: DeviceHold["kind"] }> = [
  {
    name: "readiness by stable name",
    kind: "readiness",
    facts: { readinessByName: true },
    answers: [false, "reserved", "assigned", true, true],
  },
  {
    name: "own restart/readiness reservations were exempted in the snapshot",
    kind: "free",
    facts: { readinessById: false, readinessByName: false, rehydrationHolder: undefined },
    answers: [true, "free", "idle", true, false],
  },
  {
    name: "missing stable identity",
    kind: "identity",
    facts: { stableIdentityMissing: true },
    answers: [false, "free", "idle", true, false],
  },
  {
    name: "identity reconciliation owner",
    kind: "identity",
    facts: { identityReconcileOwner: Symbol("reconcile") },
    answers: [false, "free", "idle", true, false],
  },
  {
    name: "ADB startup lease",
    kind: "adb-reset",
    facts: { adbStartupLease: true },
    answers: [false, "free", "idle", true, false],
  },
  {
    name: "deferred release without pending cleanup",
    kind: "cleanup",
    facts: { deferredRelease: true },
    answers: [false, "free", "idle", true, false],
  },
  {
    name: "reverse session binding",
    kind: "bound",
    facts: { sessionForDevice: "reverse-owner" },
    answers: [false, "free", "idle", true, false],
  },
  {
    name: "non-null reverse binding, even an empty id",
    kind: "bound",
    facts: { sessionForDevice: "" },
    answers: [false, "free", "idle", true, false],
  },
  {
    name: "empty pooled session id remains unbound",
    kind: "free",
    facts: { sessionId: "" },
    answers: [true, "free", "idle", true, false],
  },
  ...(
    [
      "recoveringSerial",
      "recoveringName",
      "recoveringStableId",
      "recoveringSessionLoss",
      "mcpSessionRecoveryLease",
      "lifecycleStableReservation",
      "lifecycleSelectorReservation",
    ] as const
  ).map((fact): Row & { name: string; kind: DeviceHold["kind"] } => ({
    name: fact,
    kind: "recovery",
    facts: { [fact]: true },
    answers: [false, "free", "idle", true, false],
  })),
];

const precedence: Array<Row & { name: string; kind: DeviceHold["kind"] }> = [
  {
    name: "managed slot precedes foreign claim and reservation; error still wins the bucket",
    kind: "managed-slot",
    facts: { managedSlot: true, foreignDaemon: true, readinessById: true, status: "error" },
    answers: [false, "managed_slot", "error", false, true],
  },
  {
    name: "foreign claim precedes readiness",
    kind: "foreign-daemon",
    facts: { foreignDaemon: true, readinessById: true },
    answers: [false, "foreign_daemon", "assigned", true, true],
  },
  {
    name: "readiness precedes handoff, shutdown and rehydration",
    kind: "readiness",
    facts: {
      readinessByName: true,
      recoveryHandoff: true,
      shutdown: true,
      rehydrationHolder: "restart-owner",
    },
    answers: [false, "reserved", "assigned", true, true],
  },
  {
    name: "handoff precedes shutdown",
    kind: "recovery",
    facts: { recoveryHandoff: true, shutdown: true },
    answers: [false, "reserved", "assigned", true, true],
  },
  {
    name: "shutdown precedes rehydration",
    kind: "shutdown",
    facts: { shutdown: true, rehydrationHolder: "restart-owner" },
    answers: [false, "reserved", "assigned", true, true],
  },
  {
    name: "managed slot retains independent pending cleanup",
    kind: "managed-slot",
    facts: { managedSlot: true, cleanupInProgress: true },
    answers: [false, "managed_slot", "assigned", false, false],
  },
  {
    name: "foreign claim retains independent identity fence",
    kind: "foreign-daemon",
    facts: { foreignDaemon: true, identityUnresolved: true },
    answers: [false, "foreign_daemon", "assigned", true, false],
  },
  {
    name: "observation-only recovery does not mask a generic reservation",
    kind: "recovery",
    facts: { recoveringSerial: true, recoveryHandoff: true },
    answers: [false, "reserved", "assigned", true, true],
  },
  {
    name: "a pooled session masks neither an error bucket nor a reservation",
    kind: "readiness",
    facts: { status: "error", sessionId: "owner", readinessById: true },
    answers: [false, "reserved", "error", false, true],
  },
];

describe("pure device holds", () => {
  const rows = [
    ...Object.entries(kinds).map(([kind, row]) => ({ ...row, name: kind, kind })),
    ...variants,
    ...precedence,
  ];
  for (const { name, kind, facts, answers } of rows) {
    test(name, () => {
      const hold = deviceHold(Object.freeze({ status: "idle", ...facts }));
      expect(hold.kind).toBe(kind);
      expect([
        holdAllowsObservationServiceStart(hold),
        genericAvailabilityOf(hold),
        poolBucketOf(hold),
        holdAllowsHealthRecovery(hold),
        holdBlocksAssignment(hold),
      ]).toEqual(answers);
    });
  }

  test.each(["idle", "busy"] as const)(
    "health error wins over %s binding at legacy boundaries",
    (status) => {
      const device: BindingFields = { sessionId: "owner", status, health: "error" };
      const effective = statusOf(device);
      expect(effective).toBe("error");
      expect(classifyPoolStatus(effective, false)).toBe("error");
      expect(classifyPoolStatus(effective, true)).toBe("error");
      const hold = deviceHold({ sessionId: device.sessionId, status: effective });
      expect(hold.reasons).toContainEqual({ kind: "error" });
      expect(poolBucketOf(hold)).toBe("error");
      expect(JSON.stringify(hold)).not.toContain('"health"');
    },
  );

  test("known holders and simultaneous reasons survive classification", () => {
    const owner = Symbol("identity-owner");
    const hold = deviceHold({
      status: "idle",
      readinessById: true,
      readinessByName: true,
      rehydrationHolder: "restart-owner",
      sessionId: "pooled-owner",
      sessionForDevice: "reverse-owner",
      identityReconcileOwner: owner,
      adbServerResetSessionId: "reset-owner",
    });
    expect(hold.reasons).toEqual([
      { kind: "readiness", by: "id" },
      { kind: "readiness", by: "name" },
      { kind: "rehydration", holder: "restart-owner" },
      { kind: "bound", holder: "pooled-owner", source: "pooled" },
      { kind: "bound", holder: "reverse-owner", source: "reverse" },
      { kind: "identity", source: "unresolved", holder: owner },
      { kind: "adb-reset", holder: "reset-owner" },
    ]);
  });
});
