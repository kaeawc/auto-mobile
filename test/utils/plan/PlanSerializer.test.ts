import { describe, expect, test } from "bun:test";
import fs from "fs/promises";
import * as yaml from "js-yaml";
import os from "os";
import path from "path";
import { YamlPlanSerializer } from "../../../src/utils/plan/PlanSerializer";
import type { Plan } from "../../../src/models/Plan";

/**
 * Tests for PlanSerializer focusing on the pure importPlanFromYaml logic.
 *
 * exportPlanFromLogs is not tested here because it requires filesystem access
 * (reading log directories and writing output files) without injectable dependencies.
 */
describe("YamlPlanSerializer", () => {
  const serializer = new YamlPlanSerializer();

  describe("exportPlanFromLogs", () => {
    test("preserves step-level optional flag when present in logged tool calls", async () => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "plan-serializer-"));
      const outputPath = path.join(tempDir, "exported.yaml");
      try {
        await fs.writeFile(
          path.join(tempDir, "tool-calls.json"),
          JSON.stringify({
            timestamp: "2026-07-09T00:00:00.000Z",
            tool: "tapOn",
            params: { text: "Not Now" },
            optional: true,
            result: { success: true },
          }) + "\n",
          "utf-8",
        );

        const result = await serializer.exportPlanFromLogs(tempDir, "Optional Export", outputPath);

        expect(result.success).toBe(true);
        const exported = yaml.load(result.planContent ?? "") as Plan;
        expect(exported.steps[0]).toMatchObject({
          tool: "tapOn",
          params: { text: "Not Now" },
          optional: true,
        });
        expect(exported.steps[0].params.optional).toBeUndefined();
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe("importPlanFromYaml", () => {
    test("imports a valid plan with name and steps", () => {
      const yamlContent = yaml.dump({
        name: "My Plan",
        description: "A test plan",
        mcpVersion: "1.0.0",
        metadata: {
          createdAt: "2024-01-01T00:00:00.000Z",
          version: "1.0.0",
        },
        steps: [
          { tool: "tapOn", params: { text: "Hello" } },
          { tool: "inputText", params: { text: "World" } },
        ],
      });

      const plan = serializer.importPlanFromYaml(yamlContent);

      expect(plan.name).toBe("My Plan");
      expect(plan.description).toBe("A test plan");
      expect(plan.steps).toHaveLength(2);
      expect(plan.steps[0].tool).toBe("tapOn");
      // Migration adds action: "tap" to tapOn steps and wraps legacy top-level
      // `text` under `selector` for the v0.0.30 tapOn schema.
      expect(plan.steps[0].params).toEqual({ selector: { text: "Hello" }, action: "tap" });
      expect(plan.steps[1].tool).toBe("inputText");
      expect(plan.steps[1].params).toEqual({ text: "World" });
    });

    test("imports a minimal valid plan", () => {
      const yamlContent = yaml.dump({
        name: "Minimal",
        steps: [{ tool: "observe", params: {} }],
      });

      const plan = serializer.importPlanFromYaml(yamlContent);

      expect(plan.name).toBe("Minimal");
      expect(plan.steps).toHaveLength(1);
      expect(plan.steps[0].tool).toBe("observe");
    });

    test("applies migration for legacy planName field", () => {
      const yamlContent = yaml.dump({
        planName: "Legacy Plan",
        steps: [{ tool: "tapOn", params: { text: "Go" } }],
      });

      const plan = serializer.importPlanFromYaml(yamlContent);

      expect(plan.name).toBe("Legacy Plan");
    });

    test("normalizes legacy command field to tool", () => {
      const yamlContent = yaml.dump({
        name: "Command Plan",
        mcpVersion: "1.0.0",
        metadata: {
          createdAt: "2024-01-01T00:00:00.000Z",
          version: "1.0.0",
        },
        steps: [{ command: "tapOn", params: { text: "Hello" } }],
      });

      const plan = serializer.importPlanFromYaml(yamlContent);

      expect(plan.steps[0].tool).toBe("tapOn");
    });

    test("normalizes inline step parameters into params object", () => {
      const yamlContent = yaml.dump({
        name: "Inline Params",
        mcpVersion: "1.0.0",
        metadata: {
          createdAt: "2024-01-01T00:00:00.000Z",
          version: "1.0.0",
        },
        steps: [{ tool: "tapOn", text: "Button", action: "tap" }],
      });

      const plan = serializer.importPlanFromYaml(yamlContent);

      // Migration wraps legacy top-level `text` under `selector` for the
      // v0.0.30 tapOn schema.
      expect(plan.steps[0].params).toEqual({ selector: { text: "Button" }, action: "tap" });
    });

    test("sets default description when not provided", () => {
      const yamlContent = yaml.dump({
        name: "No Desc",
        mcpVersion: "1.0.0",
        metadata: {
          createdAt: "2024-01-01T00:00:00.000Z",
          version: "1.0.0",
        },
        steps: [
          { tool: "tapOn", params: { text: "A" } },
          { tool: "tapOn", params: { text: "B" } },
        ],
      });

      const plan = serializer.importPlanFromYaml(yamlContent);

      expect(plan.description).toBe("Plan with 2 steps");
    });

    test("preserves metadata when provided", () => {
      const yamlContent = yaml.dump({
        name: "With Metadata",
        mcpVersion: "1.0.0",
        metadata: {
          createdAt: "2024-06-15T12:00:00.000Z",
          version: "2.0.0",
        },
        steps: [{ tool: "observe", params: {} }],
      });

      const plan = serializer.importPlanFromYaml(yamlContent);

      expect(plan.metadata!.createdAt).toBe("2024-06-15T12:00:00.000Z");
      expect(plan.metadata!.version).toBe("2.0.0");
    });

    test("throws for invalid YAML syntax", () => {
      const badYaml = "name: Test\nsteps:\n  - tool: tapOn\n    params: {invalid: [}";

      expect(() => serializer.importPlanFromYaml(badYaml)).toThrow("Failed to parse plan YAML");
    });

    test("throws when name is missing", () => {
      const yamlContent = yaml.dump({
        steps: [{ tool: "tapOn", params: { text: "Go" } }],
      });

      // After migration, name defaults are tried; without any name source it should fail
      expect(() => serializer.importPlanFromYaml(yamlContent)).toThrow();
    });

    test("throws when steps is missing", () => {
      const yamlContent = yaml.dump({
        name: "No Steps Plan",
      });

      expect(() => serializer.importPlanFromYaml(yamlContent)).toThrow();
    });

    test("throws when steps is not an array", () => {
      const yamlContent = yaml.dump({
        name: "Bad Steps",
        steps: "not an array",
      });

      expect(() => serializer.importPlanFromYaml(yamlContent)).toThrow();
    });

    test("roundtrips plan through YAML serialization and deserialization", () => {
      const originalPlan: Plan = {
        name: "Roundtrip Plan",
        description: "Test roundtrip",
        mcpVersion: "1.0.0",
        metadata: {
          createdAt: "2024-01-01T00:00:00.000Z",
          version: "1.0.0",
        },
        steps: [
          // Use v0.0.30 selector shape so the round-trip is meaningful — the
          // importer auto-migrates legacy { text: "..." } to { selector: { text: "..." } },
          // which would otherwise make the round-trip non-identity.
          { tool: "tapOn", params: { selector: { text: "Login" }, action: "tap" } },
          { tool: "inputText", params: { text: "user@example.com" } },
          { tool: "pressButton", params: { button: "enter" } },
        ],
      };

      const yamlContent = yaml.dump(originalPlan, {
        indent: 2,
        lineWidth: -1,
        noRefs: true,
      });

      const reimported = serializer.importPlanFromYaml(yamlContent);

      expect(reimported.name).toBe(originalPlan.name);
      expect(reimported.description).toBe(originalPlan.description);
      expect(reimported.steps).toHaveLength(originalPlan.steps.length);
      for (let i = 0; i < originalPlan.steps.length; i++) {
        expect(reimported.steps[i].tool).toBe(originalPlan.steps[i].tool);
        expect(reimported.steps[i].params).toEqual(originalPlan.steps[i].params);
      }
    });

    test("handles plan with devices field", () => {
      const yamlContent = yaml.dump({
        name: "Multi Device Plan",
        mcpVersion: "1.0.0",
        metadata: {
          createdAt: "2024-01-01T00:00:00.000Z",
          version: "1.0.0",
        },
        devices: ["A", "B"],
        steps: [
          { tool: "tapOn", params: { text: "Hello", device: "A" } },
          { tool: "tapOn", params: { text: "World", device: "B" } },
        ],
      });

      const plan = serializer.importPlanFromYaml(yamlContent);

      expect(plan.devices).toEqual(["A", "B"]);
      expect(plan.steps[0].params.device).toBe("A");
      expect(plan.steps[1].params.device).toBe("B");
    });

    test("handles plan with step labels", () => {
      const yamlContent = yaml.dump({
        name: "Labeled Plan",
        mcpVersion: "1.0.0",
        metadata: {
          createdAt: "2024-01-01T00:00:00.000Z",
          version: "1.0.0",
        },
        steps: [{ tool: "tapOn", params: { text: "Login" }, label: "Click login button" }],
      });

      const plan = serializer.importPlanFromYaml(yamlContent);

      expect(plan.steps[0].label).toBe("Click login button");
    });

    test("throws for completely non-object input", () => {
      const yamlContent = "just a string";

      expect(() => serializer.importPlanFromYaml(yamlContent)).toThrow();
    });

    test("preserves step-level optional flag through migration + normalization (#2853)", () => {
      // Regression: importPlanFromYaml runs migratePlan() before PlanNormalizer. `optional` must
      // stay at the step level and NOT be swept into tool params, or a best-effort step becomes
      // mandatory and the executor never skips it.
      const yamlContent = yaml.dump({
        name: "Optional Plan",
        steps: [
          { tool: "tapOn", text: "Not Now", optional: true },
          { tool: "observe", params: { waitFor: { text: "x" } }, optional: true },
          { tool: "terminateApp", appId: "com.example.app" },
        ],
      });

      const plan = serializer.importPlanFromYaml(yamlContent);

      expect(plan.steps[0].optional).toBe(true);
      expect(plan.steps[1].optional).toBe(true);
      expect(plan.steps[2].optional).toBeUndefined();
      // The flag must not leak into tool params (strict tool schemas would reject it).
      expect(plan.steps[0].params.optional).toBeUndefined();
      expect(plan.steps[1].params.optional).toBeUndefined();
    });
  });
});
