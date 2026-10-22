import { z } from "zod/v4";
import {
  BackgroundWork,
  type BackgroundWorkAdb,
  type BackgroundWorkDependencies,
  type RunJobTarget,
} from "../features/backgroundWork/BackgroundWork";
import type { BootedDevice } from "../models";
import { defaultAdbClientFactory } from "../utils/android-cmdline-tools/AdbClientFactory";
import { ANDROID_PACKAGE_NAME_PATTERN } from "../utils/androidPackageName";
import { createStructuredToolResponse } from "../utils/toolUtils";
import { backgroundWorkResultSchema } from "./backgroundWorkToolOutputSchemas";
import { defineDeviceTool, type DeviceToolSchema } from "./defineTool";
import { PLAN_RELEVANT } from "./toolRegistryTypes";

const JOB_ID_MAX = 2_147_483_647;

const runJobSchema = z
  .object({
    jobId: z.number().int().min(0).max(JOB_ID_MAX).optional().describe("JobScheduler job id"),
    worker: z
      .string()
      .min(1)
      .max(256)
      .optional()
      .describe("WorkManager worker class (or simple name, or tag) to run instead of a jobId"),
    force: z.boolean().optional().describe("Run even if the job's constraints are not satisfied"),
  })
  .strict()
  .refine((job) => (job.jobId === undefined) !== (job.worker === undefined), {
    message: "runJob needs exactly one of jobId or worker",
  });

const backgroundWorkInput = z.object({
  appId: z
    .string()
    .regex(ANDROID_PACKAGE_NAME_PATTERN, "appId must be an Android package name")
    .describe("Package whose background work to read or trigger"),
  action: z
    .union([
      z.literal("list"),
      z.object({ runJob: runJobSchema }).strict(),
      z.object({ workManagerDiagnostics: z.literal(true) }).strict(),
      z.object({ listAlarms: z.literal(true) }).strict(),
    ])
    .describe(
      '"list" the app\'s JobScheduler jobs; {runJob} run one now; {workManagerDiagnostics} map jobs to worker classes; {listAlarms} pending alarms',
    ),
  userId: z.number().int().min(0).optional().describe("Android user to run the job for (runJob)"),
});

export type BackgroundWorkArgs = z.output<DeviceToolSchema<typeof backgroundWorkInput>>;
type BackgroundWorkActionName = "list" | "runJob" | "workManagerDiagnostics" | "listAlarms";

export type BackgroundWorkAdbFactory = (device: BootedDevice) => BackgroundWorkAdb;

const NO_DIAGNOSTICS_NOTE =
  "No diagnostics output: the app may not use WorkManager 2.4+, or has disabled its DiagnosticsReceiver.";
const RUN_JOB_NOTE =
  "Running a job executes the app's own work and changes its state; it cannot be undone.";
const WORKER_CLASS_NOTE =
  "workerClass comes from WorkManager diagnostics already in logcat and can be stale; call workManagerDiagnostics to refresh.";

export function backgroundWorkActionName(
  action: BackgroundWorkArgs["action"],
): BackgroundWorkActionName {
  if (action === "list") {
    return "list";
  }
  if ("runJob" in action) {
    return "runJob";
  }
  return "workManagerDiagnostics" in action ? "workManagerDiagnostics" : "listAlarms";
}

/** `list` and `listAlarms` only read dumpsys; running a job or asking for diagnostics is control. */
export function isBackgroundWorkRead(args: { action?: unknown }): boolean {
  const { action } = args;
  return (
    action === "list" || (typeof action === "object" && action !== null && "listAlarms" in action)
  );
}

function runTarget(job: { jobId?: number; worker?: string }): RunJobTarget {
  return job.jobId === undefined ? { worker: job.worker ?? "" } : { jobId: job.jobId };
}

type Performed =
  | { ok: true; message: string; note?: string; fields: Record<string, unknown> }
  | { ok: false; errorCode: string; error: string; output?: string };

