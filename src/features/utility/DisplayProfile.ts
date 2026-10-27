import { ActionableError, toActionableError } from "../../models/ActionableError";
import type { BootedDevice } from "../../models";
import {
  readAndroidDeviceApiLevel,
  type ApiLevelProbeExecutor,
} from "../../utils/android-cmdline-tools/readAndroidDeviceApiLevel";
import { outputLooksLikeShellFailure } from "../../utils/android-cmdline-tools/shellOutputHeuristics";
import { isAndroidEmulatorSerial } from "../../utils/androidSerial";
import { shellQuote } from "../../utils/shellQuote";
import { throwIfAborted } from "../../utils/toolUtils";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import type { RequestedPosture } from "../device/postureCommands";
import type {
  DensityInput,
  DisplayConfigResult,
  FontScaleInput,
  SetDisplayConfigInput,
} from "./DisplayConfig";
import {
  defaultDisplayProfileRestoreRegistry,
  type DisplayProfileFacet,
  type DisplayProfileRestoreAction,
  type DisplayProfileRestoreRegistry,
} from "./DisplayProfileRestore";

/** `cmd overlay enable-exclusive --category`, nav-mode overlays and force dark are API 29+. */
const API_OVERLAY_CATEGORY = 29;
const API_FORCE_DARK = 29;

export const CUTOUT_EMULATIONS = ["none", "corner", "double", "hole", "tall", "waterfall"] as const;
export type CutoutEmulation = (typeof CUTOUT_EMULATIONS)[number];

export const NAVIGATION_MODES = ["gestural", "threebutton", "twobutton"] as const;
export type NavigationMode = (typeof NAVIGATION_MODES)[number];

export const CUTOUT_OVERLAY_PREFIX = "com.android.internal.display.cutout.emulation.";
export const NAVIGATION_OVERLAY_PREFIX = "com.android.internal.systemui.navbar.";
const FORCE_DARK_PROPERTY = "debug.hwui.force_dark";

/** One display profile: every field is optional; omitted facets are left alone. */
export interface DisplayProfileInput {
  /** `wm size WxH`, or `default` for `wm size reset`. Approximates One UI "Screen zoom" with density. */
  screenSize?: string;
  density?: DensityInput;
  fontScale?: number;
  cutout?: CutoutEmulation;
  navigationMode?: NavigationMode;
  /** true: `setprop debug.hwui.force_dark true` plus night mode, as Samsung and Xiaomi force dark. */
  forceDark?: boolean;
  posture?: RequestedPosture;
}

export type DisplayProfileStepStatus = "applied" | "partial" | "unsupported" | "failed";

export interface DisplayProfileStepResult {
  step: DisplayProfileFacet;
  status: DisplayProfileStepStatus;
  /** What the step wrote, or why it could not. */
  detail?: string;
}

/** `applied`: every step applied; `partial`: some did, or did in part; `unsupported`: none could. */
export type DisplayProfileOutcome = "applied" | "partial" | "unsupported";

export interface DisplayProfileResult {
  message: string;
  deviceId: string;
  action: "apply" | "reset";
  status: DisplayProfileOutcome;
  steps: DisplayProfileStepResult[];
  /** apply: present while a facet is waiting to be restored by reset or session release. */
  restore?: { facets: DisplayProfileFacet[]; onSessionRelease: boolean };
}

/** The `DisplayConfig` surface the display facet composes, so tests need not model its parsing. */
export interface DisplayConfigPort {
  setConfig(input: SetDisplayConfigInput): Promise<DisplayConfigResult>;
}

/** Posture read and write, composed from `setPosture`. */
export interface PostureControl {
  /** The current posture, or undefined when the device cannot report one. */
  read(signal?: AbortSignal): Promise<RequestedPosture | undefined>;
  set(
    posture: RequestedPosture,
    signal?: AbortSignal,
  ): Promise<{ status: "applied" | "unsupported"; detail?: string }>;
}

