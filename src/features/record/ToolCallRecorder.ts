import { INTERNAL_TOOL_PARAM_NAMES } from "../../daemon/constants";
import { PlanStep } from "../../models/Plan";
import { logger } from "../../utils/logger";
import type { SwipeAtRecordingContext } from "../../models/SwipeAtOptions";
import { normalizedAxis } from "./normalizedAxis";
import { isInternalStepParam } from "../../constants/internalStepParams";
import { redactToolSecrets, TOOL_SECRET_PLACEHOLDER } from "../../utils/redactToolSecrets";

/** The registry-declared tool traits the recorder reads (structural subset of `ToolTraits`). */
export interface RecorderToolTraits {
  /** Writes caller-supplied files, from a host `sourcePath` or inline content. */
  stagesFiles?: boolean;
  /** A successful call is recorded as a plan step (declared on the tool, #11825). */
  planRelevant?: boolean;
}

/** Whether the tool declares the `planRelevant` trait, so its successful calls are plan steps. */
function isPlanRelevant(traits: RecorderToolTraits | undefined): boolean {
  return traits?.planRelevant === true;
}

/**
 * Params that reference observation state which cannot outlive the recording
 * session. `tapAt`, `swipeAt` and `dragPath` `snapshotId`s are short-lived observe
 * snapshotReferences that replay rejects as "unknown or evicted"
 * (SnapshotReferenceStore). tapAny, tapOn, swipeOn, dragAndDrop and pinchOn
 * declare no such param.
 */
const SESSION_SCOPED_PARAMS: Readonly<Record<string, readonly string[]>> = {
  tapAt: ["snapshotId"],
  swipeAt: ["snapshotId"],
  dragPath: ["snapshotId"],
};

export function stripSessionScopedParams(
  toolName: string,
  params: Record<string, unknown>,
): Record<string, unknown> {
  const scoped = SESSION_SCOPED_PARAMS[toolName];
  if (!scoped) {
    return params;
  }
  return Object.fromEntries(Object.entries(params).filter(([key]) => !scoped.includes(key)));
}

/** `action` values of multi-action tools that only read state. */
const READ_ONLY_ACTIONS: Readonly<Record<string, ReadonlySet<string>>> = {
  keyboard: new Set(["detect", "listProfiles", "listImes"]),
  clipboard: new Set(["get"]),
  systemTray: new Set(["list", "find"]),
};

/**
 * `action` values that only read state unless the call also waits (`waitFor`): a wait
 * holds a replayed plan until the device reaches a state, so it is a step (#14117).
 */
const READ_ONLY_ACTIONS_UNLESS_WAITING: Readonly<Record<string, ReadonlySet<string>>> = {
  mediaSession: new Set(["get"]),
};

/**
 * Tools that read current values unless one of these set fields is present:
 * displayConfig changes a value only with a set field, accessibility reports
 * the TalkBack/VoiceOver state when neither toggle is given.
 */
const READ_UNLESS_SET_FIELDS: Readonly<Record<string, readonly string[]>> = {
  displayConfig: [
    "fontScale",
    "contentSize",
    "density",
    "theme",
    "size",
    "navigationMode",
    "displayCutout",
    "increaseContrast",
    "reduceMotion",
    "boldText",
    "colorInversion",
    "colorCorrection",
    "magnification",
    "magnificationScale",
    "extraDim",
    "reset",
  ],
  accessibility: ["talkback", "voiceover"],
};

/** True when a recorded call only queried state, so replaying it adds nothing. */
export function isReadOnlyCall(toolName: string, params: Record<string, unknown>): boolean {
  const setFields = READ_UNLESS_SET_FIELDS[toolName];
  if (setFields) {
    return setFields.every((field) => params[field] === undefined);
  }
  const readUnlessWaiting = READ_ONLY_ACTIONS_UNLESS_WAITING[toolName];
  if (readUnlessWaiting) {
    return (
      params.waitFor === undefined &&
      typeof params.action === "string" &&
      readUnlessWaiting.has(params.action)
    );
  }
  const readOnly = READ_ONLY_ACTIONS[toolName];
  return readOnly !== undefined && typeof params.action === "string" && readOnly.has(params.action);
}

/**
 * Destructive-confirmation guards on recorded tools, by tool name. `resetKeychain`
 * is the only recorded tool whose input schema carries one (the other
 * confirmation-style params, `killDevice.force` and `deleteDevice.force`, belong
 * to excluded device-management tools). PlanExecutor re-injects `sessionUuid`
 * at replay, which satisfies the tool's explicit-device-target guard, so a
 * recorded `confirm: true` would make a replay wipe the iOS Simulator Keychain
 * of every app with no prompt. The recorder therefore writes the guard as
 * `false`: the step still parses (the schema requires the field) and the tool
 * refuses with its own "Set confirm: true to proceed" error until the plan's
 * author flips it by hand.
 */
