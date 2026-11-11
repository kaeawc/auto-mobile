import * as yaml from "js-yaml";
import { Plan } from "../models";
import type { PlanTopLevelPlatform } from "../models/Plan";
import { logger } from "../utils/logger";
import { getMcpServerVersion, releaseVersion } from "../utils/mcpVersion";
import { PlanValidator } from "../utils/plan/PlanValidator";
import { ToolCallRecorder } from "../features/record/ToolCallRecorder";
import { defaultTimer, type Timer } from "../utils/SystemTimer";

export interface ToolCallRecordingStartResult {
  recording: boolean;
  startedAt: string;
  alreadyActive?: boolean;
  currentStepCount?: number;
  /** The name the plan will be exported under, when begin was given one. */
  planName?: string;
}

export interface ToolCallRecordingStopResult {
  planName: string;
  planContent: string;
  stepCount: number;
  durationMs: number;
  startedAt: string;
  stoppedAt: string;
  /** One entry per call that was skipped or recorded in a weakened form; empty when none. */
  warnings: string[];
  /** The platform written at the top of the plan, when every recorded call targeted it. */
  platform?: PlanTopLevelPlatform;
  /** Why the plan has no top-level platform; absent when `platform` is set. */
  platformNote?: string;
}

export interface ToolCallRecordingStatus {
  recording: boolean;
  startedAt: string;
  stepCount: number;
  durationMs: number;
}

interface ToolCallRecordingSession {
  recorder: ToolCallRecorder;
  startedAt: number;
  /** The planName given to begin; the exported plan's name when end names none (#17950). */
  planName?: string;
}

export interface ToolCallRecordingOptions {
  connectionId?: string;
  timer?: Timer;
}

// A symbol keeps anonymous callers together without colliding with a transport id.
const DEFAULT_CONNECTION_KEY = Symbol("anonymous MCP connection");
const activeSessions = new Map<string | symbol, ToolCallRecordingSession>();

/** Reset module state — test-only. */
export function resetToolCallRecordingState(): void {
  activeSessions.clear();
}

export function getToolCallRecorder({
  connectionId,
}: ToolCallRecordingOptions = {}): ToolCallRecorder | null {
  return activeSessions.get(connectionId ?? DEFAULT_CONNECTION_KEY)?.recorder ?? null;
}

export function getToolCallRecordingStatus({
  connectionId,
  timer = defaultTimer,
}: ToolCallRecordingOptions = {}): ToolCallRecordingStatus | null {
  const activeSession = activeSessions.get(connectionId ?? DEFAULT_CONNECTION_KEY);
  if (!activeSession) {
    return null;
  }
  return {
    recording: activeSession.recorder.isRecording(),
    startedAt: new Date(activeSession.startedAt).toISOString(),
    stepCount: activeSession.recorder.stepCount,
    durationMs: timer.now() - activeSession.startedAt,
  };
}

export function startToolCallRecording({
  connectionId,
  planName,
  timer = defaultTimer,
}: ToolCallRecordingOptions & { planName?: string } = {}): ToolCallRecordingStartResult {
  const connectionKey = connectionId ?? DEFAULT_CONNECTION_KEY;
  const activeSession = activeSessions.get(connectionKey);
  if (activeSession) {
    logger.info("[ToolCallRecording] Recording already active, returning existing session");
    return {
      recording: true,
      startedAt: new Date(activeSession.startedAt).toISOString(),
      alreadyActive: true,
      currentStepCount: activeSession.recorder.stepCount,
      ...(activeSession.planName && { planName: activeSession.planName }),
    };
  }

  const recorder = new ToolCallRecorder();
  recorder.start();

  const session: ToolCallRecordingSession = {
    recorder,
    startedAt: timer.now(),
    ...(planName?.trim() && { planName: planName.trim() }),
  };
  activeSessions.set(connectionKey, session);

  logger.info("[ToolCallRecording] Started tool call recording");

  return {
    recording: true,
    startedAt: new Date(session.startedAt).toISOString(),
    ...(session.planName && { planName: session.planName }),
  };
}

const formatPlanName = (planName?: string, timer: Timer = defaultTimer): string => {
  if (planName && planName.trim().length > 0) {
    return planName.trim();
  }
  const timestamp = new Date(timer.now()).toISOString().replace(/[:.]/g, "-");
  return `mcp-recorded-plan-${timestamp}`;
};

const PLAN_TOP_LEVEL_PLATFORMS: ReadonlySet<string> = new Set([
  "android",
  "ios",
  "tvos",
  "visionos",
  "watchos",
]);

