import { ActionableError, toActionableError } from "../../models/ActionableError";
import type { BootedDevice } from "../../models";
import { readAndroidDeviceApiLevel } from "../../utils/android-cmdline-tools/readAndroidDeviceApiLevel";
import { outputLooksLikeShellFailure } from "../../utils/android-cmdline-tools/shellOutputHeuristics";
import { shellQuote } from "../../utils/shellQuote";
import { throwIfAborted } from "../../utils/toolUtils";
import {
  KILL_PROFILES,
  type KillProfile,
  type KillProfileAppOp,
  type KillProfileId,
  type KillProfileStep,
} from "./KillProfiles";
import {
  defaultKillProfileRestoreRegistry,
  type KillProfileRestoreAction,
  type KillProfileRestoreRegistry,
  type KillProfileShell,
} from "./KillProfileRestore";

/** `am set-standby-bucket` / `get-standby-bucket` need API 28; the restricted bucket API 30. */
const API_STANDBY_BUCKET = 28;
const API_RESTRICTED_BUCKET = 30;
/** RUN_ANY_IN_BACKGROUND (the op behind isBackgroundRestricted) is API 28+. */
const API_RUN_ANY_IN_BACKGROUND = 28;
const API_SCHEDULE_EXACT_ALARM = 31;
const API_DEVICE_IDLE = 23;

const ACTIVE_BUCKET = "10";

/** App ops set per uid rather than per package (as `SetAndroidScheduleExactAlarmAppOp` does). */
export const UID_MODE_OPS: ReadonlySet<KillProfileAppOp> = new Set(["SCHEDULE_EXACT_ALARM"]);

const APP_OP_MIN_API: Readonly<Record<KillProfileAppOp, number>> = {
  RUN_ANY_IN_BACKGROUND: API_RUN_ANY_IN_BACKGROUND,
  SCHEDULE_EXACT_ALARM: API_SCHEDULE_EXACT_ALARM,
};

const APP_OP_MODE = /\b(allow|ignore|deny|default|foreground)\b/;

export type KillProfileStepStatus = "applied" | "unsupported" | "failed";

export interface KillProfileStepResult {
  step: string;
  command: string;
  status: KillProfileStepStatus;
  reason?: string;
}

/** `applied`: every step ran; `partial`: some did; `unsupported`: none could on this device. */
export type KillProfileOutcome = "applied" | "partial" | "unsupported";

export interface KillProfileRestoreReceipt {
  /** The commands reset (or session release) runs, in order. */
  commands: string[];
  /** True when a daemon session owns the record and its release runs the commands. */
  onSessionRelease: boolean;
}

export interface ApplyKillProfileResult {
  message: string;
  deviceId: string;
  appId: string;
  action: "apply";
  profile: Pick<KillProfile, "id" | "version" | "evidenceStatus" | "evidenceNote" | "source">;
  status: KillProfileOutcome;
  steps: KillProfileStepResult[];
  /** Present while a facet this or an earlier call changed is waiting to be restored. */
  restore?: KillProfileRestoreReceipt;
}

export interface ResetKillProfileResult {
  message: string;
  deviceId: string;
  appId: string;
  action: "reset";
  /** `recorded`: restored what apply recorded; `baseline`: wrote AOSP defaults; `none`: nothing to do. */
  source: "recorded" | "baseline" | "none";
  status: KillProfileOutcome;
  steps: KillProfileStepResult[];
}

export interface KillProfileDependencies {
  shell: KillProfileShell;
  registry?: KillProfileRestoreRegistry;
  /** The daemon session applying, whose release then restores the device. */
  owner?: string;
  signal?: AbortSignal;
}

/** One step resolved against a package: its command and how to capture what it changes. */
interface StepPlan {
  label: string;
  command: string;
  minApi?: number;
  /** Reads the facet before the write and returns how to restore it. */
  capture?: () => Promise<KillProfileRestoreAction>;
  /** Output that means the device cannot do this, not that the command broke. */
  unsupportedOutput?: RegExp;
}

interface Context {
  device: BootedDevice;
  appId: string;
  quoted: string;
  deps: KillProfileDependencies;
}

async function run(context: Context, command: string): Promise<{ stdout: string; stderr: string }> {
  throwIfAborted(context.deps.signal);
  const result = await context.deps.shell.executeCommand(command, {
    noRetry: true,
    signal: context.deps.signal,
  });
  return { stdout: result.stdout, stderr: result.stderr ?? "" };
}

function appOpCommand(context: Context, verb: "get" | "set", op: KillProfileAppOp): string {
  const uid = UID_MODE_OPS.has(op) ? "--uid " : "";
  return `shell appops ${verb} ${uid}${context.quoted} ${op}`;
}

