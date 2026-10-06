import { PlanStep } from "../../models/Plan";
import { logger } from "../logger";

/**
 * Internal helper for normalizing plan steps
 * Converts legacy formats to current PlanStep structure
 */
export class PlanNormalizer {
  private static isRecord(value: unknown): value is Record<string, any> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  /**
   * Pure, log-free core of {@link normalizeStep}: the tool name (`tool`, else the legacy
   * `command`) and the merged params (inline step fields, overridden by an explicit `params`
   * object). Returns undefined when the step is not an object or names no tool, so callers that
   * must never throw (e.g. the request-deadline resolver) can reuse the exact merge rule.
   */
  static toolAndParams(step: unknown): { tool: string; params: Record<string, any> } | undefined {
    if (!PlanNormalizer.isRecord(step)) {
      return undefined;
    }
    const toolName = step.tool || step.command;
    if (!toolName || typeof toolName !== "string") {
      return undefined;
    }
    const inlineParams: Record<string, any> = {};
    Object.keys(step).forEach((key) => {
      if (
        key !== "tool" &&
        key !== "command" &&
        key !== "label" &&
        key !== "params" &&
        key !== "optional"
      ) {
        inlineParams[key] = step[key];
      }
    });
    const paramsFromStep = PlanNormalizer.isRecord(step.params) ? step.params : {};
    // Prefer explicit params over inline fields.
    return { tool: toolName, params: { ...inlineParams, ...paramsFromStep } };
  }

  /**
   * Normalize a raw step object into a PlanStep
   * Handles conversion of 'command' to 'tool' and moves parameters into params object
   * @param step Raw step data from YAML
   * @param index Step index for error messages
   * @returns Normalized PlanStep
   */
  static normalizeStep(step: any, index: number): PlanStep {
    logger.debug(`Processing step ${index}:`, JSON.stringify(step, null, 2));

    const parts = PlanNormalizer.toolAndParams(step);
    if (!parts) {
      throw new Error(`Invalid step at index ${index}: missing or invalid tool/command name`);
    }
    const toolName = parts.tool;

    const normalizedStep: PlanStep = {
      tool: toolName,
      params: parts.params,
    };

    if (typeof step.label === "string") {
      normalizedStep.label = step.label;
    }

    if (step.optional === true) {
      normalizedStep.optional = true;
    }

    logger.info(`Normalized step ${index}: ${toolName}`);
    logger.debug(`Normalized step ${index}:`, JSON.stringify(normalizedStep, null, 2));
    return normalizedStep;
  }

  /**
   * Normalize an array of steps
   * @param steps Raw steps array from YAML
   * @returns Array of normalized PlanSteps
   */
  static normalizeSteps(steps: any[]): PlanStep[] {
    return steps.map((step, index) => this.normalizeStep(step, index));
  }
}
