import { z } from "zod/v4";

const jobInfoSchema = z
  .object({
    jobId: z.number().int(),
    userId: z.number().int(),
    service: z.string(),
    workManager: z.boolean(),
    workerClass: z.string().optional(),
    workerClassSource: z.enum(["diagnostics", "diagnostics-log"]).optional(),
    periodic: z.boolean(),
    intervalMs: z.number().optional(),
    flexMs: z.number().optional(),
    requiredConstraints: z.array(z.string()),
    unsatisfiedConstraints: z.array(z.string()),
    networkType: z.string().optional(),
    earliestRunInMs: z.number().optional(),
    latestRunInMs: z.number().optional(),
    pending: z.boolean().optional(),
    running: z.boolean().optional(),
  })
  .passthrough();

const alarmInfoSchema = z
  .object({
    packageName: z.string(),
    alarmType: z.string(),
    wakeup: z.boolean(),
    tag: z.string().optional(),
    triggerInMs: z.number().optional(),
    windowMs: z.number().optional(),
    repeatIntervalMs: z.number().optional(),
    flags: z.number().optional(),
    operation: z.string().optional(),
  })
  .passthrough();

const workerInfoSchema = z
  .object({
    workSpecId: z.string(),
    workerClassName: z.string(),
    systemJobId: z.number().int().optional(),
    state: z.string(),
    uniqueName: z.string().optional(),
    tags: z.array(z.string()),
  })
  .passthrough();

/** Every backgroundWork outcome; `failed` is returned with `isError`. */
export const backgroundWorkResultSchema = z
  .object({
    message: z.string(),
    success: z.boolean(),
    status: z.enum(["ok", "failed", "unsupported"]),
    deviceId: z.string(),
    appId: z.string(),
    action: z.enum(["list", "runJob", "workManagerDiagnostics", "listAlarms"]),
    jobs: z.array(jobInfoSchema).optional(),
    ran: z.boolean().optional(),
    jobId: z.number().int().optional(),
    forced: z.boolean().optional(),
    worker: workerInfoSchema.optional(),
    workers: z.array(workerInfoSchema).optional(),
    alarms: z.array(alarmInfoSchema).optional(),
    errorCode: z
      .enum([
        "package_not_found",
        "job_not_found",
        "job_not_ready",
        "permission_denied",
        "run_failed",
        "dump_failed",
        "diagnostics_failed",
        "worker_not_found",
        "ambiguous_worker",
        "worker_not_scheduled",
      ])
      .optional(),
    error: z.string().optional(),
    output: z.string().optional(),
    note: z.string().optional(),
  })
  .passthrough();