/**
 * The mode an `appops get` line reports for `op`. Package-mode ops read the
 * package line (not the `Uid mode:` line); uid-mode ops read the uid line. No
 * line ("No operations.") means the op is at its default.
 */
export function parseAppOpMode(stdout: string, op: KillProfileAppOp): string {
  const lines = stdout.split("\n").map((line) => line.trim());
  const wanted = UID_MODE_OPS.has(op)
    ? lines.find((line) => line.startsWith(`Uid mode: ${op}:`))
    : lines.find((line) => line.startsWith(`${op}:`));
  const mode = wanted?.slice(wanted.indexOf(`${op}:`) + op.length + 1).match(APP_OP_MODE)?.[1];
  return mode ?? "default";
}

/** The numeric bucket `am get-standby-bucket <pkg>` prints, or undefined when it printed none. */
export function parseStandbyBucket(stdout: string): string | undefined {
  return stdout.match(/^\s*(\d+)\s*$/m)?.[1];
}

function batteryPlan(context: Context): StepPlan {
  return {
    label: "battery unplug",
    command: "shell dumpsys battery unplug",
    capture: async () => {
      const { stdout } = await run(context, "shell dumpsys battery");
      // Already overridden by hand: leave the override for whoever made it.
      const overridden = /UPDATES STOPPED/i.test(stdout);
      return { key: "battery", command: overridden ? null : "shell dumpsys battery reset" };
    },
  };
}

function standbyBucketPlan(context: Context, bucket: "restricted" | "rare"): StepPlan {
  return {
    label: `standby bucket ${bucket}`,
    command: `shell am set-standby-bucket ${context.quoted} ${bucket}`,
    minApi: bucket === "restricted" ? API_RESTRICTED_BUCKET : API_STANDBY_BUCKET,
    capture: async () => {
      const { stdout } = await run(context, `shell am get-standby-bucket ${context.quoted}`);
      // An unreadable bucket is restored to active, the bucket of an app in use.
      const original = parseStandbyBucket(stdout) ?? ACTIVE_BUCKET;
      return {
        key: `standbyBucket:${context.appId}`,
        appId: context.appId,
        command: `shell am set-standby-bucket ${context.quoted} ${original}`,
      };
    },
  };
}

function appOpPlan(context: Context, op: KillProfileAppOp, mode: "ignore" | "deny"): StepPlan {
  return {
    label: `appops ${op} ${mode}`,
    command: `${appOpCommand(context, "set", op)} ${mode}`,
    minApi: APP_OP_MIN_API[op],
    unsupportedOutput: /Unknown operation string/i,
    capture: async () => {
      const { stdout } = await run(context, appOpCommand(context, "get", op));
      return {
        key: `appOp:${op}:${context.appId}`,
        appId: context.appId,
        command: `${appOpCommand(context, "set", op)} ${parseAppOpMode(stdout, op)}`,
      };
    },
  };
}

function planStep(context: Context, step: KillProfileStep): StepPlan {
  switch (step.kind) {
    case "batteryUnplug":
      return batteryPlan(context);
    case "standbyBucket":
      return standbyBucketPlan(context, step.bucket);
    case "appOp":
      return appOpPlan(context, step.op, step.mode);
    case "forceIdle":
      return {
        label: "deviceidle force-idle",
        command: "shell dumpsys deviceidle force-idle",
        minApi: API_DEVICE_IDLE,
        // Doze disabled, or the device still charging.
        unsupportedOutput: /Unable to go (deep )?idle/i,
        capture: async () => ({ key: "deviceIdle", command: "shell dumpsys deviceidle unforce" }),
      };
    case "home":
      return { label: "home", command: "shell input keyevent KEYCODE_HOME" };
    case "kill":
      return step.mode === "soft"
        ? { label: "am kill", command: `shell am kill ${context.quoted}` }
        : { label: "am force-stop", command: `shell am force-stop ${context.quoted}` };
  }
}

function apiGateReason(plan: StepPlan, apiLevel: number | null): string | undefined {
  if (plan.minApi === undefined || apiLevel === null || apiLevel >= plan.minApi) {
    return undefined;
  }
  return `needs API ${plan.minApi}+, device is API ${apiLevel}`;
}

function outputFailure(
  plan: StepPlan,
  output: { stdout: string; stderr: string },
): Pick<KillProfileStepResult, "status" | "reason"> | undefined {
  const text = `${output.stdout}\n${output.stderr}`.trim();
  if (plan.unsupportedOutput?.test(text)) {
    return { status: "unsupported", reason: text };
  }
  if (outputLooksLikeShellFailure(output.stdout, output.stderr)) {
    return { status: "failed", reason: text };
  }
  return undefined;
}

