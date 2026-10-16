/** Facts omitted by a consumer's narrow snapshot are irrelevant to that consumer, not unknown. */
export interface DeviceHoldFacts {
  readonly status: "idle" | "busy" | "error";
  readonly sessionId?: string | null;
  readonly brokerBinding?: boolean;
  readonly foreignDaemon?: boolean;
  readonly readinessById?: boolean;
  readonly readinessByName?: boolean;
  readonly recoveryHandoff?: boolean;
  readonly shutdown?: boolean;
  /** Already relative to the requester, including its own restart/readiness exemption. */
  readonly rehydrationHolder?: string;
  readonly healthMarker?: boolean;
  readonly transportAliasUnassignable?: boolean;
  readonly stableIdentityMissing?: boolean;
  readonly identityUnresolved?: boolean;
  readonly identityReconcileOwner?: symbol;
  readonly adbServerResetSessionId?: string;
  readonly adbStartupLease?: boolean;
  readonly recoveringSerial?: boolean;
  readonly recoveringName?: boolean;
  readonly recoveringStableId?: boolean;
  readonly recoveringSessionLoss?: boolean;
  readonly mcpSessionRecoveryLease?: boolean;
  readonly lifecycleStableReservation?: boolean;
  readonly lifecycleSelectorReservation?: boolean;
  readonly deferredRelease?: boolean;
  readonly cleanupInProgress?: boolean;
  readonly assignmentMutexLocked?: boolean;
  readonly sessionForDevice?: string;
}

type RecoverySource =
  | "handoff"
  | "serial"
  | "name"
  | "stable-id"
  | "session-loss"
  | "mcp-session"
  | "lifecycle-stable"
  | "lifecycle-selector";

type HoldReason =
  | { readonly kind: "free" }
  | { readonly kind: "broker-binding" }
  | { readonly kind: "foreign-daemon" }
  | { readonly kind: "readiness"; readonly by: "id" | "name" }
  | { readonly kind: "recovery"; readonly source: RecoverySource }
  | { readonly kind: "shutdown" }
  | { readonly kind: "rehydration"; readonly holder: string }
  | { readonly kind: "error" }
  | { readonly kind: "busy" }
  | { readonly kind: "bound"; readonly holder: string; readonly source: "pooled" | "reverse" }
  | { readonly kind: "health" }
  | { readonly kind: "transport-alias" }
  | {
      readonly kind: "identity";
      readonly source: "missing" | "unresolved";
      readonly holder?: symbol;
    }
  | { readonly kind: "adb-reset"; readonly holder?: string }
  | { readonly kind: "cleanup"; readonly source: "pending" | "deferred" }
  | { readonly kind: "assignment" };

/**
 * The primary kind is the first reason; reasons retain independent holds so policies do not lose
 * conjunctions. In particular, a slot plus cleanup still blocks observation and health recovery.
 */
export type DeviceHold = HoldReason & {
  readonly status: DeviceHoldFacts["status"];
  readonly reasons: readonly HoldReason[];
};

export type GenericAvailability = "free" | "session_broker" | "foreign_daemon" | "reserved";
export type PoolStatusBucket = "idle" | "assigned" | "error";

const HOLD_REASONS: readonly ((
  facts: DeviceHoldFacts,
) => HoldReason | false | null | undefined | "")[] = [
  (facts) => facts.brokerBinding && { kind: "broker-binding" },
  (facts) => facts.foreignDaemon && { kind: "foreign-daemon" },
  (facts) => facts.readinessById && { kind: "readiness", by: "id" },
  (facts) => facts.readinessByName && { kind: "readiness", by: "name" },
  (facts) => facts.recoveryHandoff && { kind: "recovery", source: "handoff" },
  (facts) => facts.shutdown && { kind: "shutdown" },
  (facts) =>
    facts.rehydrationHolder !== undefined && {
      kind: "rehydration",
      holder: facts.rehydrationHolder,
    },
  (facts) => facts.status === "error" && { kind: "error" },
  (facts) => facts.status === "busy" && { kind: "busy" },
  (facts) => facts.sessionId && { kind: "bound", holder: facts.sessionId, source: "pooled" },
  (facts) =>
    facts.sessionForDevice !== undefined && {
      kind: "bound",
      holder: facts.sessionForDevice,
      source: "reverse",
    },
  (facts) => facts.healthMarker && { kind: "health" },
  (facts) => facts.transportAliasUnassignable && { kind: "transport-alias" },
  (facts) => facts.stableIdentityMissing && { kind: "identity", source: "missing" },
  (facts) => facts.identityUnresolved && { kind: "identity", source: "unresolved" },
  (facts) =>
    facts.identityReconcileOwner && {
      kind: "identity",
      source: "unresolved",
      holder: facts.identityReconcileOwner,
    },
  (facts) =>
    facts.adbServerResetSessionId && { kind: "adb-reset", holder: facts.adbServerResetSessionId },
  (facts) => facts.adbStartupLease && { kind: "adb-reset" },
  (facts) => facts.cleanupInProgress && { kind: "cleanup", source: "pending" },
  (facts) => facts.deferredRelease && { kind: "cleanup", source: "deferred" },
  (facts) => facts.assignmentMutexLocked && { kind: "assignment" },
  (facts) => facts.recoveringSerial && { kind: "recovery", source: "serial" },
  (facts) => facts.recoveringName && { kind: "recovery", source: "name" },
  (facts) => facts.recoveringStableId && { kind: "recovery", source: "stable-id" },
  (facts) => facts.recoveringSessionLoss && { kind: "recovery", source: "session-loss" },
  (facts) => facts.mcpSessionRecoveryLease && { kind: "recovery", source: "mcp-session" },
  (facts) => facts.lifecycleStableReservation && { kind: "recovery", source: "lifecycle-stable" },
  (facts) =>
    facts.lifecycleSelectorReservation && { kind: "recovery", source: "lifecycle-selector" },
];

