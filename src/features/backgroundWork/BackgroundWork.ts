import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import { shellQuote } from "../../utils/shellQuote";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import { SendBroadcast } from "../intent/SendBroadcast";
import { AospAlarmDumpParser } from "./AlarmDumpParser";
import {
  type AlarmDumpParser,
  type AlarmInfo,
  type JobInfo,
  type JobSchedulerDumpParser,
  type WorkerInfo,
} from "./BackgroundWorkTypes";
import { parseRunJobOutput, type RunJobErrorCode } from "./RunJobOutput";
import { AospJobSchedulerDumpParser } from "./JobSchedulerDumpParser";
import { parseWorkManagerDiagnostics } from "./WorkManagerDiagnosticsParser";

const DUMP_TIMEOUT_MS = 15_000;
const RUN_TIMEOUT_MS = 15_000;
const LOGCAT_TIMEOUT_MS = 10_000;
const LOGCAT_MAX_BUFFER = 8 * 1024 * 1024;
const DIAGNOSTICS_POLL_MS = 250;
const DIAGNOSTICS_BUDGET_MS = 5_000;
const DIAGNOSTICS_ACTION = "androidx.work.diagnostics.REQUEST_DIAGNOSTICS";
const DIAGNOSTICS_LOGCAT_FILTER = "WM-DiagnosticsWrkr:I DiagnosticsWrkr:I";

export type BackgroundWorkAdb = Pick<
  AdbExecutor,
  "execute" | "executeCommand" | "getDeviceTimestampMs"
>;

export interface BackgroundWorkDependencies {
  timer?: Timer;
  jobParser?: JobSchedulerDumpParser;
  alarmParser?: AlarmDumpParser;
}

export type BackgroundWorkErrorCode =
  | RunJobErrorCode
  | "dump_failed"
  | "diagnostics_failed"
  | "worker_not_found"
  | "ambiguous_worker"
  | "worker_not_scheduled";

export type BackgroundWorkOutcome<T> =
  | ({ ok: true } & T)
  | { ok: false; errorCode: BackgroundWorkErrorCode; error: string; output?: string };

export type RunJobTarget = { jobId: number } | { worker: string };

export interface RunJobRequest {
  target: RunJobTarget;
  force: boolean;
  userId?: number;
}

export interface RunJobSuccess {
  ran: true;
  jobId: number;
  forced: boolean;
  worker?: WorkerInfo;
  output: string;
}

function fail(
  errorCode: BackgroundWorkErrorCode,
  error: string,
  output?: string,
): { ok: false; errorCode: BackgroundWorkErrorCode; error: string; output?: string } {
  return { ok: false, errorCode, error, ...(output === undefined ? {} : { output }) };
}

/** Reads app background work and triggers it now (#14090). The app owns all the state it changes. */
export class BackgroundWork {
  private readonly timer: Timer;
  private readonly jobParser: JobSchedulerDumpParser;
  private readonly alarmParser: AlarmDumpParser;

  constructor(
    private readonly adb: BackgroundWorkAdb,
    dependencies: BackgroundWorkDependencies = {},
  ) {
    this.timer = dependencies.timer ?? defaultTimer;
    this.jobParser = dependencies.jobParser ?? new AospJobSchedulerDumpParser();
    this.alarmParser = dependencies.alarmParser ?? new AospAlarmDumpParser();
  }

  /** Jobs the app registered, with WorkManager worker classes from the last diagnostics output. */
  async listJobs(
    appId: string,
    signal?: AbortSignal,
  ): Promise<BackgroundWorkOutcome<{ jobs: JobInfo[] }>> {
    const dump = await this.dump(`dumpsys jobscheduler ${shellQuote(appId)}`, signal);
    if (!dump.ok) {
      return dump;
    }
    const jobs = this.jobParser.parse(dump.output, appId);
    return {
      ok: true,
      jobs: jobs.some((job) => job.workManager)
        ? await this.withLoggedWorkers(jobs, appId, signal)
        : jobs,
    };
  }