/**
 * Run one step: gate on API level, record what it changes BEFORE writing (so a
 * release racing the write still restores it), then write. A write the device
 * refuses changed nothing, so the record it made is dropped again.
 */
async function applyStep(
  context: Context,
  plan: StepPlan,
  apiLevel: number | null,
): Promise<KillProfileStepResult> {
  const base = { step: plan.label, command: plan.command };
  const gated = apiGateReason(plan, apiLevel);
  if (gated) {
    return { ...base, status: "unsupported", reason: gated };
  }
  const registry = context.deps.registry ?? defaultKillProfileRestoreRegistry;
  const action = plan.capture ? await plan.capture() : undefined;
  const recordedNow =
    action !== undefined && registry.record(context.device, action, context.deps.owner);
  let output;
  try {
    output = await run(context, plan.command);
  } catch (error) {
    // The write may still have landed, so the record stays for reset and release.
    throw toActionableError(error, `Failed to run '${plan.command}' on ${context.device.deviceId}`);
  }
  const failure = outputFailure(plan, output);
  if (failure && recordedNow && action) {
    registry.forget(context.device.deviceId, action.key);
  }
  return failure ? { ...base, ...failure } : { ...base, status: "applied" };
}

function appliedCount(steps: readonly KillProfileStepResult[]): number {
  return steps.filter((step) => step.status === "applied").length;
}

function outcomeOf(steps: readonly KillProfileStepResult[]): KillProfileOutcome {
  const applied = appliedCount(steps);
  if (applied === steps.length) {
    return "applied";
  }
  return applied === 0 ? "unsupported" : "partial";
}

function describeSteps(steps: readonly KillProfileStepResult[]): string {
  return steps.map((step) => `${step.step}: ${step.reason ?? step.status}`).join("; ");
}

function assertAndroid(device: BootedDevice): void {
  if (device.platform !== "android") {
    throw new ActionableError(
      `killProfile is Android-only; ${device.deviceId} is ${device.platform}. ` +
        "OEM background-kill behaviour has no iOS equivalent.",
    );
  }
}

async function contextFor(
  device: BootedDevice,
  appId: string,
  deps: KillProfileDependencies,
): Promise<Context> {
  assertAndroid(device);
  const context: Context = { device, appId, quoted: shellQuote(appId), deps };
  const { stdout } = await run(context, `shell pm path ${context.quoted}`);
  if (!stdout.includes("package:")) {
    throw new ActionableError(
      `${appId} is not installed on ${device.deviceId}; nothing was changed.`,
    );
  }
  return context;
}

function restoreReceipt(
  context: Context,
  registry: KillProfileRestoreRegistry,
): KillProfileRestoreReceipt | undefined {
  const commands = registry
    .pendingFor(context.device.deviceId, context.appId)
    .flatMap((action) => (action.command === null ? [] : [action.command]));
  if (commands.length === 0) {
    return undefined;
  }
  return { commands, onSessionRelease: registry.restoresOnRelease(context.device.deviceId) };
}

/**
 * Apply one kill profile to `appId` (#14051). Idempotent: the state found before
 * the first change is recorded once, so applying again rewrites the same
 * restrictions without losing what reset restores.
 */
export async function applyKillProfile(
  device: BootedDevice,
  appId: string,
  profileId: KillProfileId,
  deps: KillProfileDependencies,
): Promise<ApplyKillProfileResult> {
  const context = await contextFor(device, appId, deps);
  const profile = KILL_PROFILES[profileId];
  const apiLevel = await readAndroidDeviceApiLevel(deps.shell, undefined, undefined, deps.signal);
  const steps: KillProfileStepResult[] = [];
  for (const step of profile.steps) {
    steps.push(await applyStep(context, planStep(context, step), apiLevel));
  }
  const applied = appliedCount(steps);
  // Nothing changed and something broke: a failure, not a device that lacks the feature.
  if (applied === 0 && steps.some((step) => step.status === "failed")) {
    throw new ActionableError(
      `killProfile ${profileId} changed nothing on ${device.deviceId}: ${describeSteps(steps)}`,
    );
  }
  const status = outcomeOf(steps);
  const restore = restoreReceipt(context, deps.registry ?? defaultKillProfileRestoreRegistry);
  return {
    message: `Applied ${applied}/${steps.length} steps of ${profileId} v${profile.version} to ${appId} (${status})`,
    deviceId: device.deviceId,
    appId,
    action: "apply",
    profile: {
      id: profile.id,
      version: profile.version,
      evidenceStatus: profile.evidenceStatus,
      evidenceNote: profile.evidenceNote,
      ...(profile.source ? { source: profile.source } : {}),
    },
    status,
    steps,
    ...(restore ? { restore } : {}),
  };
}