const DESTRUCTIVE_CONFIRM_PARAMS: Readonly<Record<string, readonly string[]>> = {
  resetKeychain: ["confirm"],
};

/** Replace each destructive-confirmation param of the tool with `false`. */
export function withholdDestructiveConfirmations(
  toolName: string,
  params: Record<string, unknown>,
): Record<string, unknown> {
  const guards = DESTRUCTIVE_CONFIRM_PARAMS[toolName];
  if (!guards) {
    return params;
  }
  return { ...params, ...Object.fromEntries(guards.map((guard) => [guard, false])) };
}

/**
 * Largest single param, JSON-encoded, that a recording keeps. A recorded step is
 * stored in the plan and the whole plan comes back inline in the `recordToolCalls`
 * end response, so this matches the 64 KiB inline response budget
 * (`DEFAULT_OBSERVATION_INLINE_MAX_BYTES`, not imported to avoid pulling the
 * response finalizer into the recorder). Larger inline fixtures are skipped
 * with a warning.
 */
export const MAX_RECORDED_PARAM_BYTES = 64 * 1024;

/** Name of the first param whose JSON encoding exceeds the cap, if any. */
function findOversizedParam(params: Record<string, unknown>): string | undefined {
  return Object.keys(params).find(
    (key) => Buffer.byteLength(JSON.stringify(params[key]) ?? "") > MAX_RECORDED_PARAM_BYTES,
  );
}

function hasSourcePath(entry: unknown): boolean {
  return typeof entry === "object" && entry !== null && "sourcePath" in entry;
}

/**
 * True when a file-staging call copies a host file (`sourcePath`). The path is
 * resolved against the daemon's launch directory, so it does not exist on
 * another host or checkout and a replay would fail; `contentText` and
 * `contentBase64` are self-contained and are recorded. Covers both the
 * canonical `files[]` shape and the legacy single-file putAppFile shape.
 */
export function referencesHostFile(
  traits: RecorderToolTraits | undefined,
  params: Record<string, unknown>,
): boolean {
  if (traits?.stagesFiles !== true) {
    return false;
  }
  return hasSourcePath(params) || (Array.isArray(params.files) && params.files.some(hasSourcePath));
}

/**
 * Internal routing params injected by ToolRegistry.registerDeviceAware() that
 * should not appear in recorded PlanStep params.
 *
 * Keep in sync with the params injected in src/server/toolRegistry.ts
 * (search for "args.deviceId", "args.sessionUuid", "args.platform", etc.)
 */
export const INTERNAL_PARAMS = new Set([
  "platform",
  "deviceId",
  "sessionUuid",
  "device",
  "devices",
  "keepScreenAwake",
  ...INTERNAL_TOOL_PARAM_NAMES,
  "__lockNamespace",
]);

export function stripInternalParams(args: Record<string, unknown>): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (!INTERNAL_PARAMS.has(key) && !isInternalStepParam(key)) {
      clean[key] = value;
    }
  }
  return clean;
}

/**
 * Records successful MCP tool calls as PlanStep entries.
 * Designed to be wired into ToolRegistry's wrappedHandler success path.
 */
export class ToolCallRecorder {
  private steps: PlanStep[] = [];
  private warnings: string[] = [];
  private recording = false;

  start(): void {
    this.steps = [];
    this.warnings = [];
    this.recording = true;
    logger.info("[ToolCallRecorder] Recording started");
  }

  stop(): PlanStep[] {
    return this.stopWithWarnings().steps;
  }

  /**
   * Stop recording and return the steps with a warning per call that was skipped
   * or recorded in a weakened form, so the caller can tell the user what a
   * replay of the plan will not do.
   */
  stopWithWarnings(): { steps: PlanStep[]; warnings: string[] } {
    this.recording = false;
    const result = { steps: [...this.steps], warnings: [...this.warnings] };
    this.steps = [];
    this.warnings = [];
    logger.info(
      `[ToolCallRecorder] Recording stopped with ${result.steps.length} steps and ${result.warnings.length} warnings`,
    );
    return result;
  }

  isRecording(): boolean {
    return this.recording;
  }

  get stepCount(): number {
    return this.steps.length;
  }

  record(toolName: string, args: Record<string, unknown>, traits?: RecorderToolTraits): void {
    if (!this.recording) {
      return;
    }
    if (!isPlanRelevant(traits)) {
      return;
    }

