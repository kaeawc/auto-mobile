import type {
  RecorderToolTraits,
  ToolCallRecorder,
} from "../../src/features/record/ToolCallRecorder";
import type { ToolCallRecordingContext } from "../../src/features/toolSelection/toolSelectionContext";

/**
 * Records `toolName` as the registry would for a tool that declares `planRelevant` (#11825); pass
 * `traits` for the other recorder-read traits such as `stagesFiles`, and `recording` for what the
 * handler resolved (a tapAt's geometry, a swipeAt's screen).
 */
export function recordPlanCall(
  recorder: ToolCallRecorder,
  toolName: string,
  args: Record<string, unknown>,
  traits: RecorderToolTraits = {},
  recording?: ToolCallRecordingContext,
): void {
  recorder.record(toolName, args, { planRelevant: true, ...traits }, recording);
}