/** AOSP defaults reset writes with `baseline: true` when nothing is recorded. */
function baselinePlans(context: Context): StepPlan[] {
  const runAny = appOpCommand(context, "set", "RUN_ANY_IN_BACKGROUND");
  const exactAlarm = appOpCommand(context, "set", "SCHEDULE_EXACT_ALARM");
  return [
    { label: "battery reset", command: "shell dumpsys battery reset" },
    {
      label: "deviceidle unforce",
      command: "shell dumpsys deviceidle unforce",
      minApi: API_DEVICE_IDLE,
    },
    {
      label: "standby bucket active",
      command: `shell am set-standby-bucket ${context.quoted} active`,
      minApi: API_STANDBY_BUCKET,
    },
    {
      label: "appops RUN_ANY_IN_BACKGROUND default",
      command: `${runAny} default`,
      minApi: API_RUN_ANY_IN_BACKGROUND,
    },
    {
      label: "appops SCHEDULE_EXACT_ALARM default",
      command: `${exactAlarm} default`,
      minApi: API_SCHEDULE_EXACT_ALARM,
    },
  ];
}

async function runRestorePlan(
  context: Context,
  plan: StepPlan,
  apiLevel: number | null,
): Promise<KillProfileStepResult> {
  const base = { step: plan.label, command: plan.command };
  const gated = apiGateReason(plan, apiLevel);
  if (gated) {
    return { ...base, status: "unsupported", reason: gated };
  }
  const failure = outputFailure(plan, await run(context, plan.command));
  return failure ? { ...base, ...failure } : { ...base, status: "applied" };
}

async function runPlans(
  context: Context,
  plans: readonly StepPlan[],
  apiLevel: number | null,
): Promise<KillProfileStepResult[]> {
  const steps: KillProfileStepResult[] = [];
  for (const plan of plans) {
    steps.push(await runRestorePlan(context, plan, apiLevel));
  }
  return steps;
}

/** Run each recorded restore command; a facet is forgotten once it is back. */
async function restoreRecorded(
  context: Context,
  registry: KillProfileRestoreRegistry,
  recorded: readonly KillProfileRestoreAction[],
  apiLevel: number | null,
): Promise<KillProfileStepResult[]> {
  const steps: KillProfileStepResult[] = [];
  for (const action of recorded) {
    const step =
      action.command === null
        ? undefined
        : await runRestorePlan(
            context,
            { label: `restore ${action.key}`, command: action.command },
            apiLevel,
          );
    if (step) {
      steps.push(step);
    }
    if (step?.status !== "failed") {
      registry.forget(context.device.deviceId, action.key);
    }
  }
  return steps;
}

/**
 * Restore what kill profiles changed for `appId`, plus the device-wide battery
 * and Doze state (#14051). Idempotent: a restored facet is forgotten, so a second
 * reset finds nothing and changes nothing. With nothing recorded (a daemon
 * restart drops the record), `baseline: true` writes the AOSP defaults instead.
 */
export async function resetKillProfile(
  device: BootedDevice,
  appId: string,
  options: { baseline?: boolean },
  deps: KillProfileDependencies,
): Promise<ResetKillProfileResult> {
  const context = await contextFor(device, appId, deps);
  const registry = deps.registry ?? defaultKillProfileRestoreRegistry;
  const recorded = registry.pendingFor(device.deviceId, appId);
  const base = { deviceId: device.deviceId, appId, action: "reset" as const };
  if (recorded.length === 0 && !options.baseline) {
    return {
      ...base,
      message: `No killProfile change is recorded for ${appId} on ${device.deviceId}; nothing was changed. Pass baseline: true to write the AOSP defaults.`,
      source: "none",
      status: "applied",
      steps: [],
    };
  }
  const apiLevel = await readAndroidDeviceApiLevel(deps.shell, undefined, undefined, deps.signal);
  const steps =
    recorded.length > 0
      ? await restoreRecorded(context, registry, recorded, apiLevel)
      : await runPlans(context, baselinePlans(context), apiLevel);
  const failed = steps.filter((step) => step.status === "failed");
  if (failed.length > 0) {
    // Failed facets stay recorded, so a later reset or the session's release retries them.
    throw new ActionableError(
      `killProfile reset of ${appId} on ${device.deviceId} failed: ${describeSteps(failed)}`,
    );
  }
  const status = steps.length === 0 ? "applied" : outcomeOf(steps);
  const source = recorded.length > 0 ? "recorded" : "baseline";
  return {
    ...base,
    message: `Reset ${appId} on ${device.deviceId} from the ${source} state (${status})`,
    source,
    status,
    steps,
  };
}