export interface DisplayProfilePorts {
  shell: ApiLevelProbeExecutor;
  displayConfig: DisplayConfigPort;
  posture: PostureControl;
}

export interface DisplayProfileDependencies extends DisplayProfilePorts {
  registry?: DisplayProfileRestoreRegistry;
  /** The daemon session applying, whose release then restores the device. */
  owner?: string;
  signal?: AbortSignal;
}

interface Context {
  device: BootedDevice;
  deps: DisplayProfileDependencies;
  registry: DisplayProfileRestoreRegistry;
  apiLevel: number | null;
}

async function shellRun(
  shell: ApiLevelProbeExecutor,
  command: string,
  signal: AbortSignal | undefined,
): Promise<string> {
  throwIfAborted(signal);
  const result = await shell.executeCommand(command, { noRetry: true, signal });
  const stderr = result.stderr ?? "";
  if (outputLooksLikeShellFailure(result.stdout, stderr)) {
    throw new ActionableError(`'${command}' failed: ${`${result.stdout}\n${stderr}`.trim()}`);
  }
  return result.stdout;
}

function run(context: Context, command: string): Promise<string> {
  return shellRun(context.deps.shell, command, context.deps.signal);
}

async function runAll(context: Context, commands: readonly string[]): Promise<void> {
  for (const command of commands) {
    await run(context, command);
  }
}

function belowApi(context: Context, minApi: number): DisplayProfileStepResult["detail"] {
  return context.apiLevel !== null && context.apiLevel < minApi
    ? `needs API ${minApi}+, device is API ${context.apiLevel}`
    : undefined;
}

/** The size `wm size` reports as an override, or undefined when the physical size is in effect. */
export function parseWmSizeOverride(stdout: string): string | undefined {
  return stdout.match(/Override size:\s*(\d+x\d+)/)?.[1];
}

/** Overlay packages `cmd overlay list` shows, with whether each is enabled (`[x]`). */
export function parseOverlayList(stdout: string): { name: string; enabled: boolean }[] {
  return [...stdout.matchAll(/^\s*\[(x| )\]\s+(\S+)/gm)].map((match) => ({
    name: match[2],
    enabled: match[1] === "x",
  }));
}

/** Record before the write, so a release that races it restores; drop it if the write broke. */
async function writeRecorded(
  context: Context,
  restore: DisplayProfileRestoreAction,
  write: () => Promise<void>,
): Promise<void> {
  const recordedNow = context.registry.record(context.device, restore, context.deps.owner);
  try {
    await write();
  } catch (error) {
    if (recordedNow) {
      context.registry.forget(context.device.deviceId, restore.facet);
    }
    throw error;
  }
}

async function applyScreenSize(context: Context, size: string): Promise<DisplayProfileStepResult> {
  const override = parseWmSizeOverride(await run(context, "shell wm size"));
  const restore = override ? `shell wm size ${override}` : "shell wm size reset";
  const command = size === "default" ? "shell wm size reset" : `shell wm size ${size}`;
  await writeRecorded(context, { facet: "screenSize", commands: [restore] }, () =>
    runAll(context, [command]),
  );
  // An OEM shell may clamp or ignore a size override on a physical device.
  return isAndroidEmulatorSerial(context.device.deviceId)
    ? { step: "screenSize", status: "applied", detail: command }
    : {
        step: "screenSize",
        status: "partial",
        detail: `${command} (physical device: best effort)`,
      };
}

function displayInput(input: DisplayProfileInput): SetDisplayConfigInput {
  return {
    ...(input.fontScale !== undefined ? { fontScale: input.fontScale } : {}),
    ...(input.density !== undefined ? { density: input.density } : {}),
    ...(input.forceDark === true ? { theme: "dark" as const } : {}),
  };
}

