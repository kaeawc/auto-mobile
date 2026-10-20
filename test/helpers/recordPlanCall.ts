import type {
  RecorderToolTraits,
  ToolCallRecorder,
} from "../../src/features/record/ToolCallRecorder";

/**
 * Records `toolName` as the registry would for a tool that declares `planRelevant` (#11825); pass
 * `traits` for the other recorder-read traits such as `stagesFiles`.
 */
export function recordPlanCall(
  recorder: ToolCallRecorder,
  toolName: string,
  args: Record<string, unknown>,
  traits: RecorderToolTraits = {},
): void {
  recorder.record(toolName, args, { planRelevant: true, ...traits });
}
