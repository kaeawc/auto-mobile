import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import {
  chooseIdleEvictions,
  type ResourceState,
  type ResourceView,
  selectAdmission,
} from "../../../src/daemon/sessionBroker/admission";
import { propertyParams } from "../../helpers/fastCheckConfig";

function resource(
  id: string,
  state: ResourceState,
  idleOrder: number,
  compatible = false,
): ResourceView {
  return { id, state, idleOrder, compatible };
}

describe("selectAdmission ordering and hard caps", () => {
  test("waits for a compatible resetting resource within the create-time threshold", () => {
    expect(
      selectAdmission(
        {
          activeOrAcquiringSessions: 0,
          resetWaitThresholdMs: 500,
          resources: [{ ...resource("reset", "resetting", 0, true), expectedReadyMs: 200 }],
        },
        { totalDeviceCap: 1 },
      ),
    ).toEqual({ kind: "wait", resourceId: "reset", waitMs: 200 });
  });

  test.each([
    { compatible: true, expectedReadyMs: undefined },
    { compatible: false, expectedReadyMs: 100 },
    { compatible: true, expectedReadyMs: 0 },
    { compatible: true, expectedReadyMs: 501 },
  ])("does not wait with unsuitable reset readiness %p", (readiness) => {
    expect(
      selectAdmission(
        {
          activeOrAcquiringSessions: 0,
          resetWaitThresholdMs: 500,
          resources: [{ ...resource("reset", "resetting", 0), ...readiness }],
        },
        {},
      ),
    ).toEqual({ kind: "create" });
  });

  test("does not wait when p90 reset readiness exceeds the create-time threshold", () => {
    expect(
      selectAdmission(
        {
          activeOrAcquiringSessions: 0,
          resetWaitThresholdMs: 500,
          resources: [{ ...resource("reset", "resetting", 0, true), expectedReadyMs: 800 }],
        },
        {},
      ),
    ).toEqual({ kind: "create" });
  });

  test("idle reuse and session caps take precedence over reset wait", () => {
    const snapshot = {
      activeOrAcquiringSessions: 1,
      resetWaitThresholdMs: 500,
      resources: [
        resource("idle", "idle", 1, true),
        { ...resource("reset", "resetting", 0, true), expectedReadyMs: 100 },
      ],
    };
    expect(selectAdmission(snapshot, {})).toEqual({ kind: "reuse", resourceId: "idle" });
    expect(selectAdmission(snapshot, { sessionCap: 1 })).toEqual({
      kind: "refuse",
      reason: "session-cap-reached",
    });
  });
  test("omitted limits are unbounded", () => {
    expect(selectAdmission({ activeOrAcquiringSessions: 500, resources: [] }, {})).toEqual({
      kind: "create",
    });
  });

  test("checks the session cap before reuse, creation, or convergence", () => {
    const snapshot = {
      activeOrAcquiringSessions: 2,
      resources: [resource("idle", "idle", 1, true)],
    };
    expect(selectAdmission(snapshot, { sessionCap: 2, totalDeviceCap: 0 })).toEqual({
      kind: "refuse",
      reason: "session-cap-reached",
    });
  });

  test("reuses the newest compatible clean idle with a stable id tie-break", () => {
    const snapshot = {
      activeOrAcquiringSessions: 0,
      resources: [
        resource("older", "idle", 1, true),
        resource("z-tie", "idle", 5, true),
        resource("a-tie", "idle", 5, true),
        resource("new-incompatible", "idle", 10),
      ],
    };
    expect(selectAdmission(snapshot, { totalDeviceCap: 4 })).toEqual({
      kind: "reuse",
      resourceId: "a-tie",
    });
  });

  test("creates when no compatible idle exists and hard total has room", () => {
    const snapshot = {
      activeOrAcquiringSessions: 1,
      resources: [resource("busy", "active", 0, true), resource("wrong-profile", "idle", 1)],
    };
    expect(selectAdmission(snapshot, { totalDeviceCap: 3, idlePoolCap: 0 })).toEqual({
      kind: "create",
    });
  });

  test("at the hard total evicts the oldest idle with a stable id tie-break", () => {
    const snapshot = {
      activeOrAcquiringSessions: 0,
      resources: [
        resource("z-oldest", "idle", 1),
        resource("a-oldest", "idle", 1),
        resource("newer", "idle", 2),
      ],
    };
    expect(selectAdmission(snapshot, { totalDeviceCap: 3 })).toEqual({
      kind: "evict",
      resourceId: "a-oldest",
    });
  });

  test("full pools with no safe idle refuse promptly", () => {
    const states: ResourceState[] = ["reserved", "active", "resetting", "destroying", "unknown"];
    const snapshot = {
      activeOrAcquiringSessions: 0,
      resources: states.map((state, index) => resource(`${state}-${index}`, state, index, true)),
    };
    expect(selectAdmission(snapshot, { totalDeviceCap: states.length })).toEqual({
      kind: "refuse",
      reason: "total-device-cap-reached",
    });
  });

  test("an over-cap pool reuses before evicting an incompatible idle device", () => {
    const snapshot = {
      activeOrAcquiringSessions: 0,
      resources: [
        resource("compatible", "idle", 9, true),
        resource("oldest", "idle", 1),
        resource("unknown", "unknown", 0),
      ],
    };
    expect(selectAdmission(snapshot, { totalDeviceCap: 2 })).toEqual({
      kind: "reuse",
      resourceId: "compatible",
    });
  });

  test("over cap reuses the only compatible idle even when it is oldest", () => {
    expect(
      selectAdmission(
        {
          activeOrAcquiringSessions: 0,
          resources: [resource("warm", "idle", 1, true), resource("wrong", "idle", 2)],
        },
        { totalDeviceCap: 1 },
      ),
    ).toEqual({ kind: "reuse", resourceId: "warm" });
  });

  test("over cap with only compatible idle devices reuses the newest", () => {
    expect(
      selectAdmission(
        {
          activeOrAcquiringSessions: 0,
          resources: [resource("old", "idle", 1, true), resource("new", "idle", 2, true)],
        },
        { totalDeviceCap: 1 },
      ),
    ).toEqual({ kind: "reuse", resourceId: "new" });
  });

  test("over cap without reusable devices evicts the oldest incompatible idle", () => {
    expect(
      selectAdmission(
        {
          activeOrAcquiringSessions: 0,
          resources: [
            resource("compatible-busy", "active", 0, true),
            resource("new-wrong", "idle", 3),
            resource("z-old-wrong", "idle", 1),
            resource("a-old-wrong", "idle", 1),
          ],
        },
        { totalDeviceCap: 2 },
      ),
    ).toEqual({ kind: "evict", resourceId: "a-old-wrong" });
  });

  test("an over-cap pool without idle resources refuses", () => {
    const snapshot = {
      activeOrAcquiringSessions: 0,
      resources: [resource("active", "active", 0), resource("partial", "unknown", 0)],
    };
    expect(selectAdmission(snapshot, { totalDeviceCap: 1 })).toEqual({
      kind: "refuse",
      reason: "total-device-cap-exceeded",
    });
  });

  test("zero caps admit nothing and retain occupied transitional resources", () => {
    expect(
      selectAdmission({ activeOrAcquiringSessions: 0, resources: [] }, { sessionCap: 0 }),
    ).toEqual({ kind: "refuse", reason: "session-cap-reached" });
    expect(
      selectAdmission({ activeOrAcquiringSessions: 0, resources: [] }, { totalDeviceCap: 0 }),
    ).toEqual({ kind: "refuse", reason: "total-device-cap-reached" });
    expect(
      selectAdmission(
        {
          activeOrAcquiringSessions: 0,
          resources: [resource("deleting", "destroying", 0)],
        },
        { totalDeviceCap: 0 },
      ),
    ).toEqual({ kind: "refuse", reason: "total-device-cap-exceeded" });
    // A compatible idle resource is evicted, never reused, under a zero cap (#14462).
    expect(
      selectAdmission(
        { activeOrAcquiringSessions: 0, resources: [resource("idle", "idle", 1, true)] },
        { totalDeviceCap: 0 },
      ),
    ).toEqual({ kind: "evict", resourceId: "idle" });
    // Nor does it wait for a resetting resource it could not hand out once ready.
    expect(
      selectAdmission(
        {
          activeOrAcquiringSessions: 0,
          resetWaitThresholdMs: 500,
          resources: [{ ...resource("reset", "resetting", 0, true), expectedReadyMs: 200 }],
        },
        { totalDeviceCap: 0 },
      ),
    ).toEqual({ kind: "refuse", reason: "total-device-cap-exceeded" });
  });
});