/** The `previous` values of exactly the fields this call set, in the form `setConfig` takes back. */
function previousOf(
  result: DisplayConfigResult,
  changed: SetDisplayConfigInput,
): SetDisplayConfigInput {
  const previous = result.previous ?? {};
  const fontScale: FontScaleInput | undefined = previous.fontScale;
  return {
    ...(changed.fontScale !== undefined && fontScale !== undefined ? { fontScale } : {}),
    ...(changed.density !== undefined && previous.density !== undefined
      ? { density: previous.density }
      : {}),
    ...(changed.theme !== undefined && previous.theme !== undefined
      ? { theme: previous.theme }
      : {}),
  };
}

async function applyDisplay(
  context: Context,
  input: SetDisplayConfigInput,
): Promise<DisplayProfileStepResult> {
  const result = await context.deps.displayConfig.setConfig(input);
  const previous = previousOf(result, input);
  if (Object.keys(previous).length > 0) {
    // DisplayConfig reads the previous values itself; record them even when a later field failed.
    context.registry.record(
      context.device,
      { facet: "display", values: previous },
      context.deps.owner,
    );
  }
  const fields = Object.keys(input).join(", ");
  if (!result.success) {
    return {
      step: "display",
      status: "failed",
      detail: result.error ?? `displayConfig ${fields} failed`,
    };
  }
  const partial = input.density !== undefined && result.supported.density === "partial";
  return {
    step: "display",
    status: partial ? "partial" : "applied",
    detail: partial
      ? `displayConfig ${fields} (density is best effort on this device)`
      : `displayConfig ${fields}`,
  };
}

async function applyOverlayCategory(
  context: Context,
  facet: "cutout" | "navigationMode",
  prefix: string,
  value: string | undefined,
): Promise<DisplayProfileStepResult> {
  const gated = belowApi(context, API_OVERLAY_CATEGORY);
  if (gated) {
    return { step: facet, status: "unsupported", detail: gated };
  }
  const overlays = parseOverlayList(await run(context, "shell cmd overlay list android"));
  const target = value === undefined ? undefined : `${prefix}${value}`;
  if (target && !overlays.some((overlay) => overlay.name === target)) {
    return {
      step: facet,
      status: "unsupported",
      detail: `overlay ${target} is not on this system image`,
    };
  }
  const enabled = overlays.filter((overlay) => overlay.name.startsWith(prefix) && overlay.enabled);
  const restore = enabled[0]
    ? [`shell cmd overlay enable-exclusive --category ${enabled[0].name}`]
    : target
      ? [`shell cmd overlay disable ${target}`]
      : [];
  const commands = target
    ? [`shell cmd overlay enable-exclusive --category ${target}`]
    : enabled.map((overlay) => `shell cmd overlay disable ${overlay.name}`);
  await writeRecorded(context, { facet, commands: restore }, () => runAll(context, commands));
  return { step: facet, status: "applied", detail: commands.join("; ") || "already none" };
}

async function applyForceDark(context: Context, on: boolean): Promise<DisplayProfileStepResult> {
  const gated = belowApi(context, API_FORCE_DARK);
  if (gated) {
    return { step: "forceDark", status: "unsupported", detail: gated };
  }
  const previous = (await run(context, `shell getprop ${FORCE_DARK_PROPERTY}`)).trim();
  const command = `shell setprop ${FORCE_DARK_PROPERTY} ${on}`;
  await writeRecorded(
    context,
    {
      facet: "forceDark",
      commands: [`shell setprop ${FORCE_DARK_PROPERTY} ${shellQuote(previous)}`],
    },
    () => runAll(context, [command]),
  );
  return {
    step: "forceDark",
    status: "applied",
    detail: `${command}; applies to activities started afterwards, so relaunch the app`,
  };
}

