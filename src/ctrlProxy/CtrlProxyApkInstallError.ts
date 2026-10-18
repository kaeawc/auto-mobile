import { ActionableError } from "../models";

/** `adb install` failed in a way that an uninstall+reinstall cannot fix (e.g. USER_RESTRICTED). */
export class CtrlProxyApkInstallError extends ActionableError {
  constructor(
    message: string,
    readonly failureCode: string | undefined,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}
