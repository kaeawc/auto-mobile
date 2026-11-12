import { ActionableError } from "../../models/ActionableError";
import type { NativeCrashReport } from "../crashReports/NativeCrashReport";

export class TvosAppExitError extends ActionableError {
  constructor(
    readonly bundleId: string,
    readonly commandType: string,
    readonly crashReport?: NativeCrashReport,
  ) {
    const summary = crashReport
      ? ` (${[crashReport.exceptionType, crashReport.exceptionMessage, crashReport.terminationReason, `crash report ${crashReport.reportPath}`].filter(Boolean).join("; ")})`
      : "";
    super(`App ${bundleId} exited during ${commandType}${summary}; relaunch it with launchApp.`);
  }
}