async function perform(
  work: BackgroundWork,
  args: BackgroundWorkArgs,
  signal?: AbortSignal,
): Promise<Performed> {
  const { action } = args;
  if (action === "list") {
    const result = await work.listJobs(args.appId, signal);
    return result.ok
      ? {
          ok: true,
          message: `${result.jobs.length} job(s) registered by ${args.appId}`,
          note: result.jobs.some((job) => job.workerClass) ? WORKER_CLASS_NOTE : undefined,
          fields: { jobs: result.jobs },
        }
      : result;
  }
  if ("runJob" in action) {
    const result = await work.runJob(
      args.appId,
      {
        target: runTarget(action.runJob),
        force: action.runJob.force ?? false,
        userId: args.userId,
      },
      signal,
    );
    if (!result.ok) {
      return result;
    }
    const { ok, ...fields } = result;
    return {
      ok,
      message: `Started job ${result.jobId} of ${args.appId}${result.forced ? " (forced)" : ""}; it runs asynchronously`,
      note: RUN_JOB_NOTE,
      fields,
    };
  }
  if ("workManagerDiagnostics" in action) {
    const result = await work.workManagerDiagnostics(args.appId, signal);
    return result.ok
      ? {
          ok: true,
          message: `${result.workers.length} WorkManager work spec(s) reported by ${args.appId}`,
          note: result.workers.length === 0 ? NO_DIAGNOSTICS_NOTE : undefined,
          fields: { workers: result.workers, output: result.broadcastOutput },
        }
      : result;
  }
  const result = await work.listAlarms(args.appId, signal);
  return result.ok
    ? {
        ok: true,
        message: `${result.alarms.length} pending alarm(s) set by ${args.appId}`,
        fields: { alarms: result.alarms },
      }
    : result;
}

export function createBackgroundWorkHandler(
  adbFor: BackgroundWorkAdbFactory = (device) => defaultAdbClientFactory.create(device),
  dependencies: BackgroundWorkDependencies = {},
) {
  return async (
    device: BootedDevice,
    args: BackgroundWorkArgs,
    _progress?: unknown,
    signal?: AbortSignal,
  ) => {
    const identity = {
      deviceId: device.deviceId,
      appId: args.appId,
      action: backgroundWorkActionName(args.action),
    };
    if (device.platform !== "android") {
      return createStructuredToolResponse({
        message: "backgroundWork is Android-only: iOS has no JobScheduler, WorkManager or alarms.",
        success: false,
        status: "unsupported" as const,
        ...identity,
      });
    }
    signal?.throwIfAborted();
    const outcome = await perform(new BackgroundWork(adbFor(device), dependencies), args, signal);
    if (!outcome.ok) {
      return {
        ...createStructuredToolResponse({
          message: outcome.error,
          success: false,
          status: "failed" as const,
          errorCode: outcome.errorCode,
          error: outcome.error,
          output: outcome.output,
          ...identity,
        }),
        isError: true as const,
      };
    }
    return createStructuredToolResponse({
      message: outcome.message,
      success: true,
      status: "ok" as const,
      note: outcome.note,
      ...outcome.fields,
      ...identity,
    });
  };
}

const backgroundWorkTool = defineDeviceTool({
  name: "backgroundWork",
  description:
    'Android: read and trigger an app\'s background work without waiting hours. action "list" shows JobScheduler jobs (constraints, next run, WorkManager worker class); {runJob:{jobId|worker,force}} runs one now (cmd jobscheduler run); {workManagerDiagnostics:true} maps WorkManager jobs to worker classes; {listAlarms:true} shows pending alarms. Alarms cannot be fired without moving the clock: use setDeviceState clock.',
  input: backgroundWorkInput,
  options: {
    // A plan step: a triggered job changes app state the following steps rely on.
    ...PLAN_RELEVANT,
    defaultEnabled: false,
    // Every action is plain adb (dumpsys / cmd / am broadcast): no CtrlProxy or runner setup.
    deviceReadiness: "booted",
    outputSchema: backgroundWorkResultSchema,
    // list and listAlarms only read dumpsys: a read (#10965). Running a job, or WorkManager
    // diagnostics (a broadcast that starts a worker), is control.
    deviceReadOnly: isBackgroundWorkRead,
  },
});

export const backgroundWorkSchema = backgroundWorkTool.schema;

export function registerBackgroundWorkTools(adbFor?: BackgroundWorkAdbFactory): void {
  backgroundWorkTool.register(undefined, createBackgroundWorkHandler(adbFor));
}
