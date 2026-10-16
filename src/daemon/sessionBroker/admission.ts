export interface BrokerLimits {
  sessionCap?: number;
  totalDeviceCap?: number;
  idlePoolCap?: number;
}

export type ResourceState = "reserved" | "active" | "idle" | "resetting" | "destroying" | "unknown";

export interface ResourceView {
  id: string;
  state: ResourceState;
  /** Larger values are newer. Equal values are ordered by resource id. */
  idleOrder: number;
  compatible: boolean;
}

export interface BrokerSnapshot {
  activeOrAcquiringSessions: number;
  resources: readonly ResourceView[];
}

export type AdmissionRefusalReason =
  | "session-cap-reached"
  | "total-device-cap-reached"
  | "total-device-cap-exceeded";

export type AdmissionDecision =
  | { kind: "reuse"; resourceId: string }
  | { kind: "create" }
  | { kind: "evict"; resourceId: string }
  | { kind: "refuse"; reason: AdmissionRefusalReason };

const RESOURCE_STATES: ReadonlySet<string> = new Set<ResourceState>([
  "reserved",
  "active",
  "idle",
  "resetting",
  "destroying",
  "unknown",
]);

function assertNonNegativeInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(`${name} must be an integer greater than or equal to zero`);
  }
}

function validateLimits(limits: BrokerLimits): void {
  if (typeof limits !== "object" || limits === null) {
    throw new TypeError("limits must be an object");
  }
  if (limits.sessionCap !== undefined) {
    assertNonNegativeInteger(limits.sessionCap, "limits.sessionCap");
  }
  if (limits.totalDeviceCap !== undefined) {
    assertNonNegativeInteger(limits.totalDeviceCap, "limits.totalDeviceCap");
  }
  if (limits.idlePoolCap !== undefined) {
    assertNonNegativeInteger(limits.idlePoolCap, "limits.idlePoolCap");
  }
}

function validateResource(resource: ResourceView, index: number): void {
  const prefix = `snapshot.resources[${index}]`;
  if (typeof resource !== "object" || resource === null) {
    throw new TypeError(`${prefix} must be an object`);
  }
  if (typeof resource.id !== "string" || resource.id.trim().length === 0) {
    throw new TypeError(`${prefix}.id must be a non-blank string`);
  }
  if (!RESOURCE_STATES.has(resource.state)) {
    throw new TypeError(`${prefix}.state is invalid`);
  }
  if (typeof resource.idleOrder !== "number" || !Number.isFinite(resource.idleOrder)) {
    throw new TypeError(`${prefix}.idleOrder must be a finite number`);
  }
  if (typeof resource.compatible !== "boolean") {
    throw new TypeError(`${prefix}.compatible must be a boolean`);
  }
}

function validateSnapshot(snapshot: BrokerSnapshot): void {
  if (typeof snapshot !== "object" || snapshot === null) {
    throw new TypeError("snapshot must be an object");
  }
  assertNonNegativeInteger(
    snapshot.activeOrAcquiringSessions,
    "snapshot.activeOrAcquiringSessions",
  );
  if (!Array.isArray(snapshot.resources)) {
    throw new TypeError("snapshot.resources must be an array");
  }

  const ids = new Set<string>();
  for (let index = 0; index < snapshot.resources.length; index += 1) {
    const resource = snapshot.resources[index];
    validateResource(resource, index);
    if (ids.has(resource.id)) {
      throw new TypeError(`snapshot.resources contains duplicate id '${resource.id}'`);
    }
    ids.add(resource.id);
  }
}

function compareOldest(left: ResourceView, right: ResourceView): number {
  return left.idleOrder - right.idleOrder || left.id.localeCompare(right.id);
}

function idleResources(snapshot: BrokerSnapshot): ResourceView[] {
  return snapshot.resources.filter((resource) => resource.state === "idle").sort(compareOldest);
}

function oldestIdle(snapshot: BrokerSnapshot): ResourceView | undefined {
  return idleResources(snapshot)[0];
}

function newestCompatibleIdle(snapshot: BrokerSnapshot): ResourceView | undefined {
  return idleResources(snapshot)
    .filter((resource) => resource.compatible)
    .sort((left, right) => right.idleOrder - left.idleOrder || left.id.localeCompare(right.id))[0];
}

/**
 * Selects the next admission action from one immutable view and returns immediately.
 *
 * These decisions are not reservations. The durable broker owner must evaluate this function
 * and reserve the chosen session/resource atomically under its transaction or ownership fence.
 * An eviction only asks the owner to delete that idle resource: it never grants permission to
 * create. The owner must confirm absence, take a fresh snapshot, and reconsider admission.
 */
export function selectAdmission(snapshot: BrokerSnapshot, limits: BrokerLimits): AdmissionDecision {
  validateLimits(limits);
  validateSnapshot(snapshot);

  if (limits.sessionCap !== undefined && snapshot.activeOrAcquiringSessions >= limits.sessionCap) {
    return { kind: "refuse", reason: "session-cap-reached" };
  }

  const total = snapshot.resources.length;
  if (limits.totalDeviceCap !== undefined && total > limits.totalDeviceCap) {
    const candidate = oldestIdle(snapshot);
    return candidate
      ? { kind: "evict", resourceId: candidate.id }
      : { kind: "refuse", reason: "total-device-cap-exceeded" };
  }

  const reusable = newestCompatibleIdle(snapshot);
  if (reusable) {
    return { kind: "reuse", resourceId: reusable.id };
  }

  if (limits.totalDeviceCap === undefined || total < limits.totalDeviceCap) {
    return { kind: "create" };
  }

  const candidate = oldestIdle(snapshot);
  return candidate
    ? { kind: "evict", resourceId: candidate.id }
    : { kind: "refuse", reason: "total-device-cap-reached" };
}

/**
 * Returns oldest idle resources whose confirmed removal would enforce the return-time idle and
 * total limits. Active and transitional resources remain occupied and are never selected.
 */
export function chooseIdleEvictions(
  snapshot: BrokerSnapshot,
  limits: BrokerLimits,
): readonly string[] {
  validateLimits(limits);
  validateSnapshot(snapshot);

  const idle = idleResources(snapshot);
  const totalExcess =
    limits.totalDeviceCap === undefined
      ? 0
      : Math.max(0, snapshot.resources.length - limits.totalDeviceCap);
  const idleExcess =
    limits.idlePoolCap === undefined ? 0 : Math.max(0, idle.length - limits.idlePoolCap);
  const required = Math.max(totalExcess, idleExcess);
  return idle.slice(0, required).map((resource) => resource.id);
}
