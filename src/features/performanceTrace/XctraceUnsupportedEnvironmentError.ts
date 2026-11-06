import { ActionableError } from "../../models/ActionableError";

/** xctrace cannot finalise a trace with this Xcode on this simulator runtime (#16999). */
export class XctraceUnsupportedEnvironmentError extends ActionableError {
  constructor(
    readonly xcodeVersion: string,
    readonly simulatorRuntime: string,
    readonly deviceId: string,
  ) {
    super(
      `performanceTrace cannot record on ${deviceId}: xctrace with Xcode ${xcodeVersion} ` +
        `never finishes saving a trace on an iOS ${simulatorRuntime} simulator, so the trace ` +
        `would hang on stop and contain no data. Run AutoMobile with Xcode 27.x, for example ` +
        `DEVELOPER_DIR=/Applications/Xcode-27.app/Contents/Developer, or trace on a simulator ` +
        `with a different iOS runtime.`,
    );
    this.name = "XctraceUnsupportedEnvironmentError";
  }
}