describe("successive admission snapshots", () => {
  test("the durable owner prevents a max-concurrency burst by recording each reservation", () => {
    const beforeReservation = {
      activeOrAcquiringSessions: 1,
      resources: [resource("active", "active", 0)],
    };
    expect(selectAdmission(beforeReservation, { sessionCap: 2, totalDeviceCap: 2 })).toEqual({
      kind: "create",
    });
    // Pure decisions reserve nothing; evaluating the same stale view repeats the same advice.
    expect(selectAdmission(beforeReservation, { sessionCap: 2, totalDeviceCap: 2 })).toEqual({
      kind: "create",
    });

    const afterAtomicReservation = {
      activeOrAcquiringSessions: 2,
      resources: [resource("active", "active", 0), resource("acquiring", "reserved", 0)],
    };
    expect(selectAdmission(afterAtomicReservation, { sessionCap: 2, totalDeviceCap: 2 })).toEqual({
      kind: "refuse",
      reason: "session-cap-reached",
    });
  });

  test("eviction must become confirmed absence before creation is reconsidered", () => {
    const limits = { totalDeviceCap: 1 };
    expect(
      selectAdmission(
        { activeOrAcquiringSessions: 0, resources: [resource("old", "idle", 1)] },
        limits,
      ),
    ).toEqual({ kind: "evict", resourceId: "old" });

    expect(
      selectAdmission(
        { activeOrAcquiringSessions: 0, resources: [resource("old", "destroying", 1)] },
        limits,
      ),
    ).toEqual({ kind: "refuse", reason: "total-device-cap-reached" });

    expect(selectAdmission({ activeOrAcquiringSessions: 0, resources: [] }, limits)).toEqual({
      kind: "create",
    });
  });

  test("a reused resource is unavailable to the next atomic admission", () => {
    const limits = { sessionCap: 1, totalDeviceCap: 1 };
    expect(
      selectAdmission(
        { activeOrAcquiringSessions: 0, resources: [resource("warm", "idle", 1, true)] },
        limits,
      ),
    ).toEqual({ kind: "reuse", resourceId: "warm" });
    expect(
      selectAdmission(
        {
          activeOrAcquiringSessions: 1,
          resources: [resource("warm", "reserved", 1, true)],
        },
        limits,
      ),
    ).toEqual({ kind: "refuse", reason: "session-cap-reached" });
  });
});

