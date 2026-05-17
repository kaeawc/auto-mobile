import { expect, describe, test } from "bun:test";
import { PlanValidator } from "../../src/utils/plan/PlanValidator";
import { Plan } from "../../src/models/Plan";
import { ActionableError } from "../../src/models";
import { YamlPlanSerializer } from "../../src/utils/plan/PlanSerializer";
import fs from "fs/promises";

describe("PlanValidator", () => {
  describe("validate", () => {
    test("should validate a simple single-device plan", () => {
      const plan: Plan = {
        name: "Simple Plan",
        steps: [
          { tool: "observe", params: {} },
          { tool: "tapOn", params: { text: "Login" } },
        ],
      };

      expect(() => PlanValidator.validate(plan)).not.toThrow();
    });

    test("should validate a multi-device plan with correct device labels", () => {
      const plan: Plan = {
        name: "Multi-Device Plan",
        devices: ["A", "B"],
        steps: [
          { tool: "observe", params: { device: "A" } },
          { tool: "tapOn", params: { text: "Login", device: "B" } },
          { tool: "observe", params: { device: "A" } },
        ],
      };

      expect(() => PlanValidator.validate(plan)).not.toThrow();
    });

    test("should validate a multi-device plan with device definitions", () => {
      const plan: Plan = {
        name: "Multi-Device Plan",
        devices: [
          { label: "A", platform: "ios", simulatorType: "iPhone 15 Pro" },
          { label: "B", platform: "ios", iosVersion: "17.5" },
        ],
        steps: [
          { tool: "observe", params: { device: "A" } },
          { tool: "tapOn", params: { text: "Login", device: "B" } },
          { tool: "observe", params: { device: "A" } },
        ],
      };

      expect(() => PlanValidator.validate(plan)).not.toThrow();
    });

    test("should validate per-device critical sections that share a lock", () => {
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
              steps: [
                { tool: "tapOn", params: { text: "Sync", device: "A" } },
              ],
            },
          },
          {
            tool: "criticalSection",
            params: {
              device: "B",
              lock: "sync1",
              deviceCount: 2,
              steps: [
                { tool: "observe", params: { device: "B" } },
              ],
            },
          },
          { tool: "observe", params: { device: "B" } },
        ],
      };

      expect(() => PlanValidator.validate(plan)).not.toThrow();
    });

    test("should throw when a criticalSection step is missing its own device label", () => {
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
              steps: [
                { tool: "tapOn", params: { text: "Sync", device: "A" } },
              ],
            },
          },
        ],
      };

      expect(() => PlanValidator.validate(plan)).toThrow(ActionableError);
      expect(() => PlanValidator.validate(plan)).toThrow(
        "missing 'device' parameter"
      );
      expect(() => PlanValidator.validate(plan)).toThrow(
        "step 1 (criticalSection)"
      );
    });

    test("should throw when devices array is empty", () => {
      const plan: Plan = {
        name: "Invalid Plan",
        devices: [],
        steps: [{ tool: "observe", params: {} }],
      };

      expect(() => PlanValidator.validate(plan)).toThrow(ActionableError);
      expect(() => PlanValidator.validate(plan)).toThrow(
        "devices' array cannot be empty"
      );
    });

    test("should throw when devices contains duplicates", () => {
      const plan: Plan = {
        name: "Invalid Plan",
        devices: ["A", "B", "A"],
        steps: [
          { tool: "observe", params: { device: "A" } },
          { tool: "observe", params: { device: "B" } },
        ],
      };

      expect(() => PlanValidator.validate(plan)).toThrow(ActionableError);
      expect(() => PlanValidator.validate(plan)).toThrow("duplicate labels");
    });

    test("should throw when devices mixes labels and objects", () => {
      const plan: Plan = {
        name: "Invalid Plan",
        devices: ["A", { label: "B", platform: "ios" }],
        steps: [
          { tool: "observe", params: { device: "A" } },
          { tool: "observe", params: { device: "B" } },
        ],
      };

      expect(() => PlanValidator.validate(plan)).toThrow(ActionableError);
      expect(() => PlanValidator.validate(plan)).toThrow("do not mix formats");
    });

    test("should throw when device labels contain non-strings", () => {
      const plan: Plan = {
        name: "Invalid Plan",
        devices: ["A", "" as any, "B"],
        steps: [
          { tool: "observe", params: { device: "A" } },
          { tool: "observe", params: { device: "B" } },
        ],
      };

      expect(() => PlanValidator.validate(plan)).toThrow(ActionableError);
      expect(() => PlanValidator.validate(plan)).toThrow(
        "Device labels must be non-empty strings"
      );
    });

    test("should throw when devices is declared but step is missing device label", () => {
      const plan: Plan = {
        name: "Invalid Plan",
        devices: ["A", "B"],
        steps: [
          { tool: "observe", params: { device: "A" } },
          { tool: "tapOn", params: { text: "Login" } }, // Missing device label
        ],
      };

      expect(() => PlanValidator.validate(plan)).toThrow(ActionableError);
      expect(() => PlanValidator.validate(plan)).toThrow(
        "missing 'device' parameter"
      );
      expect(() => PlanValidator.validate(plan)).toThrow("step 1 (tapOn)");
    });

    test("should throw when step uses undeclared device label", () => {
      const plan: Plan = {
        name: "Invalid Plan",
        devices: ["A", "B"],
        steps: [
          { tool: "observe", params: { device: "A" } },
          { tool: "tapOn", params: { text: "Login", device: "C" } }, // Undeclared device
        ],
      };

      expect(() => PlanValidator.validate(plan)).toThrow(ActionableError);
      expect(() => PlanValidator.validate(plan)).toThrow(
        "invalid device labels"
      );
      expect(() => PlanValidator.validate(plan)).toThrow('device="C"');
    });

    test("should throw when criticalSection steps sharing a lock disagree on deviceCount", () => {
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
      expect(() => PlanValidator.validate(plan)).toThrow(
        "inconsistent deviceCount values"
      );
    });

    test("should throw when criticalSection lock has fewer steps than deviceCount", () => {
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

      expect(() => PlanValidator.validate(plan)).toThrow(ActionableError);
      expect(() => PlanValidator.validate(plan)).toThrow(
        "declares deviceCount=2 but 1 step references it"
      );
    });

    test("should throw when the same device enters a criticalSection lock twice", () => {
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

      expect(() => PlanValidator.validate(plan)).toThrow(ActionableError);
      expect(() => PlanValidator.validate(plan)).toThrow(
        'entered twice by device "A"'
      );
    });

    test("should accept matched per-device criticalSection steps sharing a lock", () => {
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

    test("should throw when a criticalSection sub-step is missing device", () => {
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
                { tool: "inputText", params: { text: "hi" } }, // no device
              ],
            },
          },
        ],
      };

      expect(() => PlanValidator.validate(plan)).toThrow(ActionableError);
      expect(() => PlanValidator.validate(plan)).toThrow(
        "Every step inside a criticalSection must declare a 'device' parameter"
      );
      expect(() => PlanValidator.validate(plan)).toThrow(
        "step 1.steps[1] (inputText)"
      );
    });

    test("should throw when a criticalSection sub-step uses an undeclared device", () => {
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
                { tool: "observe", params: { device: "C" } }, // undeclared
              ],
            },
          },
        ],
      };

      expect(() => PlanValidator.validate(plan)).toThrow(ActionableError);
      expect(() => PlanValidator.validate(plan)).toThrow(
        "criticalSection sub-steps use invalid device labels"
      );
      expect(() => PlanValidator.validate(plan)).toThrow('device="C"');
    });

    test("should throw when plan name is missing", () => {
      const plan: Plan = {
        name: "",
        steps: [{ tool: "observe", params: {} }],
      };

      expect(() => PlanValidator.validate(plan)).toThrow(ActionableError);
      expect(() => PlanValidator.validate(plan)).toThrow(
        "Plan must have a valid name"
      );
    });

    test("should throw when steps array is missing", () => {
      const plan: any = {
        name: "Test Plan",
      };

      expect(() => PlanValidator.validate(plan)).toThrow(ActionableError);
      expect(() => PlanValidator.validate(plan)).toThrow(
        "Plan must have a steps array"
      );
    });
  });

  describe("hasMultiDeviceFeatures", () => {
    test("should return true when devices field is present", () => {
      const plan: Plan = {
        name: "Plan",
        devices: ["A"],
        steps: [{ tool: "observe", params: { device: "A" } }],
      };

      expect(PlanValidator.hasMultiDeviceFeatures(plan)).toBe(true);
    });

    test("should return true when any step uses device parameter", () => {
      const plan: Plan = {
        name: "Plan",
        steps: [
          { tool: "observe", params: {} },
          { tool: "tapOn", params: { device: "A" } },
        ],
      };

      expect(PlanValidator.hasMultiDeviceFeatures(plan)).toBe(true);
    });

    test("should return true when plan uses criticalSection", () => {
      const plan: Plan = {
        name: "Plan",
        steps: [
          { tool: "observe", params: {} },
          {
            tool: "criticalSection",
            params: {
              lock: "sync1",
              deviceCount: 2,
              steps: [],
            },
          },
        ],
      };

      expect(PlanValidator.hasMultiDeviceFeatures(plan)).toBe(true);
    });

    test("should return false for simple single-device plans", () => {
      const plan: Plan = {
        name: "Plan",
        steps: [
          { tool: "observe", params: {} },
          { tool: "tapOn", params: { text: "Login" } },
        ],
      };

      expect(PlanValidator.hasMultiDeviceFeatures(plan)).toBe(false);
    });
  });

  describe("validateMultiDeviceRequirements", () => {
    test("should pass when plan uses multi-device features and declares devices", () => {
      const plan: Plan = {
        name: "Plan",
        devices: ["A", "B"],
        steps: [
          { tool: "observe", params: { device: "A" } },
          { tool: "tapOn", params: { device: "B" } },
        ],
      };

      expect(() =>
        PlanValidator.validateMultiDeviceRequirements(plan)
      ).not.toThrow();
    });

    test("should throw when plan uses device labels but doesn't declare devices", () => {
      const plan: Plan = {
        name: "Plan",
        steps: [
          { tool: "observe", params: {} },
          { tool: "tapOn", params: { device: "A" } },
        ],
      };

      expect(() =>
        PlanValidator.validateMultiDeviceRequirements(plan)
      ).toThrow(ActionableError);
      expect(() =>
        PlanValidator.validateMultiDeviceRequirements(plan)
      ).toThrow("does not declare 'devices' field");
    });

    test("should throw when plan uses criticalSection but doesn't declare devices", () => {
      const plan: Plan = {
        name: "Plan",
        steps: [
          { tool: "observe", params: {} },
          {
            tool: "criticalSection",
            params: {
              lock: "sync1",
              deviceCount: 2,
              steps: [],
            },
          },
        ],
      };

      expect(() =>
        PlanValidator.validateMultiDeviceRequirements(plan)
      ).toThrow(ActionableError);
      expect(() =>
        PlanValidator.validateMultiDeviceRequirements(plan)
      ).toThrow("does not declare 'devices' field");
    });

    test("should pass for simple single-device plans without devices field", () => {
      const plan: Plan = {
        name: "Plan",
        steps: [
          { tool: "observe", params: {} },
          { tool: "tapOn", params: { text: "Login" } },
        ],
      };

      expect(() =>
        PlanValidator.validateMultiDeviceRequirements(plan)
      ).not.toThrow();
    });
  });

  describe("YAML anchors and merge keys", () => {
    test("should correctly parse and validate YAML with anchors and merge keys", async () => {
      const yamlContent = await fs.readFile(
        "test/resources/test-plans/yaml-anchors-test.yaml",
        "utf-8"
      );

      const serializer = new YamlPlanSerializer();
      const plan = serializer.importPlanFromYaml(yamlContent);

      // Verify the plan was parsed correctly
      expect(plan.name).toBe("YAML Anchors and Merge Keys Test Plan");
      expect(plan.devices).toEqual(["A", "B"]);
      expect(plan.steps.length).toBe(5);

      // Verify anchor merge worked - first launchApp should have merged params
      expect(plan.steps[0].tool).toBe("launchApp");
      expect(plan.steps[0].params?.appId).toBe("com.example.app");
      expect(plan.steps[0].params?.coldBoot).toBe(false);
      expect(plan.steps[0].params?.device).toBe("A");

      // Verify anchor merge with override - second launchApp should override coldBoot
      expect(plan.steps[1].tool).toBe("launchApp");
      expect(plan.steps[1].params?.appId).toBe("com.example.app");
      expect(plan.steps[1].params?.coldBoot).toBe(true);
      expect(plan.steps[1].params?.device).toBe("B");

      // Verify observe steps merged anchor params
      expect(plan.steps[2].tool).toBe("observe");
      expect(plan.steps[2].params?.includeScreenshot).toBe(true);
      expect(plan.steps[2].params?.includeHierarchy).toBe(true);
      expect(plan.steps[2].params?.device).toBe("A");

      // Verify criticalSection targets a specific device, like any other step
      expect(plan.steps[3].tool).toBe("criticalSection");
      expect(plan.steps[3].params?.lock).toBe("sync-point");
      expect(plan.steps[3].params?.deviceCount).toBe(1);
      expect(plan.steps[3].params?.device).toBe("A");

      // Verify plan passes all validation
      expect(() => PlanValidator.validate(plan)).not.toThrow();
      expect(() => PlanValidator.validateMultiDeviceRequirements(plan)).not.toThrow();
    });
  });
});