    const params = stripSessionScopedParams(toolName, stripInternalParams(args));
    if (isReadOnlyCall(toolName, params)) {
      return;
    }
    const skipReason = this.skipReason(params, traits);
    if (skipReason) {
      const warning = `${toolName} was not recorded (after ${this.steps.length} recorded steps): ${skipReason}`;
      logger.warn(`[ToolCallRecorder] ${warning}`);
      this.warnings.push(warning);
      return;
    }
    const recorded = this.withholdUnsafeParams(toolName, params);
    const context = args.__tapAtRecordingContext as
      | import("../../models/TapAtGeometry").TapAtPlanContext
      | undefined;
    const geometry = toolName === "tapAt" ? context?.recordedGeometry : undefined;
    if (toolName === "tapAt" && context && !geometry) {
      const warning =
        "tapAt was recorded without geometry: native geometry provenance is unavailable; observe with rotation metadata and record again to capture provenance";
      logger.warn(`[ToolCallRecorder] ${warning}`);
      this.warnings.push(warning);
    }
    const recordedParams = this.paramsToStore(toolName, recorded, args);
    if (geometry) {
      const nativeParams = { ...recorded };
      delete nativeParams.image;
      delete nativeParams.coordinateSpace;
      this.steps.push({
        tool: toolName,
        params: { ...nativeParams, x: geometry.x, y: geometry.y },
        geometry,
      });
    } else {
      this.steps.push({ tool: toolName, params: recordedParams });
    }
    logger.info(`[ToolCallRecorder] Recorded step ${this.steps.length}: ${toolName}`);
  }

  /** Withhold destructive confirmations and credentials, warning the author of each. */
  private withholdUnsafeParams(
    toolName: string,
    params: Record<string, unknown>,
  ): Record<string, unknown> {
    const confirmed = withholdDestructiveConfirmations(toolName, params);
    if (confirmed !== params) {
      this.warnings.push(
        `${toolName} was recorded with its destructive confirmation set to false: a replay stops at this step until you set confirm: true in the plan by hand`,
      );
    }
    const recorded = redactToolSecrets(toolName, confirmed);
    if (recorded !== confirmed) {
      this.warnings.push(
        `${toolName} was recorded with its credentials replaced by ${TOOL_SECRET_PLACEHOLDER}: set them in the plan by hand before a replay`,
      );
    }
    return recorded;
  }

  private paramsToStore(
    toolName: string,
    recorded: Record<string, unknown>,
    args: Record<string, unknown>,
  ): Record<string, unknown> {
    if (toolName !== "swipeAt") {
      return recorded;
    }
    return this.normalizeSwipeAt(
      recorded,
      args.__swipeAtRecordingContext as SwipeAtRecordingContext | undefined,
    );
  }

  /**
   * An absolute-coordinate swipeAt replays on the same pixels whatever the screen, so it is stored
   * as fractions of the screen it was recorded on (#12878). Without that screen the raw pixels stay
   * and the plan author is warned.
   */
  private normalizeSwipeAt(
    params: Record<string, unknown>,
    context: SwipeAtRecordingContext | undefined,
  ): Record<string, unknown> {
    const { from, to, coordinateSpace } = params as {
      from?: { x: number; y: number };
      to?: { x: number; y: number };
      coordinateSpace?: string;
    };
    if (!from || !to || (coordinateSpace ?? "absolute") !== "absolute") {
      return params;
    }
    const screen = context?.screenSize;
    if (!screen || !(screen.width > 0) || !(screen.height > 0)) {
      const warning =
        "swipeAt was recorded without geometry: its absolute pixel endpoints replay on the same pixels on any screen; use coordinateSpace normalized or record again on a single display";
      logger.warn(`[ToolCallRecorder] ${warning}`);
      this.warnings.push(warning);
      return params;
    }
    return {
      ...params,
      from: {
        x: normalizedAxis(from.x, screen.width),
        y: normalizedAxis(from.y, screen.height),
      },
      to: { x: normalizedAxis(to.x, screen.width), y: normalizedAxis(to.y, screen.height) },
      coordinateSpace: "normalized",
    };
  }

  private skipReason(
    params: Record<string, unknown>,
    traits?: RecorderToolTraits,
  ): string | undefined {
    if (referencesHostFile(traits, params)) {
      return "it copies a host file (sourcePath), which a replay on another host cannot resolve; use contentText or contentBase64 to record it";
    }
    const oversized = findOversizedParam(params);
    if (oversized) {
      return `param '${oversized}' is larger than ${MAX_RECORDED_PARAM_BYTES} bytes, which is too large to store in the plan`;
    }
    return undefined;
  }
}
