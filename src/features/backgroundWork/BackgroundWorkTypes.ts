/** Types for `backgroundWork` (#14090): what `dumpsys jobscheduler` / `dumpsys alarm` report. */

export const WORK_MANAGER_JOB_SERVICE = "androidx.work.impl.background.systemjob.SystemJobService";

/** One JobScheduler job registered by the app. Durations are relative to the moment of the dump. */
export interface JobInfo {
  jobId: number;
  userId: number;
  /** Job service component, e.g. `com.example/androidx.work.impl.background.systemjob.SystemJobService`. */
  service: string;
  /** True when WorkManager schedules this job (its service is WorkManager's `SystemJobService`). */
  workManager: boolean;
  /**
   * WorkManager worker class for this job. dumpsys does not expose it, so it comes from the
   * WorkManager diagnostics output (`workManagerDiagnostics`).
   */
  workerClass?: string;
  workerClassSource?: "diagnostics" | "diagnostics-log";
  periodic: boolean;
  intervalMs?: number;
  flexMs?: number;
  requiredConstraints: string[];
  unsatisfiedConstraints: string[];
  networkType?: string;
  /** Milliseconds until the job may first run; negative when already eligible. */
  earliestRunInMs?: number;
  /** Milliseconds until the job's deadline; negative when overdue. */
  latestRunInMs?: number;
  pending?: boolean;
  running?: boolean;
}

export interface JobSchedulerDumpParser {
  /** Jobs registered by `appId` in a `dumpsys jobscheduler` capture. */
  parse(output: string, appId: string): JobInfo[];
}

/** One pending AlarmManager alarm set by the app. */
export interface AlarmInfo {
  packageName: string;
  /** `RTC_WAKEUP`, `RTC`, `ELAPSED_WAKEUP` or `ELAPSED`. */
  alarmType: string;
  wakeup: boolean;
  tag?: string;
  /** Milliseconds until the alarm is due (elapsed-realtime based); negative when overdue. */
  triggerInMs?: number;
  windowMs?: number;
  repeatIntervalMs?: number;
  flags?: number;
  /** The `PendingIntent` or listener that fires. */
  operation?: string;
}

export interface AlarmDumpParser {
  /** Pending alarms set by `appId` in a `dumpsys alarm` capture. */
  parse(output: string, appId: string): AlarmInfo[];
}

/** One WorkManager work spec as the diagnostics worker logs it. */
export interface WorkerInfo {
  workSpecId: string;
  workerClassName: string;
  /** The JobScheduler job id WorkManager registered for the work, when it has one. */
  systemJobId?: number;
  state: string;
  uniqueName?: string;
  tags: string[];
}