describe("chooseIdleEvictions", () => {
  test("enforces the idle cap oldest first while retaining the newest idle", () => {
    const snapshot = {
      activeOrAcquiringSessions: 0,
      resources: [
        resource("newest", "idle", 3),
        resource("oldest", "idle", 1),
        resource("middle", "idle", 2),
      ],
    };
    expect(chooseIdleEvictions(snapshot, { idlePoolCap: 1 })).toEqual(["oldest", "middle"]);
  });

  test("uses enough idle removals to satisfy both idle and total limits", () => {
    const snapshot = {
      activeOrAcquiringSessions: 1,
      resources: [
        resource("active", "active", 0),
        resource("old", "idle", 1),
        resource("new", "idle", 2),
        resource("reset", "resetting", 0),
      ],
    };
    expect(chooseIdleEvictions(snapshot, { idlePoolCap: 1, totalDeviceCap: 2 })).toEqual([
      "old",
      "new",
    ]);
  });

  test("never selects reserved, active, resetting, destroying, or unknown resources", () => {
    const snapshot = {
      activeOrAcquiringSessions: 1,
      resources: [
        resource("reserved", "reserved", -10),
        resource("active", "active", -9),
        resource("resetting", "resetting", -8),
        resource("destroying", "destroying", -7),
        resource("unknown", "unknown", -6),
        resource("idle", "idle", 5),
      ],
    };
    expect(chooseIdleEvictions(snapshot, { totalDeviceCap: 0, idlePoolCap: 0 })).toEqual(["idle"]);
  });

  test("returns every safe idle when total convergence needs more removals than exist", () => {
    const snapshot = {
      activeOrAcquiringSessions: 2,
      resources: [
        resource("active", "active", 0),
        resource("unknown", "unknown", 0),
        resource("idle", "idle", 1),
      ],
    };
    expect(chooseIdleEvictions(snapshot, { totalDeviceCap: 0 })).toEqual(["idle"]);
    expect(chooseIdleEvictions(snapshot, {})).toEqual([]);
  });
});