  /** Pending alarms the app set. `dumpsys alarm` has no package filter, so the parser applies it. */
  async listAlarms(
    appId: string,
    signal?: AbortSignal,
  ): Promise<BackgroundWorkOutcome<{ alarms: AlarmInfo[] }>> {
    const dump = await this.dump("dumpsys alarm", signal);
    return dump.ok ? { ok: true, alarms: this.alarmParser.parse(dump.output, appId) } : dump;
  }

  /**
   * Asks WorkManager to log its work specs and reads them back. The broadcast starts a one-time
   * diagnostics worker in the app, so this is a control action.
   */
  async workManagerDiagnostics(
    appId: string,
    signal?: AbortSignal,
  ): Promise<BackgroundWorkOutcome<{ workers: WorkerInfo[]; broadcastOutput: string }>> {
    const since = await this.adb.getDeviceTimestampMs();
    const sent = await new SendBroadcast(this.adb).send(
      { appId, intent: { action: DIAGNOSTICS_ACTION } },
      signal,
    );
    if (!sent.delivered) {
      return fail("diagnostics_failed", sent.error, sent.output);
    }
    const deadline = this.timer.now() + DIAGNOSTICS_BUDGET_MS;
    for (;;) {
      signal?.throwIfAborted();
      const workers = parseWorkManagerDiagnostics(
        (await this.readDiagnosticsLog(since, signal)) ?? "",
      );
      if (workers.length > 0 || this.timer.now() >= deadline) {
        return { ok: true, workers, broadcastOutput: sent.output };
      }
      await this.timer.sleep(DIAGNOSTICS_POLL_MS);
    }
  }

  /** `cmd jobscheduler run`: starts the job now. It returns once the job is started, not finished. */
  async runJob(
    appId: string,
    request: RunJobRequest,
    signal?: AbortSignal,
  ): Promise<BackgroundWorkOutcome<RunJobSuccess>> {
    const resolved = await this.resolveTarget(appId, request.target, signal);
    if (!resolved.ok) {
      return resolved;
    }
    const command = [
      "cmd jobscheduler run",
      ...(request.force ? ["-f"] : []),
      ...(request.userId === undefined ? [] : ["-u", String(request.userId)]),
      shellQuote(appId),
      String(resolved.jobId),
    ].join(" ");
    const output = await this.runCommand(command, RUN_TIMEOUT_MS, signal);
    const parsed = parseRunJobOutput(output);
    if (!parsed.ran) {
      return fail(parsed.errorCode, parsed.error, output);
    }
    return {
      ok: true,
      ran: true,
      jobId: resolved.jobId,
      forced: parsed.forced,
      ...(resolved.worker ? { worker: resolved.worker } : {}),
      output,
    };
  }

  private async resolveTarget(
    appId: string,
    target: RunJobTarget,
    signal?: AbortSignal,
  ): Promise<BackgroundWorkOutcome<{ jobId: number; worker?: WorkerInfo }>> {
    if ("jobId" in target) {
      return { ok: true, jobId: target.jobId };
    }
    const diagnostics = await this.workManagerDiagnostics(appId, signal);
    if (!diagnostics.ok) {
      return diagnostics;
    }
    return selectWorker(diagnostics.workers, target.worker);
  }

  private async withLoggedWorkers(
    jobs: JobInfo[],
    appId: string,
    signal?: AbortSignal,
  ): Promise<JobInfo[]> {
    const logged = parseWorkManagerDiagnostics(
      (await this.readDiagnosticsLog(undefined, signal)) ?? "",
    );
    const byJobId = new Map(
      logged.flatMap((worker) =>
        worker.systemJobId === undefined ? [] : [[worker.systemJobId, worker] as const],
      ),
    );
    logger.debug(`[backgroundWork] ${appId}: ${byJobId.size} logged WorkManager job ids`);
    return jobs.map((job) => {
      const worker = job.workManager ? byJobId.get(job.jobId) : undefined;
      return worker
        ? {
            ...job,
            workerClass: worker.workerClassName,
            workerClassSource: "diagnostics-log" as const,
          }
        : job;
    });
  }

