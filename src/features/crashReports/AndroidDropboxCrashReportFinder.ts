import { DUMPSYS_MAX_BUFFER } from "../../utils/android-cmdline-tools/dumpsysLimits";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import {
  ANDROID_CRASH_DROPBOX_TAGS,
  dropboxTagOfReportId,
  parseDropboxCrashReports,
  parseUtcOffsetMinutes,
} from "./androidDropboxCrashReport";
import {
  isFreshCrashReport,
  matchesCrashQuery,
  type NativeCrashReport,
  type NativeCrashReportBody,
  type NativeCrashReportFinder,
  type NativeCrashReportLookup,
  type NativeCrashReportQuery,
  type NativeCrashReportReader,
} from "./NativeCrashReport";

const ADB_COMMAND_TIMEOUT_MS = 5_000;

/**
 * Android records every app crash in the DropBox service without root:
 * `data_app_crash` (Java) and `data_app_native_crash` (tombstone).
 */
export class AndroidDropboxCrashReportFinder
  implements NativeCrashReportFinder, NativeCrashReportReader
{
  constructor(private readonly adb: Pick<AdbExecutor, "executeCommand">) {}

  async find(query: NativeCrashReportQuery): Promise<NativeCrashReportLookup> {
    const utcOffsetMinutes = parseUtcOffsetMinutes(
      (await this.run("shell date +%z", query.signal)) ?? "",
    );
    const reports: NativeCrashReport[] = [];
    for (const tag of ANDROID_CRASH_DROPBOX_TAGS) {
      const output = await this.run(`shell dumpsys dropbox --print ${tag}`, query.signal);
      reports.push(
        ...parseDropboxCrashReports(output ?? "", utcOffsetMinutes).map((parsed) => parsed.report),
      );
    }
    // Without a known device zone a Java entry has no timestamp; then only an exact pid attributes it.
    const match = reports
      .filter(
        (report) =>
          matchesCrashQuery(report, query) &&
          (report.timestampMs !== undefined || query.processId !== undefined) &&
          isFreshCrashReport(report, query.notBeforeTimestampMs),
      )
      .at(-1);
    return match ? { status: "found", report: match } : { status: "notFound" };
  }

  /** The dropbox entry this id names, re-read from the device. */
  async read(reportId: string, signal?: AbortSignal): Promise<NativeCrashReportBody | undefined> {
    const tag = dropboxTagOfReportId(reportId);
    if (!tag) {
      return undefined;
    }
    const output = await this.run(`shell dumpsys dropbox --print ${tag}`, signal);
    const entry = parseDropboxCrashReports(output ?? "").find(
      (parsed) => parsed.report.id === reportId,
    );
    return entry ? { report: entry.report, text: entry.rawText } : undefined;
  }

  private async run(command: string, signal?: AbortSignal): Promise<string | undefined> {
    try {
      return (
        await this.adb.executeCommand(command, {
          timeoutMs: ADB_COMMAND_TIMEOUT_MS,
          maxBuffer: DUMPSYS_MAX_BUFFER,
          noRetry: true,
          signal,
        })
      ).stdout;
    } catch (error) {
      signal?.throwIfAborted();
      logger.warn(`[CrashReports] ${command} failed: ${errorMessage(error)}`, error);
      return undefined;
    }
  }
}
