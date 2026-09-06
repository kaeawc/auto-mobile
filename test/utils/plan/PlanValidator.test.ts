import { describe, expect, test } from "bun:test";
import { PlanValidator } from "../../../src/utils/plan/PlanValidator";
import { ActionableError } from "../../../src/models";
import type { Plan } from "../../../src/models/Plan";
import { YamlPlanSerializer } from "../../../src/utils/plan/PlanSerializer";
import fs from "fs/promises";

// This suite is the merged canonical home for PlanValidator coverage. It absorbs
// the validateCriticalSectionLocks / validateMultiDeviceRequirements / YAML-anchor
// cases that previously lived only in test/plan/PlanValidator.test.ts (issue #4180
// D5), and strengthens the previously message-less toThrow(ActionableError) rows
// with the exact thrown message so they cannot pass against an unconditional throw
// (issue #4180 P3).

describe("PlanValidator", () => {
  describe("validate", () => {
    test("accepts valid single-device plan", () => {
      const plan: Plan = {
        name: "Test Plan",
        steps: [{ tool: "tapOn", params: { text: "Login" } }],
      };
      expect(() => PlanValidator.validate(plan)).not.toThrow();
    });

    test("accepts valid multi-device plan with device labels", () => {
      const plan: Plan = {
        name: "Multi Device",
        devices: ["phone", "tablet"],
        steps: [
          { tool: "tapOn", params: { text: "Login", device: "phone" } },
          { tool: "tapOn", params: { text: "Login", device: "tablet" } },
        ],
      };
      expect(() => PlanValidator.validate(plan)).not.toThrow();
    });

    test("accepts plan with device definitions", () => {
      const plan: Plan = {
        name: "Multi Device",
        devices: [
          { label: "phone", platform: "android" },
          { label: "tablet", platform: "ios" },
        ],
        steps: [
          { tool: "tapOn", params: { text: "Login", device: "phone" } },
          { tool: "tapOn", params: { text: "Login", device: "tablet" } },
        ],
      };
      expect(() => PlanValidator.validate(plan)).not.toThrow();
    });

    test("throws with a name message on missing name", () => {
      const plan = { name: "", steps: [{ tool: "tapOn", params: {} }] } as Plan;
      expect(() => PlanValidator.validate(plan)).toThrow(ActionableError);
      expect(() => PlanValidator.validate(plan)).toThrow("Plan must have a valid name");
    });

    test("throws with a name message on non-string name", () => {
      const plan = { name: 123 as unknown as string, steps: [] } as Plan;
      expect(() => PlanValidator.validate(plan)).toThrow("Plan must have a valid name");
    });

    test("throws with a steps message on missing steps", () => {
      const plan = { name: "Test", steps: null as unknown as Plan["steps"] } as Plan;
      expect(() => PlanValidator.validate(plan)).toThrow("Plan must have a steps array");
    });

    test("throws with a steps message on non-array steps", () => {
      const plan = { name: "Test", steps: "not-an-array" as unknown as Plan["steps"] } as Plan;
      expect(() => PlanValidator.validate(plan)).toThrow("Plan must have a steps array");
    });

    test("throws with an empty-devices message on empty devices array", () => {
      const plan: Plan = { name: "Test", devices: [], steps: [] };
      expect(() => PlanValidator.validate(plan)).toThrow(ActionableError);
      expect(() => PlanValidator.validate(plan)).toThrow("devices' array cannot be empty");
    });

    test("throws with a duplicate-labels message on duplicate device labels", () => {
      const plan: Plan = { name: "Test", devices: ["phone", "phone"], steps: [] };
      expect(() => PlanValidator.validate(plan)).toThrow("duplicate labels");
    });

    test("throws with a non-empty-string message on empty string device label", () => {
      const plan: Plan = { name: "Test", devices: ["phone", ""], steps: [] };
      expect(() => PlanValidator.validate(plan)).toThrow("Device labels must be non-empty strings");
    });

    test("throws with a non-empty-string message on a whitespace-only device label", () => {
      // A whitespace-only label like " " is a non-empty string, but the
      // daemon trims labels before checking emptiness -- a lone space
      // must not be treated as a valid device label (#6215 review).
      const plan: Plan = { name: "Test", devices: [" "], steps: [] };
      expect(() => PlanValidator.validate(plan)).toThrow("Device labels must be non-empty strings");
    });

    test("throws with a mixed-format message on mixed device formats", () => {
      const plan: Plan = {
        name: "Test",
        devices: ["phone", { label: "tablet", platform: "android" }],
        steps: [],
      };
      expect(() => PlanValidator.validate(plan)).toThrow("do not mix formats");
    });

    test("throws with a platform message on invalid device platform", () => {
      const plan: Plan = {
        name: "Test",
        devices: [{ label: "phone", platform: "windows" as unknown as "android" }],
        steps: [],
      };
      expect(() => PlanValidator.validate(plan)).toThrow("Invalid device platform");
    });

    test("throws with a non-empty-string message on empty device label in definition", () => {
      const plan: Plan = {
        name: "Test",
        devices: [{ label: "", platform: "android" }],
        steps: [],
      };
      expect(() => PlanValidator.validate(plan)).toThrow("Device labels must be non-empty strings");
    });

    test("throws naming the offending step on a missing device label in steps", () => {
      const plan: Plan = {
        name: "Test",
        devices: ["phone", "tablet"],
        steps: [
          { tool: "tapOn", params: { text: "Login", device: "phone" } },
          { tool: "tapOn", params: { text: "Login" } },
        ],
      };
      expect(() => PlanValidator.validate(plan)).toThrow("missing 'device' parameter");
      expect(() => PlanValidator.validate(plan)).toThrow("step 1 (tapOn)");
    });

    test("throws naming the device on an undeclared device label in steps", () => {
      const plan: Plan = {
        name: "Test",
        devices: ["phone"],
        steps: [{ tool: "tapOn", params: { text: "Login", device: "tablet" } }],
      };
      expect(() => PlanValidator.validate(plan)).toThrow("invalid device labels");
      expect(() => PlanValidator.validate(plan)).toThrow('device="tablet"');
    });

    test("throws when steps use device labels without declaring devices", () => {
      const plan: Plan = {
        name: "Test",
        steps: [{ tool: "tapOn", params: { text: "Login", device: "phone" } }],
      };
      expect(() => PlanValidator.validate(plan)).toThrow("does not declare 'devices' field");
    });

    test("throws when criticalSection is used without declaring devices", () => {
      const plan: Plan = {
        name: "Test",
        steps: [{ tool: "criticalSection", params: { name: "sync" } }],
      };
      expect(() => PlanValidator.validate(plan)).toThrow("does not declare 'devices' field");
    });

    test("accepts an inline-form barrier step with a declared device (no spurious missing-device error)", () => {
      // Before PlanNormalizer merges inline fields into params, a step's
      // 'device' can sit directly on the step rather than nested under
      // params. validateDeviceLabelsPresent must resolve this via
      // effectiveField, not a raw params?.device read, or a perfectly valid
      // inline barrier plan is rejected with a spurious missing-device
      // error (#6215 review).
      const plan: any = {
        name: "Inline barrier device label",
        devices: ["A", "B"],
        steps: [
          { tool: "barrier", device: "A", lock: "sync1", deviceCount: 2 },
          { tool: "barrier", device: "B", lock: "sync1", deviceCount: 2 },
        ],
      };
      expect(() => PlanValidator.validate(plan)).not.toThrow();
    });
  });

  describe("validateCriticalSectionLocks", () => {
    test("throws naming the criticalSection step when it is missing its own device label", () => {
      const plan: Plan = {
        name: "Plan with Bare Critical Section",
        devices: ["A", "B"],
        steps: [
          { tool: "observe", params: { device: "A" } },
          {
            tool: "criticalSection",
            params: {
              lock: "sync1",
              deviceCount: 2,
              steps: [{ tool: "tapOn", params: { text: "Sync", device: "A" } }],
            },
          },
        ],
      };
      expect(() => PlanValidator.validate(plan)).toThrow("missing 'device' parameter");
      expect(() => PlanValidator.validate(plan)).toThrow("step 1 (criticalSection)");
    });

    test("accepts matched per-device criticalSection steps that share a lock", () => {
      const plan: Plan = {
        name: "Plan with Per-Device Critical Sections",
        devices: ["A", "B"],
        steps: [
          { tool: "observe", params: { device: "A" } },
          {
            tool: "criticalSection",
            params: {
              device: "A",
              lock: "sync1",
              deviceCount: 2,
              steps: [{ tool: "tapOn", params: { text: "Sync", device: "A" } }],
            },
          },
          {
            tool: "criticalSection",
            params: {
              device: "B",
              lock: "sync1",
              deviceCount: 2,
              steps: [{ tool: "observe", params: { device: "B" } }],
            },
          },
          { tool: "observe", params: { device: "B" } },
        ],
      };
      expect(() => PlanValidator.validate(plan)).not.toThrow();
    });

    test("accepts a well-formed dual-device critical section sharing a lock", () => {
      const plan: Plan = {
        name: "Well-formed dual-device critical section",
        devices: ["A", "B"],
        steps: [
          {
            tool: "criticalSection",
            params: {
              device: "A",
              lock: "shared",
              deviceCount: 2,
              steps: [{ tool: "inputText", params: { device: "A", text: "hi" } }],
            },
          },
          {
            tool: "criticalSection",
            params: {
              device: "B",
              lock: "shared",
              deviceCount: 2,
              steps: [{ tool: "observe", params: { device: "B" } }],
            },
          },
        ],
      };
      expect(() => PlanValidator.validate(plan)).not.toThrow();
    });

    test("throws when steps sharing a lock disagree on deviceCount", () => {
      const plan: Plan = {
        name: "Inconsistent deviceCount",
        devices: ["A", "B"],
        steps: [
          {
            tool: "criticalSection",
            params: {
              device: "A",
              lock: "shared",
              deviceCount: 2,
              steps: [{ tool: "observe", params: { device: "A" } }],
            },
          },
          {
            tool: "criticalSection",
            params: {
              device: "B",
              lock: "shared",
              deviceCount: 3,
              steps: [{ tool: "observe", params: { device: "B" } }],
            },
          },
        ],
      };
      expect(() => PlanValidator.validate(plan)).toThrow(ActionableError);
      expect(() => PlanValidator.validate(plan)).toThrow("inconsistent deviceCount values");
    });

    test("throws when a lock declares more devices than the steps that reference it", () => {
      const plan: Plan = {
        name: "Underpopulated lock",
        devices: ["A", "B"],
        steps: [
          {
            tool: "criticalSection",
            params: {
              device: "A",
              lock: "shared",
              deviceCount: 2,
              steps: [{ tool: "observe", params: { device: "A" } }],
            },
          },
        ],
      };
      expect(() => PlanValidator.validate(plan)).toThrow(
        "declares deviceCount=2 but 1 step references it",
      );
    });

    test("throws when the same device enters a lock twice", () => {
      const plan: Plan = {
        name: "Double-entry lock",
        devices: ["A", "B"],
        steps: [
          {
            tool: "criticalSection",
            params: {
              device: "A",
              lock: "shared",
              deviceCount: 2,
              steps: [{ tool: "observe", params: { device: "A" } }],
            },
          },
          {
            tool: "criticalSection",
            params: {
              device: "A",
              lock: "shared",
              deviceCount: 2,
              steps: [{ tool: "tapOn", params: { device: "A" } }],
            },
          },
        ],
      };
      expect(() => PlanValidator.validate(plan)).toThrow('entered twice by device "A"');
    });

    test("throws naming the sub-step when a criticalSection sub-step is missing device", () => {
      const plan: Plan = {
        name: "Invalid Critical Section Plan",
        devices: ["A", "B"],
        steps: [
          { tool: "observe", params: { device: "A" } },
          {
            tool: "criticalSection",
            params: {
              lock: "sync1",
              deviceCount: 2,
              steps: [
                { tool: "tapOn", params: { text: "Sync", device: "A" } },
                { tool: "inputText", params: { text: "hi" } },
              ],
            },
          },
        ],
      };
      expect(() => PlanValidator.validate(plan)).toThrow(
        "Every step inside a criticalSection must declare a 'device' parameter",
      );
      expect(() => PlanValidator.validate(plan)).toThrow("step 1.steps[1] (inputText)");
    });

    test("throws naming the device when a criticalSection sub-step uses an undeclared device", () => {
      const plan: Plan = {
        name: "Invalid Critical Section Plan",
        devices: ["A", "B"],
        steps: [
          {
            tool: "criticalSection",
            params: {
              lock: "sync1",
              deviceCount: 2,
              steps: [
                { tool: "tapOn", params: { text: "Sync", device: "A" } },
                { tool: "observe", params: { device: "C" } },
              ],
            },
          },
        ],
      };
      expect(() => PlanValidator.validate(plan)).toThrow(
        "criticalSection sub-steps use invalid device labels",
      );
      expect(() => PlanValidator.validate(plan)).toThrow('device="C"');
    });
  });

  describe("validateBarrierParams", () => {
    test("accepts a well-formed dual-device barrier sharing a lock", () => {
      const plan: Plan = {
        name: "Well-formed dual-device barrier",
        devices: ["A", "B"],
        steps: [
          { tool: "barrier", params: { device: "A", lock: "sync1", deviceCount: 2 } },
          { tool: "barrier", params: { device: "B", lock: "sync1", deviceCount: 2 } },
        ],
      };
      expect(() => PlanValidator.validate(plan)).not.toThrow();
    });

    test("accepts a barrier reused across multiple rounds with a consistent deviceCount, even when different rounds involve different devices", () => {
      // Barrier rounds aren't statically delineated in plan YAML, and are not
      // required to share the same participants: cross-round arrival-count
      // consistency is left to the runtime coordinator
      // (CriticalSectionCoordinator), which matches arrivals per round at
      // execution time. Static validation only checks each step's own
      // params, plus the plan-wide distinct-device/divisibility invariants
      // -- deviceCount itself must stay consistent across every reuse of a
      // given lock (see validateBarrierConsistentDeviceCount).
      const plan: Plan = {
        name: "Multi-round barrier with varying device sets, consistent deviceCount",
        devices: ["A", "B", "C"],
        steps: [
          { tool: "barrier", params: { device: "A", lock: "sync1", deviceCount: 2 } },
          { tool: "barrier", params: { device: "B", lock: "sync1", deviceCount: 2 } },
          { tool: "barrier", params: { device: "A", lock: "sync1", deviceCount: 2 } },
          { tool: "barrier", params: { device: "C", lock: "sync1", deviceCount: 2 } },
        ],
      };
      expect(() => PlanValidator.validate(plan)).not.toThrow();
    });

    test("throws when a barrier step is missing 'lock'", () => {
      const plan: Plan = {
        name: "Barrier missing lock",
        devices: ["A"],
        steps: [{ tool: "barrier", params: { device: "A", deviceCount: 2 } }],
      };
      expect(() => PlanValidator.validate(plan)).toThrow(ActionableError);
      expect(() => PlanValidator.validate(plan)).toThrow(
        "barrier step 0 is missing a non-empty 'lock' parameter",
      );
    });

    test("throws when a barrier step is missing 'deviceCount'", () => {
      const plan: Plan = {
        name: "Barrier missing deviceCount",
        devices: ["A"],
        steps: [{ tool: "barrier", params: { device: "A", lock: "sync1" } }],
      };
      expect(() => PlanValidator.validate(plan)).toThrow(ActionableError);
      expect(() => PlanValidator.validate(plan)).toThrow(
        "barrier step 0 must declare a positive integer 'deviceCount'",
      );
    });

    test("throws when a barrier step declares a non-positive-integer 'deviceCount'", () => {
      const plan: Plan = {
        name: "Barrier bad deviceCount",
        devices: ["A"],
        steps: [{ tool: "barrier", params: { device: "A", lock: "sync1", deviceCount: 0 } }],
      };
      expect(() => PlanValidator.validate(plan)).toThrow(
        "barrier step 0 must declare a positive integer 'deviceCount'",
      );
    });
  });

  describe("validateBarrierDistinctDeviceCounts", () => {
    test("throws when fewer distinct devices target a lock than its declared deviceCount", () => {
      // Two distinct devices (A, B) can never produce the 3 arrivals
      // deviceCount=3 demands -- no round can ever complete.
      const plan: Plan = {
        name: "Underpopulated barrier lock",
        devices: ["A", "B"],
        steps: [
          { tool: "barrier", params: { device: "A", lock: "sync1", deviceCount: 3 } },
          { tool: "barrier", params: { device: "B", lock: "sync1", deviceCount: 3 } },
        ],
      };
      expect(() => PlanValidator.validate(plan)).toThrow(ActionableError);
      expect(() => PlanValidator.validate(plan)).toThrow(
        'barrier lock "sync1" declares deviceCount=3 but only 2 distinct devices',
      );
    });

    test("accepts a lock with exactly deviceCount distinct devices, even when reused across rounds", () => {
      const plan: Plan = {
        name: "Fully-populated barrier lock reused across rounds",
        devices: ["A", "B", "C"],
        steps: [
          { tool: "barrier", params: { device: "A", lock: "sync1", deviceCount: 3 } },
          { tool: "barrier", params: { device: "B", lock: "sync1", deviceCount: 3 } },
          { tool: "barrier", params: { device: "C", lock: "sync1", deviceCount: 3 } },
          // Round 2 reuse of the same lock by the same 3 devices.
          { tool: "barrier", params: { device: "A", lock: "sync1", deviceCount: 3 } },
          { tool: "barrier", params: { device: "B", lock: "sync1", deviceCount: 3 } },
          { tool: "barrier", params: { device: "C", lock: "sync1", deviceCount: 3 } },
        ],
      };
      expect(() => PlanValidator.validate(plan)).not.toThrow();
    });

    test("throws when a barrier plan targets device labels outside the declared 'devices' set", () => {
      // devices=[A,B] but the barrier steps target C/D: the distinct-device
      // count (2) would otherwise satisfy deviceCount=2, but C/D are not
      // declared devices at all, so this must be rejected regardless.
      const plan: Plan = {
        name: "Barrier targets undeclared devices",
        devices: ["A", "B"],
        steps: [
          { tool: "barrier", params: { device: "C", lock: "sync1", deviceCount: 2 } },
          { tool: "barrier", params: { device: "D", lock: "sync1", deviceCount: 2 } },
        ],
      };
      expect(() => PlanValidator.validate(plan)).toThrow(ActionableError);
      expect(() => PlanValidator.validate(plan)).toThrow(
        "the following steps use invalid device labels",
      );
    });

    test("throws when a barrier step omits 'device' entirely under a declared devices set", () => {
      // devices=[A]: one deviceCount=1 barrier step for this lock omits
      // 'device' altogether while another targets A. The device-less step
      // is rejected by validateDeviceLabelsPresent (generic to every tool,
      // barrier included) before the coordination checks ever run.
      const plan: Plan = {
        name: "Barrier step missing device",
        devices: ["A"],
        steps: [
          { tool: "barrier", params: { lock: "sync1", deviceCount: 1 } },
          { tool: "barrier", params: { device: "A", lock: "sync1", deviceCount: 1 } },
        ],
      };
      expect(() => PlanValidator.validate(plan)).toThrow(ActionableError);
      expect(() => PlanValidator.validate(plan)).toThrow(
        "the following steps are missing 'device' parameter",
      );
    });
  });

  describe("validateBarrierGenerationCompleteness", () => {
    // Sound generation-completeness check: for a lock with a single
    // consistent deviceCount N, the total arrival count across the plan
    // must be an exact multiple of N, or a trailing generation is
    // necessarily incomplete and deadlocks forever. This is checked without
    // reconstructing rounds (deliberately not per-device-ordinal grouping,
    // which was removed earlier as unsound).
    test("throws when a reused barrier lock's total arrivals are not a multiple of deviceCount", () => {
      // A, B, A with deviceCount=2: 2 distinct devices satisfies the
      // distinct-device check, but 3 total arrivals is not a multiple of 2
      // -- generation 1 {A,B} completes and clears, then the trailing A
      // waits alone forever.
      const plan: Plan = {
        name: "Incomplete trailing barrier generation",
        devices: ["A", "B"],
        steps: [
          { tool: "barrier", params: { device: "A", lock: "sync1", deviceCount: 2 } },
          { tool: "barrier", params: { device: "B", lock: "sync1", deviceCount: 2 } },
          { tool: "barrier", params: { device: "A", lock: "sync1", deviceCount: 2 } },
        ],
      };
      expect(() => PlanValidator.validate(plan)).toThrow(ActionableError);
      expect(() => PlanValidator.validate(plan)).toThrow(
        'barrier lock "sync1" has 3 total arrivals across the plan, which is not a multiple of its deviceCount=2',
      );
    });

    test("accepts a reused barrier lock whose total arrivals form complete generations", () => {
      // A, B, A, B with deviceCount=2: 4 total arrivals is a multiple of 2,
      // so both generations complete cleanly.
      const plan: Plan = {
        name: "Complete barrier generations",
        devices: ["A", "B"],
        steps: [
          { tool: "barrier", params: { device: "A", lock: "sync1", deviceCount: 2 } },
          { tool: "barrier", params: { device: "B", lock: "sync1", deviceCount: 2 } },
          { tool: "barrier", params: { device: "A", lock: "sync1", deviceCount: 2 } },
          { tool: "barrier", params: { device: "B", lock: "sync1", deviceCount: 2 } },
        ],
      };
      expect(() => PlanValidator.validate(plan)).not.toThrow();
    });

    test("skips the generation-completeness check when a lock has no single deviceCount to divide by", () => {
      // A lock with zero recorded (valid, positive-integer) deviceCounts has
      // nothing to divide arrivals by; this is a defensive guard, not a
      // reachable case in a plan that also passes validateBarrierParams
      // (which requires every barrier step to declare one).
      const plan: Plan = {
        name: "No valid deviceCount recorded",
        devices: ["A"],
        steps: [{ tool: "barrier", params: { device: "A", lock: "sync1", deviceCount: 1 } }],
      };
      expect(() => PlanValidator.validate(plan)).not.toThrow();
    });
  });

  describe("validateBarrierExcessDeviceArrivals", () => {
    // PlanPartitioner executes each device's track sequentially, so a
    // device can participate in a barrier lock at most once per generation.
    // For a lock with a single consistent deviceCount N and total arrivals
    // T (divisible by N), there are G = T/N generations; a device appearing
    // more than G times can never be scheduled and would deadlock.
    test("throws when a single device arrives more times than there are generations", () => {
      // A, B, A, A with deviceCount=2: 4 arrivals is divisible by 2 (G=2),
      // but device A appears 3 times (> G=2) -- after generation 1 {A,B}
      // releases, A's second arrival starts generation 2, but its third
      // arrival has no generation left to join.
      const plan: Plan = {
        name: "Excess single-device barrier arrivals",
        devices: ["A", "B"],
        steps: [
          { tool: "barrier", params: { device: "A", lock: "sync1", deviceCount: 2 } },
          { tool: "barrier", params: { device: "B", lock: "sync1", deviceCount: 2 } },
          { tool: "barrier", params: { device: "A", lock: "sync1", deviceCount: 2 } },
          { tool: "barrier", params: { device: "A", lock: "sync1", deviceCount: 2 } },
        ],
      };
      expect(() => PlanValidator.validate(plan)).toThrow(ActionableError);
      expect(() => PlanValidator.validate(plan)).toThrow(
        'barrier lock "sync1" has 2 generations available (deviceCount=2, 4 total arrivals), but device "A" arrives 3 times',
      );
    });

    test("accepts a barrier lock where every device arrives at most once per available generation", () => {
      // A, A, B, B with deviceCount=2: G=2, and each device appears exactly
      // 2 times (<= G) -- feasible, since generation 1 can be {A,B} and
      // generation 2 can be {A,B} using the second arrival of each.
      const plan: Plan = {
        name: "Feasible repeated-arrival barrier lock",
        devices: ["A", "B"],
        steps: [
          { tool: "barrier", params: { device: "A", lock: "sync1", deviceCount: 2 } },
          { tool: "barrier", params: { device: "A", lock: "sync1", deviceCount: 2 } },
          { tool: "barrier", params: { device: "B", lock: "sync1", deviceCount: 2 } },
          { tool: "barrier", params: { device: "B", lock: "sync1", deviceCount: 2 } },
        ],
      };
      expect(() => PlanValidator.validate(plan)).not.toThrow();
    });

    test("still accepts the alternating A/B/A/B case", () => {
      const plan: Plan = {
        name: "Alternating barrier generations",
        devices: ["A", "B"],
        steps: [
          { tool: "barrier", params: { device: "A", lock: "sync1", deviceCount: 2 } },
          { tool: "barrier", params: { device: "B", lock: "sync1", deviceCount: 2 } },
          { tool: "barrier", params: { device: "A", lock: "sync1", deviceCount: 2 } },
          { tool: "barrier", params: { device: "B", lock: "sync1", deviceCount: 2 } },
        ],
      };
      expect(() => PlanValidator.validate(plan)).not.toThrow();
    });
  });

  describe("validateBarrierConsistentDeviceCount", () => {
    test("throws when a reused barrier lock declares more than one distinct deviceCount", () => {
      // A/B at deviceCount=2, then A/B/C at deviceCount=3 for the SAME lock
      // name: the runtime coordinator keeps one shared expected count per
      // lock, so mixed-count reuse is racy and must be rejected regardless
      // of whether the distinct-device/divisibility checks would otherwise
      // pass it.
      const plan: Plan = {
        name: "Mixed-count barrier lock reuse",
        devices: ["A", "B", "C"],
        steps: [
          { tool: "barrier", params: { device: "A", lock: "sync1", deviceCount: 2 } },
          { tool: "barrier", params: { device: "B", lock: "sync1", deviceCount: 2 } },
          { tool: "barrier", params: { device: "A", lock: "sync1", deviceCount: 3 } },
          { tool: "barrier", params: { device: "B", lock: "sync1", deviceCount: 3 } },
          { tool: "barrier", params: { device: "C", lock: "sync1", deviceCount: 3 } },
        ],
      };
      expect(() => PlanValidator.validate(plan)).toThrow(ActionableError);
      expect(() => PlanValidator.validate(plan)).toThrow(
        'barrier lock "sync1" is reused with inconsistent deviceCount values (2, 3)',
      );
    });

    test("accepts a reused barrier lock whose deviceCount stays consistent across every use", () => {
      const plan: Plan = {
        name: "Consistent-count barrier lock reuse",
        devices: ["A", "B", "C"],
        steps: [
          { tool: "barrier", params: { device: "A", lock: "sync1", deviceCount: 3 } },
          { tool: "barrier", params: { device: "B", lock: "sync1", deviceCount: 3 } },
          { tool: "barrier", params: { device: "C", lock: "sync1", deviceCount: 3 } },
          { tool: "barrier", params: { device: "A", lock: "sync1", deviceCount: 3 } },
          { tool: "barrier", params: { device: "B", lock: "sync1", deviceCount: 3 } },
          { tool: "barrier", params: { device: "C", lock: "sync1", deviceCount: 3 } },
        ],
      };
      expect(() => PlanValidator.validate(plan)).not.toThrow();
    });
  });

  describe("validateNoCrossToolLockSharing", () => {
    test("throws when the same lock name is used by both a criticalSection and a barrier step", () => {
      // Both tools share the runtime coordinator's lock namespace and
      // expected-count state (keyed by lock name alone), so a
      // criticalSection A/B pair and a barrier C/D pair both using lock
      // "shared" with deviceCount=2 can pair mismatched participants (A
      // with C) and overwrite each other's expected count.
      const plan: Plan = {
        name: "Lock shared across tool types",
        devices: ["A", "B", "C", "D"],
        steps: [
          {
            tool: "criticalSection",
            params: {
              device: "A",
              lock: "shared",
              deviceCount: 2,
              steps: [{ tool: "observe", params: { device: "A" } }],
            },
          },
          {
            tool: "criticalSection",
            params: {
              device: "B",
              lock: "shared",
              deviceCount: 2,
              steps: [{ tool: "observe", params: { device: "B" } }],
            },
          },
          { tool: "barrier", params: { device: "C", lock: "shared", deviceCount: 2 } },
          { tool: "barrier", params: { device: "D", lock: "shared", deviceCount: 2 } },
        ],
      };
      expect(() => PlanValidator.validate(plan)).toThrow(ActionableError);
      expect(() => PlanValidator.validate(plan)).toThrow(
        'lock name "shared" is used by both a criticalSection step and a barrier step',
      );
    });

    test("accepts a plan where criticalSection and barrier use distinct lock names", () => {
      const plan: Plan = {
        name: "Distinct locks per tool type",
        devices: ["A", "B", "C", "D"],
        steps: [
          {
            tool: "criticalSection",
            params: {
              device: "A",
              lock: "cs-lock",
              deviceCount: 2,
              steps: [{ tool: "observe", params: { device: "A" } }],
            },
          },
          {
            tool: "criticalSection",
            params: {
              device: "B",
              lock: "cs-lock",
              deviceCount: 2,
              steps: [{ tool: "observe", params: { device: "B" } }],
            },
          },
          { tool: "barrier", params: { device: "C", lock: "barrier-lock", deviceCount: 2 } },
          { tool: "barrier", params: { device: "D", lock: "barrier-lock", deviceCount: 2 } },
        ],
      };
      expect(() => PlanValidator.validate(plan)).not.toThrow();
    });
  });

  describe("mixed device declaration formats", () => {
    test("throws when 'devices' mixes a plain-string label with a label/platform definition", () => {
      const plan: Plan = {
        name: "Mixed device formats",
        devices: ["A", { label: "B", platform: "android" }],
        steps: [{ tool: "tapOn", params: { text: "hi", device: "A" } }],
      };
      expect(() => PlanValidator.validate(plan)).toThrow(ActionableError);
      expect(() => PlanValidator.validate(plan)).toThrow("do not mix formats");
    });

    test("accepts a 'devices' list of all plain-string labels", () => {
      const plan: Plan = {
        name: "All-label devices",
        devices: ["A", "B"],
        steps: [{ tool: "tapOn", params: { text: "hi", device: "A" } }],
      };
      expect(() => PlanValidator.validate(plan)).not.toThrow();
    });

    test("accepts a 'devices' list of all label/platform definitions", () => {
      const plan: Plan = {
        name: "All-definition devices",
        devices: [
          { label: "A", platform: "android" },
          { label: "B", platform: "ios" },
        ],
        steps: [{ tool: "tapOn", params: { text: "hi", device: "A" } }],
      };
      expect(() => PlanValidator.validate(plan)).not.toThrow();
    });
  });

  describe("params-wins precedence for split inline/params coordination fields", () => {
    // PlanNormalizer merges a step's inline fields and its nested `params`
    // object as `{ ...inlineParams, ...paramsFromStep }`, so when the same
    // field appears in both places, the params value wins and the inline
    // value is discarded -- the same precedence #6090/#6107 established for
    // networkCondition/doNotDisturb (#6215 review). These exercise the real
    // YAML -> normalize -> validate pipeline so the effective (post-merge)
    // value is what gets checked, not a hand-built already-merged Plan.
    test("validates a barrier's effective (params) deviceCount, not its overridden inline value", async () => {
      // Inline deviceCount=2 would pass the distinct-device-count check on
      // its own (2 distinct devices), but params.deviceCount=3 wins at
      // normalization -- 3 distinct devices are required and only 2 exist,
      // so this must be REJECTED using the effective value of 3, not 2.
      const yaml = `
name: barrier-params-override-devicecount
devices:
  - A
  - B
steps:
  - tool: barrier
    device: A
    lock: sync1
    deviceCount: 2
    params:
      deviceCount: 3
  - tool: barrier
    device: B
    lock: sync1
    params:
      deviceCount: 3
`;
      const serializer = new YamlPlanSerializer();
      expect(() => serializer.importPlanFromYaml(yaml)).toThrow(
        'barrier lock "sync1" declares deviceCount=3 but only 2 distinct devices',
      );
    });

    test("accepts a barrier whose effective (params) deviceCount matches distinct devices, ignoring a smaller inline value", async () => {
      // Inline deviceCount=2 is irrelevant here -- params.deviceCount=2 wins
      // and matches the 2 distinct devices, so this is valid.
      const yaml = `
name: barrier-params-override-devicecount-valid
devices:
  - A
  - B
steps:
  - tool: barrier
    device: A
    lock: sync1
    deviceCount: 999
    params:
      deviceCount: 2
  - tool: barrier
    device: B
    lock: sync1
    params:
      deviceCount: 2
`;
      const serializer = new YamlPlanSerializer();
      expect(() => serializer.importPlanFromYaml(yaml)).not.toThrow();
    });
  });

  describe("hasMultiDeviceFeatures", () => {
    test("returns false for a simple single-device plan", () => {
      const plan: Plan = {
        name: "Test",
        steps: [{ tool: "tapOn", params: { text: "Login" } }],
      };
      expect(PlanValidator.hasMultiDeviceFeatures(plan)).toBe(false);
    });

    test("returns true when the devices field is present", () => {
      const plan: Plan = {
        name: "Test",
        devices: ["phone"],
        steps: [{ tool: "tapOn", params: { text: "Login", device: "phone" } }],
      };
      expect(PlanValidator.hasMultiDeviceFeatures(plan)).toBe(true);
    });

    test("returns true when a step uses the device param", () => {
      const plan: Plan = {
        name: "Test",
        steps: [{ tool: "tapOn", params: { text: "Login", device: "phone" } }],
      };
      expect(PlanValidator.hasMultiDeviceFeatures(plan)).toBe(true);
    });

    test("returns true when criticalSection is used", () => {
      const plan: Plan = {
        name: "Test",
        steps: [{ tool: "criticalSection", params: {} }],
      };
      expect(PlanValidator.hasMultiDeviceFeatures(plan)).toBe(true);
    });

    test("returns true when barrier is used", () => {
      const plan: Plan = {
        name: "Test",
        steps: [{ tool: "barrier", params: {} }],
      };
      expect(PlanValidator.hasMultiDeviceFeatures(plan)).toBe(true);
    });
  });

  describe("validateMultiDeviceRequirements", () => {
    test("passes when the plan uses multi-device features and declares devices", () => {
      const plan: Plan = {
        name: "Plan",
        devices: ["A", "B"],
        steps: [
          { tool: "observe", params: { device: "A" } },
          { tool: "tapOn", params: { device: "B" } },
        ],
      };
      expect(() => PlanValidator.validateMultiDeviceRequirements(plan)).not.toThrow();
    });

    test("throws when the plan uses device labels but declares no devices", () => {
      const plan: Plan = {
        name: "Plan",
        steps: [
          { tool: "observe", params: {} },
          { tool: "tapOn", params: { device: "A" } },
        ],
      };
      expect(() => PlanValidator.validateMultiDeviceRequirements(plan)).toThrow(ActionableError);
      expect(() => PlanValidator.validateMultiDeviceRequirements(plan)).toThrow(
        "does not declare 'devices' field",
      );
    });

    test("throws when the plan uses criticalSection but declares no devices", () => {
      const plan: Plan = {
        name: "Plan",
        steps: [
          { tool: "observe", params: {} },
          { tool: "criticalSection", params: { lock: "sync1", deviceCount: 2, steps: [] } },
        ],
      };
      expect(() => PlanValidator.validateMultiDeviceRequirements(plan)).toThrow(
        "does not declare 'devices' field",
      );
    });

    test("passes for a simple single-device plan without a devices field", () => {
      const plan: Plan = {
        name: "Plan",
        steps: [
          { tool: "observe", params: {} },
          { tool: "tapOn", params: { text: "Login" } },
        ],
      };
      expect(() => PlanValidator.validateMultiDeviceRequirements(plan)).not.toThrow();
    });
  });

  describe("YAML anchors and merge keys", () => {
    test("parses and validates YAML with anchors and merge keys", async () => {
      const yamlContent = await fs.readFile(
        "test/resources/test-plans/yaml-anchors-test.yaml",
        "utf-8",
      );

      const serializer = new YamlPlanSerializer();
      const plan = serializer.importPlanFromYaml(yamlContent);

      expect(plan.name).toBe("YAML Anchors and Merge Keys Test Plan");
      expect(plan.devices).toEqual(["A", "B"]);
      expect(plan.steps.length).toBe(5);

      expect(plan.steps[0].tool).toBe("launchApp");
      expect(plan.steps[0].params?.appId).toBe("com.example.app");
      expect(plan.steps[0].params?.coldBoot).toBe(false);
      expect(plan.steps[0].params?.device).toBe("A");

      expect(plan.steps[1].tool).toBe("launchApp");
      expect(plan.steps[1].params?.appId).toBe("com.example.app");
      expect(plan.steps[1].params?.coldBoot).toBe(true);
      expect(plan.steps[1].params?.device).toBe("B");

      expect(plan.steps[2].tool).toBe("observe");
      expect(plan.steps[2].params?.includeScreenshot).toBe(true);
      expect(plan.steps[2].params?.includeHierarchy).toBe(true);
      expect(plan.steps[2].params?.device).toBe("A");

      expect(plan.steps[3].tool).toBe("criticalSection");
      expect(plan.steps[3].params?.lock).toBe("sync-point");
      expect(plan.steps[3].params?.deviceCount).toBe(1);
      expect(plan.steps[3].params?.device).toBe("A");

      expect(() => PlanValidator.validate(plan)).not.toThrow();
      expect(() => PlanValidator.validateMultiDeviceRequirements(plan)).not.toThrow();
    });
  });
});
