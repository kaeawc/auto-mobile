import { homedir } from "node:os";
import { join } from "node:path";
import { errorMessage } from "../../utils/describeUnknownError";
import { readFileAsync, sortedReaddirEntries, statAsync } from "../../utils/io";
import { logger } from "../../utils/logger";
import { parseIpsCrashReport } from "./iosIpsCrashReport";
import {
  FRESHNESS_SLACK_MS,
  isFreshCrashReport,
  matchesCrashQuery,
  type NativeCrashReportBody,
  type NativeCrashReportFinder,
  type NativeCrashReportLookup,
  type NativeCrashReportQuery,
  type NativeCrashReportReader,
} from "./NativeCrashReport";

/** Newest `.ips` files inspected per lookup, so a full DiagnosticReports folder stays cheap. */
const MAX_IPS_CANDIDATES = 32;
/** `.ips` files are tens of KB; anything far larger is not a crash report worth parsing. */
const MAX_IPS_BYTES = 4 * 1024 * 1024;
/** The host reads an `.ips` lookup needs. */
export interface CrashReportFileSystem {
  readdir(path: string): Promise<Array<{ name: string }>>;
  stat(path: string): Promise<{ size: number; mtime: Date; isFile(): boolean }>;
  readFileBuffer(path: string): Promise<Buffer>;
}

export const nodeCrashReportFileSystem: CrashReportFileSystem = {
  readdir: async (path) => sortedReaddirEntries(path),
  stat: async (path) => statAsync(path),
  readFileBuffer: async (path) => readFileAsync(path),
};

/**
 * iOS Simulator crashes are written by the host's ReportCrash to
 * `~/Library/Logs/DiagnosticReports/*.ips`, shared by every Simulator, so a
 * report is attributed only when its process path names this Simulator's UDID.
 */
export class IosSimulatorCrashReportFinder
  implements NativeCrashReportFinder, NativeCrashReportReader
{
  constructor(
    private readonly deviceId: string,
    private readonly fileSystem: CrashReportFileSystem,
    private readonly reportsDirectory = join(homedir(), "Library", "Logs", "DiagnosticReports"),
  ) {}

  async find(query: NativeCrashReportQuery): Promise<NativeCrashReportLookup> {
    const deviceId = this.deviceId.toUpperCase();
    for (const path of await this.freshCandidates(query.notBeforeTimestampMs)) {
      query.signal?.throwIfAborted();
      const parsed = (await this.readReport(path))?.parsed;
      if (
        parsed?.simulatorDeviceId === deviceId &&
        matchesCrashQuery(parsed.report, query) &&
        isFreshCrashReport(parsed.report, query.notBeforeTimestampMs)
      ) {
        return { status: "found", report: parsed.report };
      }
    }
    return { status: "notFound" };
  }

  /** The `.ips` with this incident id, only if it was written for this Simulator. */
  async read(reportId: string, signal?: AbortSignal): Promise<NativeCrashReportBody | undefined> {
    const deviceId = this.deviceId.toUpperCase();
    for (const path of await this.freshCandidates(0)) {
      signal?.throwIfAborted();
      const read = await this.readReport(path);
      if (read?.parsed?.simulatorDeviceId === deviceId && read.parsed.report.id === reportId) {
        return { report: read.parsed.report, text: read.text };
      }
    }
    return undefined;
  }

  /** `.ips` files modified since the crash, newest first. */
  private async freshCandidates(notBeforeTimestampMs: number): Promise<string[]> {
    let names: string[];
    try {
      names = (await this.fileSystem.readdir(this.reportsDirectory)).map((entry) => entry.name);
    } catch (error) {
      // No DiagnosticReports folder yet means no crash has been reported on this host.
      logger.debug(`[CrashReports] cannot list ${this.reportsDirectory}: ${error}`);
      return [];
    }
    const candidates: Array<{ path: string; mtimeMs: number }> = [];
    for (const name of names.filter((candidate) => candidate.endsWith(".ips"))) {
      const path = join(this.reportsDirectory, name);
      try {
        const stats = await this.fileSystem.stat(path);
        const mtimeMs = stats.mtime.getTime();
        if (
          stats.isFile() &&
          stats.size <= MAX_IPS_BYTES &&
          mtimeMs >= notBeforeTimestampMs - FRESHNESS_SLACK_MS
        ) {
          candidates.push({ path, mtimeMs });
        }
      } catch (error) {
        // A report can be rotated away between listing and stat; it is simply not a candidate.
        logger.debug(`[CrashReports] cannot stat ${path}: ${error}`);
      }
    }
    return candidates
      .sort((left, right) => right.mtimeMs - left.mtimeMs)
      .slice(0, MAX_IPS_CANDIDATES)
      .map((candidate) => candidate.path);
  }

  private async readReport(path: string) {
    try {
      const text = (await this.fileSystem.readFileBuffer(path)).toString("utf8");
      return { text, parsed: parseIpsCrashReport(text, path) };
    } catch (error) {
      logger.warn(`[CrashReports] failed to read ${path}: ${errorMessage(error)}`, error);
      return undefined;
    }
  }
}