async function applyPosture(
  context: Context,
  posture: RequestedPosture,
): Promise<DisplayProfileStepResult> {
  const previous = await context.deps.posture.read(context.deps.signal);
  const result = await context.deps.posture.set(posture, context.deps.signal);
  if (result.status === "unsupported") {
    return { step: "posture", status: "unsupported", detail: result.detail };
  }
  if (previous === undefined) {
    return {
      step: "posture",
      status: "partial",
      detail: `posture ${posture} set, but the previous posture was unreadable, so reset cannot restore it`,
    };
  }
  context.registry.record(
    context.device,
    { facet: "posture", posture: previous },
    context.deps.owner,
  );
  return { step: "posture", status: "applied", detail: `posture ${posture}` };
}

type StepRunner = () => Promise<DisplayProfileStepResult>;

function overlayValue(cutout: CutoutEmulation): string | undefined {
  return cutout === "none" ? undefined : cutout;
}

/** The steps a profile asks for, in apply order. */
function stepRunners(
  context: Context,
  input: DisplayProfileInput,
): [DisplayProfileFacet, StepRunner][] {
  const runners: [DisplayProfileFacet, StepRunner][] = [];
  const { screenSize, cutout, navigationMode, forceDark, posture } = input;
  const display = displayInput(input);
  if (screenSize !== undefined) {
    runners.push(["screenSize", () => applyScreenSize(context, screenSize)]);
  }
  if (Object.keys(display).length > 0) {
    runners.push(["display", () => applyDisplay(context, display)]);
  }
  if (cutout !== undefined) {
    runners.push([
      "cutout",
      () => applyOverlayCategory(context, "cutout", CUTOUT_OVERLAY_PREFIX, overlayValue(cutout)),
    ]);
  }
  if (navigationMode !== undefined) {
    runners.push([
      "navigationMode",
      () =>
        applyOverlayCategory(context, "navigationMode", NAVIGATION_OVERLAY_PREFIX, navigationMode),
    ]);
  }
  if (forceDark !== undefined) {
    runners.push(["forceDark", () => applyForceDark(context, forceDark)]);
  }
  if (posture !== undefined) {
    runners.push(["posture", () => applyPosture(context, posture)]);
  }
  return runners;
}

async function runStep(
  facet: DisplayProfileFacet,
  runner: StepRunner,
): Promise<DisplayProfileStepResult> {
  try {
    return await runner();
  } catch (error) {
    // Best effort per facet: a broken step is reported and the rest still run.
    logger.warn(`displayProfile ${facet} step failed: ${errorMessage(error)}`, error);
    return {
      step: facet,
      status: "failed",
      detail: toActionableError(error, `${facet} failed`).message,
    };
  }
}

function validateInput(input: DisplayProfileInput): void {
  const size = input.screenSize;
  if (size !== undefined && size !== "default" && !/^\d+x\d+$/.test(size)) {
    throw new ActionableError(
      `screenSize must be WIDTHxHEIGHT (e.g. 1080x2400) or default, not '${size}'.`,
    );
  }
}

function outcomeOf(steps: readonly DisplayProfileStepResult[]): DisplayProfileOutcome {
  if (steps.every((step) => step.status === "applied")) {
    return "applied";
  }
  return steps.some((step) => step.status === "applied" || step.status === "partial")
    ? "partial"
    : "unsupported";
}

function describe(steps: readonly DisplayProfileStepResult[]): string {
  return steps.map((step) => `${step.step}: ${step.detail ?? step.status}`).join("; ");
}

async function contextFor(
  device: BootedDevice,
  deps: DisplayProfileDependencies,
): Promise<Context> {
  if (device.platform !== "android") {
    throw new ActionableError(
      `displayProfile is Android-only; ${device.deviceId} is ${device.platform}. Use displayConfig and setPosture on iOS.`,
    );
  }
  const apiLevel = await readAndroidDeviceApiLevel(deps.shell, undefined, undefined, deps.signal);
  return {
    device,
    deps,
    registry: deps.registry ?? defaultDisplayProfileRestoreRegistry,
    apiLevel,
  };
}