function isPlanTopLevelPlatform(value: string): value is PlanTopLevelPlatform {
  return PLAN_TOP_LEVEL_PLATFORMS.has(value);
}

/**
 * The platform a recorded plan declares: the one every recorded call targeted, so the plan
 * runs as exported (#17938). Mixed or unknown platforms leave it out, with the reason.
 */
export function resolveRecordedPlanPlatform(
  stepPlatforms: readonly (string | undefined)[],
): { platform: PlanTopLevelPlatform } | { platformNote: string } {
  const unknownCount = stepPlatforms.filter((platform) => platform === undefined).length;
  const distinct = [...new Set(stepPlatforms.filter((p): p is string => p !== undefined))];
  const omitted = "The plan has no top-level platform";
  const remedy = "add platform to the plan, or pass platform to executePlan";
  if (unknownCount > 0) {
    return {
      platformNote: `${omitted}: ${unknownCount} of ${stepPlatforms.length} recorded call(s) had no known platform; ${remedy}.`,
    };
  }
  if (distinct.length > 1) {
    return {
      platformNote: `${omitted}: the recorded calls targeted more than one platform (${distinct.join(", ")}); ${remedy}.`,
    };
  }
  const [only] = distinct;
  if (only === undefined || !isPlanTopLevelPlatform(only)) {
    return {
      platformNote: `${omitted}: ${only ?? "no platform"} is not a plan platform (android, ios, tvos, visionos or watchos); ${remedy}.`,
    };
  }
  return { platform: only };
}

export function stopToolCallRecording({
  connectionId,
  planName,
  timer = defaultTimer,
}: ToolCallRecordingOptions & { planName?: string } = {}): ToolCallRecordingStopResult {
  const connectionKey = connectionId ?? DEFAULT_CONNECTION_KEY;
  const session = activeSessions.get(connectionKey);
  if (!session) {
    throw new Error(
      "No active tool call recording on this MCP connection. " +
        'Call recordToolCalls with action: "begin" first. ' +
        "Recordings are scoped to the MCP connection that began them, so a separate " +
        "connection (such as a one-shot CLI call) cannot end another connection's recording.",
    );
  }
  // A planName given to end wins; otherwise the one given to begin names the plan (#17950).
  planName = planName?.trim() ? planName : session.planName;

  try {
    const { steps, warnings, stepPlatforms } = session.recorder.stopWithWarnings();
    const stoppedAt = timer.now();
    const resolvedName = formatPlanName(planName, timer);

    if (steps.length === 0) {
      const skipped =
        warnings.length > 0
          ? ` ${warnings.length} call(s) were skipped: ${warnings.join("; ")}.`
          : " Ensure plan-relevant tools were called during the recording.";
      throw new Error(
        `No MCP tool calls were recorded.${skipped} ` +
          'Call recordToolCalls with action: "begin" to start a new session.',
      );
    }

    const platformResolution = resolveRecordedPlanPlatform(stepPlatforms);
    const plan: Plan = {
      name: resolvedName,
      ...("platform" in platformResolution && { platform: platformResolution.platform }),
      steps,
      // Release portion only — recorded plans are schema-validated (`^\d+\.\d+\.\d+$`)
      // before migration, so a dev build's `+g<sha>` stamp would make them unusable.
      mcpVersion: releaseVersion(getMcpServerVersion()),
      metadata: {
        createdAt: new Date(stoppedAt).toISOString(),
        version: "1.0.0",
        generatedFromToolCalls: true,
        recording: {
          startedAt: new Date(session.startedAt).toISOString(),
          stoppedAt: new Date(stoppedAt).toISOString(),
          durationMs: stoppedAt - session.startedAt,
          interactionCount: steps.length,
        },
      },
    };

    PlanValidator.validate(plan);

    const planContent = yaml.dump(plan, {
      indent: 2,
      lineWidth: -1,
      noRefs: true,
    });

    logger.info(`[ToolCallRecording] Stopped recording with ${steps.length} steps`);

    return {
      planName: resolvedName,
      planContent,
      stepCount: steps.length,
      durationMs: stoppedAt - session.startedAt,
      startedAt: new Date(session.startedAt).toISOString(),
      stoppedAt: new Date(stoppedAt).toISOString(),
      warnings,
      ...platformResolution,
    };
  } finally {
    activeSessions.delete(connectionKey);
  }
}

/** Discard an MCP connection's recording on disconnect, without producing a plan. */
export function dropToolCallRecording(connectionId?: string): void {
  const connectionKey = connectionId ?? DEFAULT_CONNECTION_KEY;
  activeSessions.get(connectionKey)?.recorder.stop();
  activeSessions.delete(connectionKey);
}