describe("admission input validation", () => {
  test.each([NaN, Infinity, -1, 1.5])("rejects invalid limit %p", (value) => {
    const snapshot = { activeOrAcquiringSessions: 0, resources: [] };
    expect(() => selectAdmission(snapshot, { totalDeviceCap: value })).toThrow(
      "limits.totalDeviceCap",
    );
    expect(() => chooseIdleEvictions(snapshot, { idlePoolCap: value })).toThrow(
      "limits.idlePoolCap",
    );
  });

  test.each([NaN, Infinity, -1, 1.5])(
    "rejects invalid active/acquiring session count %p",
    (activeOrAcquiringSessions) => {
      expect(() => selectAdmission({ activeOrAcquiringSessions, resources: [] }, {})).toThrow(
        "snapshot.activeOrAcquiringSessions",
      );
    },
  );

  test("rejects malformed resources and duplicate identities", () => {
    const base = { activeOrAcquiringSessions: 0 };
    expect(() =>
      selectAdmission({ ...base, resources: [resource("bad", "invalid" as ResourceState, 0)] }, {}),
    ).toThrow("state is invalid");
    expect(() =>
      selectAdmission({ ...base, resources: [resource("bad", "idle", NaN)] }, {}),
    ).toThrow("idleOrder must be a finite number");
    expect(() =>
      selectAdmission(
        {
          ...base,
          resources: [resource("same", "idle", 0), resource("same", "active", 1)],
        },
        {},
      ),
    ).toThrow("duplicate id 'same'");
  });

  test("rejects missing required fields and sparse resource arrays", () => {
    expect(() => selectAdmission({ resources: [] } as never, {})).toThrow(
      "snapshot.activeOrAcquiringSessions",
    );
    expect(() =>
      selectAdmission({ activeOrAcquiringSessions: 0, resources: new Array(1) }, {}),
    ).toThrow("snapshot.resources[0] must be an object");
    expect(() =>
      selectAdmission(
        {
          activeOrAcquiringSessions: 0,
          resources: [{ ...resource("idle", "idle", 0), compatible: undefined as never }],
        },
        {},
      ),
    ).toThrow("compatible must be a boolean");
  });
});

const stateArbitrary = fc.constantFrom<ResourceState>(
  "reserved",
  "active",
  "idle",
  "resetting",
  "destroying",
  "unknown",
);
const resourcesArbitrary = fc
  .array(
    fc.record({
      state: stateArbitrary,
      idleOrder: fc.integer({ min: -20, max: 20 }),
      compatible: fc.boolean(),
    }),
    { maxLength: 20 },
  )
  .map((rows) => rows.map((row, index) => ({ id: `resource-${index}`, ...row })));

describe("admission bounded properties", () => {
  test("never creates at or beyond the hard total", () => {
    fc.assert(
      fc.property(
        resourcesArbitrary,
        fc.integer({ min: 0, max: 20 }),
        (resources, totalDeviceCap) => {
          const decision = selectAdmission(
            { activeOrAcquiringSessions: 0, resources },
            { totalDeviceCap },
          );
          return resources.length < totalDeviceCap || decision.kind !== "create";
        },
      ),
      propertyParams(),
    );
  });

  test("over-cap snapshots reuse compatible idle, evict idle, or refuse", () => {
    fc.assert(
      fc.property(resourcesArbitrary, fc.integer({ min: 0, max: 20 }), (resources, cap) => {
        fc.pre(resources.length > cap);
        const decision = selectAdmission(
          { activeOrAcquiringSessions: 0, resources },
          { totalDeviceCap: cap },
        );
        if (decision.kind === "refuse") {
          return decision.reason === "total-device-cap-exceeded";
        }
        if (decision.kind === "reuse") {
          const selected = resources.find((candidate) => candidate.id === decision.resourceId);
          return selected?.state === "idle" && selected.compatible;
        }
        return (
          decision.kind === "evict" &&
          resources.find((candidate) => candidate.id === decision.resourceId)?.state === "idle"
        );
      }),
      propertyParams(),
    );
  });

  test("return-time eviction never selects a non-idle resource", () => {
    fc.assert(
      fc.property(
        resourcesArbitrary,
        fc.integer({ min: 0, max: 20 }),
        fc.integer({ min: 0, max: 20 }),
        (resources, totalDeviceCap, idlePoolCap) => {
          const selected = chooseIdleEvictions(
            { activeOrAcquiringSessions: 0, resources },
            { totalDeviceCap, idlePoolCap },
          );
          return selected.every(
            (id) => resources.find((candidate) => candidate.id === id)?.state === "idle",
          );
        },
      ),
      propertyParams(),
    );
  });
});