/**
 * Apply an OEM-style display profile in one call (#14052): screen size, density
 * and font scale, cutout and navigation-mode overlays, force dark and fold
 * posture, composing `displayConfig` and `setPosture` rather than duplicating
 * them. Each facet's state before the first change is recorded once, so reset
 * restores it however many profiles were applied since.
 */
export async function applyDisplayProfile(
  device: BootedDevice,
  input: DisplayProfileInput,
  deps: DisplayProfileDependencies,
): Promise<DisplayProfileResult> {
  validateInput(input);
  const context = await contextFor(device, deps);
  const runners = stepRunners(context, input);
  if (runners.length === 0) {
    throw new ActionableError("displayProfile apply needs at least one display field.");
  }
  const steps: DisplayProfileStepResult[] = [];
  for (const [facet, runner] of runners) {
    steps.push(await runStep(facet, runner));
  }
  const changedSomething = steps.some(
    (step) => step.status === "applied" || step.status === "partial",
  );
  if (!changedSomething && steps.some((step) => step.status === "failed")) {
    throw new ActionableError(
      `displayProfile changed nothing on ${device.deviceId}: ${describe(steps)}`,
    );
  }
  const facets = context.registry.pending(device.deviceId).map((action) => action.facet);
  const status = outcomeOf(steps);
  return {
    message: `Applied display profile to ${device.deviceId} (${status}): ${describe(steps)}`,
    deviceId: device.deviceId,
    action: "apply",
    status,
    steps,
    ...(facets.length > 0
      ? {
          restore: {
            facets,
            onSessionRelease: context.registry.restoresOnRelease(device.deviceId),
          },
        }
      : {}),
  };
}

/** Write one recorded facet back. Throws when the device refuses. */
export async function restoreDisplayProfileAction(
  ports: DisplayProfilePorts,
  action: DisplayProfileRestoreAction,
  signal?: AbortSignal,
): Promise<void> {
  switch (action.facet) {
    case "display": {
      const result = await ports.displayConfig.setConfig(action.values);
      if (!result.success) {
        throw new ActionableError(result.error ?? "displayConfig restore failed");
      }
      return;
    }
    case "posture": {
      const result = await ports.posture.set(action.posture, signal);
      if (result.status !== "applied") {
        throw new ActionableError(
          result.detail ?? `posture ${action.posture} could not be restored`,
        );
      }
      return;
    }
    default:
      for (const command of action.commands) {
        await shellRun(ports.shell, command, signal);
      }
  }
}

/**
 * Restore every facet display profiles changed on the device, latest first, then
 * forget it (#14052). Idempotent: a second reset finds nothing and changes nothing.
 * A facet the device refuses stays recorded for a later reset or the session's release.
 */
export async function resetDisplayProfile(
  device: BootedDevice,
  deps: DisplayProfileDependencies,
): Promise<DisplayProfileResult> {
  const context = await contextFor(device, deps);
  const steps: DisplayProfileStepResult[] = [];
  for (const action of context.registry.pending(device.deviceId)) {
    try {
      await restoreDisplayProfileAction(deps, action, deps.signal);
      context.registry.forget(device.deviceId, action.facet);
      steps.push({ step: action.facet, status: "applied" });
    } catch (error) {
      logger.warn(
        `displayProfile restore of ${action.facet} failed: ${errorMessage(error)}`,
        error,
      );
      steps.push({
        step: action.facet,
        status: "failed",
        detail: toActionableError(error, `restore ${action.facet} failed`).message,
      });
    }
  }
  const failed = steps.filter((step) => step.status === "failed");
  if (failed.length > 0) {
    throw new ActionableError(
      `displayProfile reset on ${device.deviceId} failed: ${describe(failed)}`,
    );
  }
  return {
    message:
      steps.length === 0
        ? `No displayProfile change is recorded on ${device.deviceId}; nothing was changed.`
        : `Restored ${steps.map((step) => step.step).join(", ")} on ${device.deviceId}`,
    deviceId: device.deviceId,
    action: "reset",
    status: "applied",
    steps,
  };
}
