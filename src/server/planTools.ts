import { z } from "zod";
import { ToolRegistry } from "./toolRegistry";
import { BootedDevice, ExecutePlanResult } from "../models";
import { importPlanFromYaml, executePlan } from "../utils/planUtils";
import { logger } from "../utils/logger";
import { createJSONToolResponse } from "../utils/toolUtils";
import { Platform } from "../models";
import { createDebugFileWriter } from "../utils/debugFileWriter";

// Execute plan tool schema
const executePlanSchema = z.object({
  planContent: z.string().describe("YAML plan content to execute directly"),
  startStep: z.number().default(0).describe("Step index to start execution from (0-based). If not provided or negative, starts from step 0. Will error if beyond range."),
  platform: z.enum(["android", "ios"]).describe("Target platform")
});

// Execute plan from YAML file or content
const executePlanTool = async (device: BootedDevice, params: {
  planContent: string;
  startStep: number;
  platform: Platform
}): Promise<any> => {
  const debugWriter = createDebugFileWriter({ prefix: "executePlan" });
  const executionStartTime = Date.now();

  try {
    logger.info("=== Starting executePlanTool ===");

    debugWriter
      .addSection("EXECUTE PLAN - START")
      .addKeyValues({
        "Device Platform": device.platform,
        "Device ID": device.id,
        "Start Step": params.startStep,
        "Platform Param": params.platform
      });

    let yamlContent = params.planContent;
    const startStep = params.startStep;

    // Decode base64 if content is base64-encoded
    if (yamlContent.startsWith("base64:")) {
      logger.info("=== Decoding base64 plan content ===");
      const decodeStartTime = Date.now();

      debugWriter.addSubsection("Base64 Content Decoding");
      const base64Content = yamlContent.substring(7); // Remove "base64:" prefix

      debugWriter.addKeyValues({
        "Base64 Length": base64Content.length,
        "Base64 Prefix": base64Content.substring(0, 50) + "..."
      });

      yamlContent = Buffer.from(base64Content, "base64").toString("utf-8");
      logger.info("=== Base64 content decoded ===");

      const decodeTime = Date.now() - decodeStartTime;
      debugWriter
        .addTiming("Decode Time", decodeTime)
        .addKeyValues({
          "Decoded Length": yamlContent.length,
          "Decoded Content Preview": yamlContent.substring(0, 200) + "..."
        });
    }

    debugWriter.addSubsection("Raw YAML Content", yamlContent);

    // Parse the plan
    logger.info("=== Parsing plan from YAML ===");
    const parseStartTime = Date.now();

    const plan = importPlanFromYaml(yamlContent);
    logger.info("=== Plan parsed successfully ===");

    const parseTime = Date.now() - parseStartTime;
    debugWriter
      .addSubsection("Plan Parsing Result")
      .addTiming("Parse Time", parseTime)
      .addKeyValues({
        "Plan Name": plan.name,
        "Plan Description": plan.description,
        "Total Steps": plan.steps.length,
        "Plan Metadata": plan.metadata
      });

    // Log each step
    debugWriter.addSubsection("Plan Steps");
    plan.steps.forEach((step, index) => {
      debugWriter.addContent(`Step ${index + 1}: ${step.tool}`);
      debugWriter.addKeyValue("  Params", step.params);
    });

    logger.info(`Executing plan '${plan.name}' with ${plan.steps.length} steps on ${device.platform} platform`);

    // Execute the plan
    logger.info("=== Starting plan execution ===");
    const executionStepStartTime = Date.now();

    debugWriter.addSubsection("Plan Execution Start");

    const result = await executePlan(plan, startStep, params.platform);
    logger.info("=== Plan execution completed ===");

    const executionStepTime = Date.now() - executionStepStartTime;
    const totalExecutionTime = Date.now() - executionStartTime;

    debugWriter
      .addSubsection("Plan Execution Result")
      .addTiming("Execution Time", executionStepTime)
      .addTiming("Total Time", totalExecutionTime)
      .addKeyValues({
        "Success": result.success,
        "Executed Steps": result.executedSteps,
        "Total Steps": result.totalSteps,
        "Failed Step": result.failedStep ? {
          stepIndex: result.failedStep.stepIndex,
          tool: result.failedStep.tool,
          error: result.failedStep.error
        } : "None"
      });

    const response: ExecutePlanResult = {
      success: result.success,
      executedSteps: result.executedSteps,
      totalSteps: result.totalSteps,
      failedStep: result.failedStep,
      error: result.failedStep ? result.failedStep.error : undefined,
      platform: device.platform
    };

    logger.info("=== Creating JSON response ===");
    const jsonResponse = createJSONToolResponse(response);
    logger.info("=== Returning from executePlanTool ===");

    debugWriter
      .addSubsection("Final Response")
      .addContent(JSON.stringify(response, null, 2))
      .addSection("EXECUTE PLAN - COMPLETED SUCCESSFULLY");

    await debugWriter.write();
    logger.info(`Debug log written to: ${debugWriter.getFilePath()}`);

    return jsonResponse;
  } catch (error) {
    logger.info("=== Failed to execute plan ===");

    const totalExecutionTime = Date.now() - executionStartTime;

    debugWriter
      .addSubsection("Plan Execution Failed")
      .addTiming("Total Time", totalExecutionTime)
      .addError(error instanceof Error ? error : String(error));

    const response: ExecutePlanResult = {
      success: false,
      executedSteps: 0,
      totalSteps: 0,
      error: `${error}`,
      platform: device.platform
    };
    const jsonResponse = createJSONToolResponse(response);
    logger.info("=== Returning error from executePlanTool ===");

    debugWriter
      .addSubsection("Error Response")
      .addContent(JSON.stringify(response, null, 2))
      .addSection("EXECUTE PLAN - FAILED");

    await debugWriter.write();
    logger.info(`Debug log written to: ${debugWriter.getFilePath()}`);

    return jsonResponse;
  }
};

// Register plan tools. Note that only AutoMobile CLI includes this since we do not execute plans in MCP mode.
export const registerPlanTools = () => {
  ToolRegistry.registerDeviceAware(
    "executePlan",
    "Execute a series of tool calls from a YAML plan content. Stops execution if any step fails (success: false). Optionally can resume execution from a specific step index.",
    executePlanSchema,
    executePlanTool
  );
};
