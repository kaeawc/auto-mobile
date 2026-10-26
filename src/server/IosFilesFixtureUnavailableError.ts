import { ActionableError } from "../models";

export type IosFilesFixtureUnavailableReason =
  | "toolchain_unavailable"
  | "build_failed"
  | "install_failed";

/** The managed Files fixture cannot be built or installed on this host or device. */
export class IosFilesFixtureUnavailableError extends ActionableError {
  constructor(
    readonly reason: IosFilesFixtureUnavailableReason,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}
