import { ActionableError } from "../../models";

/**
 * `xcrun`/`simctl` is not installed on this host (ENOENT, no active developer directory, or xcrun
 * cannot find the utility). Distinct from a simctl that exists and failed: discovery reports this
 * one as not applicable rather than incomplete (#11605).
 */
export class SimctlUnavailableError extends ActionableError {}
