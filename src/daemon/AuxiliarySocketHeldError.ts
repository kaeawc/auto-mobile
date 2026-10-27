import { ActionableError } from "../models/ActionableError";

export interface AuxiliarySocketHolder {
  holderPid?: number;
  holderVersion?: string;
  holderVerified: boolean;
}

/** Refusal is diagnostic only: it never authorizes stopping an incumbent. */
export class AuxiliarySocketHeldError extends ActionableError {
  constructor(
    readonly socketPath: string,
    readonly socketName: string,
    readonly holder: AuxiliarySocketHolder,
  ) {
    const owner =
      holder.holderPid === undefined
        ? "an unknown holder (no valid live owner record)"
        : `daemon pid ${holder.holderPid} (version ${holder.holderVersion}; ${holder.holderVerified ? "verified" : "unverified: process generation could not be matched"})`;
    const action = holder.holderVerified
      ? `stop it manually (kill ${holder.holderPid}) or choose a different auxiliary socket directory (AUTOMOBILE_AUX_SOCKET_DIR)`
      : "identify and stop the holder manually after verifying its identity, or choose a different auxiliary socket directory (AUTOMOBILE_AUX_SOCKET_DIR)";
    super(
      `Auxiliary socket ${socketName} at ${socketPath} is held by ${owner}. AutoMobile does not stop an incumbent daemon automatically; ${action}.`,
    );
  }
}
