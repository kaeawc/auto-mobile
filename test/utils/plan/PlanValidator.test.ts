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

  describe("validateCoordinationLocks (barrier)", () => {
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

    test("throws when barrier steps sharing a lock disagree on deviceCount", () => {
      const plan: Plan = {
        name: "Inconsistent barrier deviceCount",
        devices: ["A", "B"],
        steps: [
          { tool: "barrier", params: { device: "A", lock: "shared", deviceCount: 2 } },
          { tool: "barrier", params: { device: "B", lock: "shared", deviceCount: 3 } },
        ],
      };
      expect(() => PlanValidator.validate(plan)).toThrow(ActionableError);
      expect(() => PlanValidator.validate(plan)).toThrow("inconsistent deviceCount values");
    });

    test("throws when a barrier lock declares more devices than the steps that reference it", () => {
      const plan: Plan = {
        name: "Underpopulated barrier lock",
        devices: ["A", "B"],
        steps: [{ tool: "barrier", params: { device: "A", lock: "shared", deviceCount: 2 } }],
      };
      expect(() => PlanValidator.validate(plan)).toThrow(
        "declares deviceCount=2 but 1 step references it",
      );
    });

    test("accepts a barrier reused across two rounds with consistent per-round arrivals", () => {
      // Unlike criticalSection, a barrier is meant to fire once per round: the
      // same lock name recurs across phases, and each device arrives at it
      // multiple times (the runtime coordinator clears arrival state once a
      // round's deviceCount is reached). This must NOT be flagged as
      // over-populating a single lock.
      const plan: Plan = {
        name: "Two-round barrier",
        devices: ["A", "B"],
        steps: [
          { tool: "observe", params: { device: "A" } },
          { tool: "barrier", params: { device: "A", lock: "sync1", deviceCount: 2 } },
          { tool: "tapOn", params: { device: "A", text: "Continue" } },
          { tool: "barrier", params: { device: "A", lock: "sync1", deviceCount: 2 } },
          { tool: "observe", params: { device: "B" } },
          { tool: "barrier", params: { device: "B", lock: "sync1", deviceCount: 2 } },
          { tool: "tapOn", params: { device: "B", text: "Continue" } },
          { tool: "barrier", params: { device: "B", lock: "sync1", deviceCount: 2 } },
        ],
      };
      expect(() => PlanValidator.validate(plan)).not.toThrow();
    });

    test("throws when a single round of a reused barrier lock has mismatched deviceCount", () => {
      const plan: Plan = {
        name: "Two-round barrier with one bad round",
        devices: ["A", "B"],
        steps: [
          // Round 1: consistent.
          { tool: "barrier", params: { device: "A", lock: "sync1", deviceCount: 2 } },
          { tool: "barrier", params: { device: "B", lock: "sync1", deviceCount: 2 } },
          // Round 2: device B disagrees on deviceCount.
          { tool: "barrier", params: { device: "A", lock: "sync1", deviceCount: 2 } },
          { tool: "barrier", params: { device: "B", lock: "sync1", deviceCount: 3 } },
        ],
      };
      expect(() => PlanValidator.validate(plan)).toThrow(ActionableError);
      expect(() => PlanValidator.validate(plan)).toThrow(
        'barrier lock "sync1" round 2 has inconsistent deviceCount values',
      );
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
