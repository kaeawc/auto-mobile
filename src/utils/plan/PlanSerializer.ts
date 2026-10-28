import * as yaml from "js-yaml";
import { Plan, PlanStep } from "../../models/Plan";
import { logger } from "../logger";
import { PlanNormalizer } from "./PlanNormalizer";
import { redactPlanObjectTypedText } from "../redactTypedTextArguments";
import { migratePlan, type PlanMigrationOptions } from "./PlanMigrator";
import { PlanValidator } from "./PlanValidator";
import { PLAN_YAML_LOAD_OPTIONS } from "./planYaml";

/**
 * Interface for plan serialization/deserialization
 * Handles YAML import of plans
 */
export interface PlanSerializer {
  /**
   * Import a plan from YAML content
   * @param yamlContent YAML string containing plan definition
   * @returns Parsed Plan object
   * @throws Error if YAML is invalid or plan structure is incorrect
   */
  importPlanFromYaml(yamlContent: string, options?: PlanMigrationOptions): Plan;
}

const migrateYamlPlan = (rawPlan: unknown, options?: PlanMigrationOptions) =>
  migratePlan(rawPlan, options);

/**
 * YAML-based plan serialization implementation
 * Provides YAML import for Plan objects
 */
export class YamlPlanSerializer implements PlanSerializer {
  /**
   * Import a plan from YAML content
   * @param yamlContent YAML string containing plan definition
   * @returns Parsed Plan object
   * @throws Error if YAML is invalid or plan structure is incorrect
   */
  importPlanFromYaml(yamlContent: string, options?: PlanMigrationOptions): Plan {
    try {
      logger.info("=== Starting importPlanFromYaml ===");
      logger.info(`Parsing YAML content (${yamlContent.length} characters)`);

      let rawPlan: any;
      try {
        rawPlan = yaml.load(yamlContent, PLAN_YAML_LOAD_OPTIONS) as any;
        logger.info("Raw plan loaded successfully");
      } catch (yamlError) {
        throw new Error(`YAML parsing failed: ${yamlError}`);
      }

      logger.info("Raw plan loaded:", JSON.stringify(redactPlanObjectTypedText(rawPlan), null, 2));

      const { plan: migratedPlan, report } = migrateYamlPlan(rawPlan, options);

      // Handle both legacy and new field names
      const planName = migratedPlan.name;
      const steps = migratedPlan.steps;

      // Validate basic structure
      if (!planName || !steps || !Array.isArray(steps)) {
        throw new Error("Invalid plan structure: missing name or steps");
      }

      if (report.migrated) {
        const applied =
          report.appliedMigrations.length > 0 ? report.appliedMigrations.join(", ") : "none";
        logger.info(
          `[PLAN_MIGRATION] Plan '${planName}' migrated (${report.originalVersion} -> ${report.targetVersion}). Applied: ${applied}`,
        );
      }

      if (report.warnings.length > 0) {
        report.warnings.forEach((warning) => {
          const location = warning.stepIndex !== undefined ? `step ${warning.stepIndex}` : "plan";
          logger.warn(`[PLAN_MIGRATION] ${location}: ${warning.message}`);
        });
      }

      logger.info(`Processing ${steps.length} steps`);

      // Normalize steps - convert 'command' to 'tool' if needed
      let normalizedSteps: PlanStep[];
      try {
        normalizedSteps = PlanNormalizer.normalizeSteps(steps);
      } catch (stepError) {
        throw new Error(`Step processing failed: ${stepError}`);
      }

      logger.info("=== Plan creation ===");

      const plan: Plan = {
        name: planName,
        description: migratedPlan.description || `Plan with ${normalizedSteps.length} steps`,
        devices: migratedPlan.devices,
        steps: normalizedSteps,
        mcpVersion: migratedPlan.mcpVersion,
        metadata: migratedPlan.metadata || {
          createdAt: new Date().toISOString(),
          version: "1.0.0",
        },
      };

      // Validate plan structure
      logger.info("Validating plan structure");
      PlanValidator.validate(plan);
      PlanValidator.validateMultiDeviceRequirements(plan);

      return plan;
    } catch (error) {
      throw new Error(`Failed to parse plan YAML: ${error}`);
    }
  }
}