/**
 * Precedence: broker-binding, foreign-daemon, readiness (id then name), recovery handoff, shutdown,
 * rehydration, error, busy, bound, health, transport-alias, identity, adb-reset, cleanup, assignment,
 * then observation-only recovery fences. Free is the fallback. Policies inspect all reasons:
 * primary-kind precedence describes the holder, not a new common admission rule (#11803).
 */
export function deviceHold(facts: DeviceHoldFacts): DeviceHold {
  const reasons = HOLD_REASONS.map((read) => read(facts)).filter(
    (reason): reason is HoldReason => !!reason,
  );
  const primary = reasons[0] ?? { kind: "free" };
  return { ...primary, status: facts.status, reasons: reasons.length ? reasons : [primary] };
}

export function holdAllowsObservationServiceStart(hold: DeviceHold): boolean {
  return hold.reasons.every((reason) => {
    switch (reason.kind) {
      case "free":
      case "broker-binding":
      case "foreign-daemon":
      case "transport-alias":
        return true;
      case "error":
      case "busy":
      case "bound":
        return false;
      default:
        return (() => {
          switch (reason.kind) {
            case "readiness":
            case "recovery":
            case "shutdown":
            case "rehydration":
            case "health":
            case "identity":
            case "adb-reset":
            case "cleanup":
            case "assignment":
              return false;
            default: {
              const exhaustive: never = reason;
              return exhaustive;
            }
          }
        })();
    }
  });
}

export function genericAvailabilityOf(hold: DeviceHold): GenericAvailability {
  const availability = hold.reasons.map((reason): GenericAvailability => {
    switch (reason.kind) {
      case "free":
      case "error":
      case "busy":
      case "bound":
      case "health":
      case "transport-alias":
      case "identity":
      case "adb-reset":
      case "cleanup":
      case "assignment":
        return "free";
      default:
        return (() => {
          switch (reason.kind) {
            case "broker-binding":
              return "session_broker";
            case "foreign-daemon":
              return "foreign_daemon";
            case "readiness":
            case "shutdown":
            case "rehydration":
              return "reserved";
            case "recovery":
              return reason.source === "handoff" ? "reserved" : "free";
            default: {
              const exhaustive: never = reason;
              return exhaustive;
            }
          }
        })();
    }
  });
  return availability.find((value) => value !== "free") ?? "free";
}

/** Error wins over every hold; busy or unlendable devices count as assigned. */
export function classifyPoolStatus(
  status: DeviceHoldFacts["status"],
  unlendable: boolean,
): PoolStatusBucket {
  if (status === "error") {
    return "error";
  }
  return status === "busy" || unlendable ? "assigned" : "idle";
}

export function poolBucketOf(hold: DeviceHold): PoolStatusBucket {
  const unlendable = hold.reasons.some((reason) => {
    switch (reason.kind) {
      case "broker-binding":
      case "foreign-daemon":
      case "readiness":
      case "shutdown":
      case "rehydration":
      case "health":
      case "transport-alias":
        return true;
      default:
        return (() => {
          switch (reason.kind) {
            case "recovery":
              return reason.source === "handoff";
            case "free":
            case "error":
            case "busy":
            case "bound":
            case "identity":
            case "adb-reset":
            case "cleanup":
            case "assignment":
              return false;
            default: {
              const exhaustive: never = reason;
              return exhaustive;
            }
          }
        })();
    }
  });
  return classifyPoolStatus(hold.status, unlendable);
}

export function holdAllowsHealthRecovery(hold: DeviceHold): boolean {
  return hold.reasons.every((reason) => {
    switch (reason.kind) {
      case "error":
      case "busy":
        return false;
      case "bound":
        return reason.source !== "pooled";
      case "cleanup":
        return reason.source !== "pending";
      case "free":
        return true;
      default:
        return (() => {
          switch (reason.kind) {
            case "broker-binding":
            case "foreign-daemon":
            case "readiness":
            case "recovery":
            case "shutdown":
            case "rehydration":
            case "health":
            case "transport-alias":
            case "identity":
            case "adb-reset":
            case "assignment":
              return true;
            default: {
              const exhaustive: never = reason;
              return exhaustive;
            }
          }
        })();
    }
  });
}

export function holdBlocksAssignment(hold: DeviceHold): boolean {
  return hold.reasons.some((reason) => {
    switch (reason.kind) {
      case "readiness":
      case "shutdown":
      case "rehydration":
        return true;
      case "recovery":
        return reason.source === "handoff";
      case "free":
        return false;
      default:
        return (() => {
          switch (reason.kind) {
            case "broker-binding":
            case "foreign-daemon":
            case "error":
            case "busy":
            case "bound":
            case "health":
            case "transport-alias":
            case "identity":
            case "adb-reset":
            case "cleanup":
            case "assignment":
              return false;
            default: {
              const exhaustive: never = reason;
              return exhaustive;
            }
          }
        })();
    }
  });
}