  /** Diagnostics rows in logcat since `sinceMs` (the whole buffer when absent); null if unreadable. */
  private async readDiagnosticsLog(
    sinceMs: number | undefined,
    signal?: AbortSignal,
  ): Promise<string | null> {
    const since =
      sinceMs === undefined
        ? []
        : [
            "-T",
            shellQuote(`${Math.floor(sinceMs / 1000)}.${String(sinceMs % 1000).padStart(3, "0")}`),
          ];
    try {
      const result = await this.adb.executeCommand(
        ["shell logcat -d -v brief", ...since, "-s", DIAGNOSTICS_LOGCAT_FILTER].join(" "),
        { timeoutMs: LOGCAT_TIMEOUT_MS, maxBuffer: LOGCAT_MAX_BUFFER, noRetry: true, signal },
      );
      return result.stdout;
    } catch (error) {
      signal?.throwIfAborted();
      logger.warn(
        `[backgroundWork] reading WorkManager diagnostics from logcat failed: ${errorMessage(error)}`,
        error,
      );
      return null;
    }
  }

  private async dump(
    command: string,
    signal?: AbortSignal,
  ): Promise<BackgroundWorkOutcome<{ output: string }>> {
    try {
      const result = await this.adb.executeCommand(`shell ${command}`, {
        timeoutMs: DUMP_TIMEOUT_MS,
        maxBuffer: LOGCAT_MAX_BUFFER,
        noRetry: true,
        signal,
      });
      return { ok: true, output: result.stdout };
    } catch (error) {
      signal?.throwIfAborted();
      logger.warn(`[backgroundWork] ${command} failed: ${errorMessage(error)}`, error);
      return fail("dump_failed", `${command} failed: ${errorMessage(error)}`);
    }
  }

  /** Stdout and stderr of a shell command, or the thrown message: `cmd` exits non-zero on refusal. */
  private async runCommand(
    command: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<string> {
    try {
      const result = await this.adb.executeCommand(`shell ${command}`, {
        timeoutMs,
        noRetry: true,
        signal,
      });
      return `${result.stdout}\n${result.stderr}`.trim();
    } catch (error) {
      signal?.throwIfAborted();
      // A refused `cmd jobscheduler run` exits non-zero; its message is the diagnosis parsed next.
      logger.warn(`[backgroundWork] ${command} failed: ${errorMessage(error)}`, error);
      return errorMessage(error);
    }
  }
}

/** The single scheduled work spec whose class (or simple class name, or tag) is `worker`. */
function selectWorker(
  workers: readonly WorkerInfo[],
  worker: string,
): BackgroundWorkOutcome<{ jobId: number; worker: WorkerInfo }> {
  const simple = (name: string) => name.slice(name.lastIndexOf(".") + 1);
  const named = workers.filter(
    (candidate) =>
      candidate.workerClassName === worker ||
      simple(candidate.workerClassName) === worker ||
      candidate.tags.includes(worker),
  );
  if (named.length === 0) {
    const known = [...new Set(workers.map((candidate) => candidate.workerClassName))];
    return fail(
      "worker_not_found",
      `No WorkManager work named "${worker}"; known workers: ${known.join(", ") || "none"}`,
    );
  }
  const scheduled = named.filter(
    (candidate): candidate is WorkerInfo & { systemJobId: number } =>
      candidate.systemJobId !== undefined,
  );
  if (scheduled.length === 0) {
    return fail(
      "worker_not_scheduled",
      `"${worker}" has no JobScheduler job (states: ${named.map((candidate) => candidate.state).join(", ")}); WorkManager only registers a job for enqueued work`,
    );
  }
  const jobIds = new Set(scheduled.map((candidate) => candidate.systemJobId));
  if (jobIds.size > 1) {
    return fail(
      "ambiguous_worker",
      `"${worker}" matches ${jobIds.size} jobs (${[...jobIds].join(", ")}); run one by jobId`,
    );
  }
  return { ok: true, jobId: scheduled[0].systemJobId, worker: scheduled[0] };
}
